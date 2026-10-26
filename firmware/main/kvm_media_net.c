/* SPDX-License-Identifier: GPL-3.0-or-later
 * Opt-in WPA2 AP. Use the HTTPS helper for secure browser contexts. Only one
 * authenticated WebSocket owns the medium. USB work never calls the network.
 */
#include "kvm_media.h"
#include "kvm_wifi.h"
#include "kvm_ble.h"
#include "sdkconfig.h"
#if CONFIG_KVM_MEDIA_WIFI

#include "esp_http_server.h"
#include "media_ws.h"
#if CONFIG_KVM_DEVICE_WEB
#include "device_web.h"
#include "device_tls.h"
#include "esp_https_server.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_wifi.h"
#endif
#include "esp_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include <errno.h>
#include <inttypes.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
static httpd_handle_t server;
#if CONFIG_KVM_DEVICE_WEB
static httpd_handle_t secure_server;
static uint8_t certificate_ips[8];
static atomic_int tls_last_error, tls_code, tls_flags;
static bool tls_events_registered;
static void tls_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)base; (void)id;
    const esp_https_server_last_error_t *error = data;
    if (error) {
        atomic_store(&tls_last_error, error->last_error);
        atomic_store(&tls_code, error->esp_tls_error_code);
        atomic_store(&tls_flags, error->esp_tls_flags);
    }
}
static esp_err_t diagnostics(httpd_req_t *req)
{
    media_metrics_t metrics;
    if (!kvm_media_metrics(&metrics)) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_sendstr(req, "Media diagnostics busy");
    }
    wifi_ps_type_t power_save;
    wifi_mode_t mode;
    int wifi_power_save = esp_wifi_get_ps(&power_save) == ESP_OK ? (int)power_save : -1;
    int wifi_mode = esp_wifi_get_mode(&mode) == ESP_OK ? (int)mode : -1;
    wifi_ap_record_t ap;
    int wifi_rssi = -127;
    unsigned wifi_channel = 0;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        wifi_rssi = ap.rssi;
        wifi_channel = ap.primary;
    }
    char body[512];
    int n = snprintf(body, sizeof(body), "{\"freeHeap\":%u,\"minimumHeap\":%u,\"largestBlock\":%u,\"tlsError\":%d,\"tlsCode\":%d,\"tlsFlags\":%d,\"bleAdvertising\":%s,\"bleAdvertisingPauseRequested\":%s,"
        "\"wifiPowerSave\":%d,\"wifiMode\":%d,\"wifiRssi\":%d,\"wifiChannel\":%u,"
        "\"media\":{\"reads\":%" PRIu32 ",\"readBytes\":%" PRIu64 ",\"readTimeUs\":%" PRIu64 ",\"readMaxUs\":%" PRIu64 ",\"cacheBytes\":%" PRIu64 "}}",
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT), (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT), atomic_load(&tls_last_error), atomic_load(&tls_code), atomic_load(&tls_flags),
        kvm_ble_advertising_active() ? "true" : "false",
        kvm_ble_advertising_pause_requested() ? "true" : "false",
        wifi_power_save, wifi_mode, wifi_rssi, wifi_channel,
        metrics.reads, metrics.read_bytes, metrics.read_time_us, metrics.read_max_us, metrics.cache_bytes);
    if (n < 0 || (size_t)n >= sizeof(body))
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Diagnostics unavailable");
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "Connection", "close");
    return httpd_resp_sendstr(req, body);
}
#endif
static SemaphoreHandle_t net_lock;
static TaskHandle_t pump_task;
static char access_token[81];
static atomic_int owner = -1;
static _Atomic(httpd_handle_t) owner_server;
static uint8_t rx[MEDIA_HEADER + MEDIA_MAX_IO];
static uint8_t reply[MEDIA_WS_PREFIX + MEDIA_WS_MAX_PAYLOAD];
static uint8_t tx[MEDIA_WS_PREFIX + MEDIA_WS_MAX_PAYLOAD];
typedef struct {
    httpd_handle_t server;
    int fd;
} media_socket_t;
static int socket_send(void *context, const uint8_t *data, size_t length)
{
    media_socket_t *socket = context;
    /* Public socket API preserves the session's HTTPS send override. */
    return httpd_socket_send(socket->server, socket->fd, (const char *)data, length, 0);
}
static esp_err_t send_binary(httpd_handle_t handle, int fd, uint8_t *buffer, size_t length)
{
    media_socket_t socket = {.server = handle, .fd = fd};
    /* Keep the WebSocket header with its payload in the same TLS write. */
    return media_ws_send_binary(buffer, length, socket_send, &socket) ? ESP_OK : ESP_FAIL;
}
static void closed(httpd_handle_t h, int fd)
{
    xSemaphoreTake(net_lock, portMAX_DELAY);
    if (atomic_load(&owner) == fd && atomic_load(&owner_server) == h) {
        // The other HTTP task cannot claim a replacement until teardown ends.
        kvm_media_disconnect();
        atomic_store(&owner_server, NULL);
        atomic_store(&owner, -1);
    }
    xSemaphoreGive(net_lock);
    /* Custom close_fn replaces the default close. */
    close(fd);
}
static esp_err_t ws(httpd_req_t *req)
{
    if (req->method == HTTP_GET) {
        bool authorized;
#if CONFIG_KVM_DEVICE_WEB
        authorized = device_web_authorized(req, req->user_ctx != NULL);
#else
        char token[96];
        authorized = httpd_req_get_hdr_value_str(req, "X-KVM-Token", token, sizeof(token)) == ESP_OK &&
                     !strcmp(token, access_token);
#endif
        if (!authorized) {
            httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Use the authenticated HTTPS helper");
            return ESP_FAIL;
        }
        int fd = httpd_req_to_sockfd(req);
        /* Send small read requests immediately instead of waiting for an ACK. */
        int nodelay = 1;
        if (setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay)) != 0) {
            ESP_LOGE("media_net", "Cannot configure TCP_NODELAY: errno %d", errno);
            return ESP_FAIL; /* Close this socket without claiming the medium. */
        }
        xSemaphoreTake(net_lock, portMAX_DELAY);
        if (atomic_load(&owner) >= 0) {
            xSemaphoreGive(net_lock);
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Media already owned");
            return ESP_FAIL;
        }
        atomic_store(&owner_server, req->handle);
        atomic_store(&owner, fd);
        xSemaphoreGive(net_lock);
        return ESP_OK;
    }
    if (httpd_req_to_sockfd(req) != atomic_load(&owner))
        return ESP_FAIL;
    httpd_ws_frame_t frame = {0};
    esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
    if (err != ESP_OK)
        return err;
    if (frame.type != HTTPD_WS_TYPE_BINARY || !frame.final || frame.len > sizeof(rx))
        return ESP_FAIL;
    frame.payload = rx;
    err = httpd_ws_recv_frame(req, &frame, sizeof(rx));
    if (err != ESP_OK)
        return err;
    size_t n = kvm_media_command(rx, frame.len, reply + MEDIA_WS_PREFIX);
    if (!n)
        return ESP_OK;
    return send_binary(req->handle, httpd_req_to_sockfd(req), reply, n);
}
/* Send from the HTTP task too: serializes control replies and USB requests on
 * the socket. A single outstanding work item bounds buffering when Wi-Fi stalls. */
static atomic_bool queued;
static void send_work(void *arg)
{
    httpd_handle_t handle = arg;
    size_t n = 0;
    xSemaphoreTake(net_lock, portMAX_DELAY);
    if (atomic_load(&owner) < 0 || atomic_load(&owner_server) != handle) {
        atomic_store(&queued, false);
        xSemaphoreGive(net_lock);
        return;
    }
    if (kvm_media_poll(tx + MEDIA_WS_PREFIX, &n)) {
        int fd = atomic_load(&owner);
        if (fd >= 0) {
            if (send_binary(handle, fd, tx, n) != ESP_OK)
                httpd_sess_trigger_close(handle, fd);
        } else
            kvm_media_disconnect();
    }
    atomic_store(&queued, false);
    xSemaphoreGive(net_lock);
}
static void pump(void *arg)
{
    (void)arg;
    for (;;) {
        xSemaphoreTake(net_lock, portMAX_DELAY);
        httpd_handle_t handle = server;
        if (atomic_load(&owner) >= 0) handle = atomic_load(&owner_server);
        bool expected = false;
        if (handle && atomic_compare_exchange_strong(&queued, &expected, true)) {
            if (httpd_queue_work(handle, send_work, handle) != ESP_OK)
                atomic_store(&queued, false);
        }
        xSemaphoreGive(net_lock);
        if (!handle) {
            size_t n;
            if (kvm_media_poll(tx + MEDIA_WS_PREFIX, &n))
                kvm_media_disconnect();
        }
        vTaskDelay(pdMS_TO_TICKS(2));
    }
}
void kvm_media_http_stop(void)
{
    if (!net_lock)
        return;
    xSemaphoreTake(net_lock, portMAX_DELAY);
    httpd_handle_t old = server;
    server = NULL;
#if CONFIG_KVM_DEVICE_WEB
    httpd_handle_t old_secure = secure_server;
    secure_server = NULL;
#endif
    xSemaphoreGive(net_lock);
    if (old)
        httpd_stop(old);
#if CONFIG_KVM_DEVICE_WEB
    if (old_secure) httpd_ssl_stop(old_secure);
#endif
    atomic_store(&queued, false);
}
esp_err_t kvm_media_http_start(const char *token)
{
    if (!net_lock)
        net_lock = xSemaphoreCreateMutex();
    if (!net_lock)
        return ESP_ERR_NO_MEM;
    strlcpy(access_token, token, sizeof(access_token));
#if CONFIG_KVM_DEVICE_WEB
    (void)device_tls_hostname(); // Publish the stable name before HTTP tasks exist.
    device_web_reset_sessions(token);
#endif
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.close_fn = closed;
    cfg.stack_size = 6144;
    cfg.recv_wait_timeout = 1;
    cfg.send_wait_timeout = 1;
    cfg.max_open_sockets = 3;
    cfg.max_uri_handlers = 8;
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    httpd_handle_t handle;
    esp_err_t err = httpd_start(&handle, &cfg);
    if (err != ESP_OK)
        return err;
    httpd_uri_t uri = {.uri = "/media", .method = HTTP_GET, .handler = ws, .is_websocket = true};
    err = httpd_register_uri_handler(handle, &uri);
#if CONFIG_KVM_DEVICE_WEB
    if (!tls_events_registered) {
        err = esp_event_handler_register(ESP_HTTPS_SERVER_EVENT, HTTPS_SERVER_EVENT_ERROR, tls_event, NULL);
        if (err == ESP_OK) tls_events_registered = true;
    }
    httpd_uri_t diag = {.uri="/device/diagnostics", .method=HTTP_GET, .handler=diagnostics};
    if (err == ESP_OK) err = httpd_register_uri_handler(handle, &diag);
    if (err == ESP_OK) err = device_web_register(handle, false);
#endif
    if (err != ESP_OK) {
        httpd_stop(handle);
        return err;
    }
    xSemaphoreTake(net_lock, portMAX_DELAY);
    server = handle;
    xSemaphoreGive(net_lock);
    if (!pump_task && xTaskCreate(pump, "media_net", 3072, NULL, 3, &pump_task) != pdPASS) {
        kvm_media_http_stop();
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
esp_err_t kvm_media_https_ensure(const uint8_t client_ip[4], const uint8_t ap_ip[4])
{
#if CONFIG_KVM_DEVICE_WEB
    // A mismatched RAM build must retain basic control and certificate setup.
    if (!heap_caps_get_total_size(MALLOC_CAP_SPIRAM)) return ESP_ERR_NO_MEM;
    uint8_t ips[8]; memcpy(ips, client_ip, 4); memcpy(ips + 4, ap_ip, 4);
    if (secure_server && !memcmp(ips, certificate_ips, sizeof(ips)) && !device_tls_needs_renewal()) return ESP_OK;
    // Certificate replacement must never tear down an inserted virtual disk.
    if (!kvm_media_network_change_begin()) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(net_lock, portMAX_DELAY);
    httpd_handle_t old = secure_server; secure_server = NULL;
    xSemaphoreGive(net_lock);
    if (old) httpd_ssl_stop(old);
    esp_err_t err = device_tls_prepare(client_ip, ap_ip);
    if (err == ESP_OK) {
        httpd_ssl_config_t cfg = HTTPD_SSL_CONFIG_DEFAULT();
        // Six browser resource connections plus the persistent media socket.
        cfg.httpd.max_open_sockets = 7;
        cfg.httpd.lru_purge_enable = false;
        cfg.httpd.max_uri_handlers = 8;
        cfg.httpd.uri_match_fn = httpd_uri_match_wildcard;
        cfg.httpd.close_fn = closed;
        cfg.httpd.recv_wait_timeout = 2;
        cfg.httpd.send_wait_timeout = 2;
        cfg.servercert = (const uint8_t *)device_tls_certificate();
        cfg.servercert_len = strlen(device_tls_certificate()) + 1;
        cfg.prvtkey_pem = (const uint8_t *)device_tls_private_key();
        cfg.prvtkey_len = strlen(device_tls_private_key()) + 1;
        httpd_handle_t handle;
        err = httpd_ssl_start(&handle, &cfg);
        if (err == ESP_OK) {
            httpd_uri_t uri = {.uri="/media", .method=HTTP_GET, .handler=ws, .is_websocket=true, .user_ctx=(void *)1};
            err = httpd_register_uri_handler(handle, &uri);
            httpd_uri_t diag = {.uri="/device/diagnostics", .method=HTTP_GET, .handler=diagnostics};
            if (err == ESP_OK) err = httpd_register_uri_handler(handle, &diag);
            if (err == ESP_OK) err = device_web_register(handle, true);
            if (err != ESP_OK) httpd_ssl_stop(handle);
            else {
                xSemaphoreTake(net_lock, portMAX_DELAY);
                secure_server = handle;
                memcpy(certificate_ips, ips, sizeof(ips));
                xSemaphoreGive(net_lock);
            }
        }
    }
    kvm_media_network_change_end();
    return err;
#else
    (void)client_ip; (void)ap_ip;
    return ESP_OK;
#endif
}
#endif
esp_err_t kvm_media_network_start(void) { return kvm_wifi_start(); }
