/* SPDX-License-Identifier: GPL-3.0-or-later
 * Opt-in WPA2 AP. Use the HTTPS helper for secure browser contexts. Only one
 * authenticated WebSocket owns the medium. USB work never calls the network.
 */
#include "kvm_media.h"
#include "sdkconfig.h"
#if CONFIG_KVM_MEDIA_WIFI
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdatomic.h>
#include <string.h>
#include <unistd.h>
static httpd_handle_t server;
static atomic_int owner = -1;
static uint8_t rx[MEDIA_HEADER + MEDIA_MAX_IO], reply[MEDIA_HEADER + MEDIA_MAX_IO];
static uint8_t tx[MEDIA_HEADER + MEDIA_MAX_IO];
static void closed(httpd_handle_t h, int fd)
{
    (void)h;
    int expected = fd;
    if (atomic_compare_exchange_strong(&owner, &expected, -1))
        kvm_media_disconnect();
    /* Custom close_fn replaces the default close. */
    close(fd);
}
static esp_err_t ws(httpd_req_t *req)
{
    if (req->method == HTTP_GET) {
        char token[96];
        if (httpd_req_get_hdr_value_str(req, "X-KVM-Token", token, sizeof(token)) != ESP_OK ||
            strcmp(token, CONFIG_KVM_MEDIA_TOKEN)) {
            httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Use the authenticated HTTPS helper");
            return ESP_FAIL;
        }
        int fd = httpd_req_to_sockfd(req), expected = -1;
        if (!atomic_compare_exchange_strong(&owner, &expected, fd)) {
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Media already owned");
            return ESP_FAIL;
        }
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
    size_t n = kvm_media_command(rx, frame.len, reply);
    if (!n)
        return ESP_OK;
    httpd_ws_frame_t response = {.type = HTTPD_WS_TYPE_BINARY, .payload = reply, .len = n};
    return httpd_ws_send_frame(req, &response);
}
/* Send from the HTTP task too: serializes control replies and USB requests on
 * the socket. A single outstanding work item bounds buffering when Wi-Fi stalls. */
static atomic_bool queued;
static void send_work(void *arg)
{
    (void)arg;
    size_t n = 0;
    if (kvm_media_poll(tx, &n)) {
        int fd = atomic_load(&owner);
        if (fd >= 0) {
            httpd_ws_frame_t f = {.type = HTTPD_WS_TYPE_BINARY, .payload = tx, .len = n};
            if (httpd_ws_send_frame_async(server, fd, &f) != ESP_OK)
                httpd_sess_trigger_close(server, fd);
        } else
            kvm_media_disconnect();
    }
    atomic_store(&queued, false);
}
static void pump(void *arg)
{
    (void)arg;
    for (;;) {
        bool expected = false;
        if (atomic_compare_exchange_strong(&queued, &expected, true)) {
            if (httpd_queue_work(server, send_work, NULL) != ESP_OK)
                atomic_store(&queued, false);
        }
        vTaskDelay(pdMS_TO_TICKS(2));
    }
}
esp_err_t kvm_media_network_start(void)
{
    if (strlen(CONFIG_KVM_MEDIA_PASSWORD) < 8 || strlen(CONFIG_KVM_MEDIA_PASSWORD) > 63 ||
        strlen(CONFIG_KVM_MEDIA_TOKEN) < 16 || strlen(CONFIG_KVM_MEDIA_TOKEN) > 80 ||
        !strlen(CONFIG_KVM_MEDIA_SSID) || strlen(CONFIG_KVM_MEDIA_SSID) > 31) {
        ESP_LOGE("media",
                 "Wi-Fi disabled: configure SSID (1-31), AP password (8-63), and token (16-80)");
        return ESP_OK;
    }
    ESP_ERROR_CHECK(esp_netif_init());
    esp_err_t e = esp_event_loop_create_default();
    if (e != ESP_OK && e != ESP_ERR_INVALID_STATE)
        return e;
    esp_netif_create_default_wifi_ap();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    wifi_config_t wifi = {
        .ap = {.max_connection = 2, .authmode = WIFI_AUTH_WPA2_PSK, .channel = 6}};
    strlcpy((char *)wifi.ap.ssid, CONFIG_KVM_MEDIA_SSID, sizeof(wifi.ap.ssid));
    strlcpy((char *)wifi.ap.password, CONFIG_KVM_MEDIA_PASSWORD, sizeof(wifi.ap.password));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &wifi));
    ESP_ERROR_CHECK(esp_wifi_start());
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.close_fn = closed;
    cfg.stack_size = 6144;
    cfg.recv_wait_timeout = 1;
    cfg.send_wait_timeout = 1;
    cfg.max_open_sockets = 3;
    ESP_ERROR_CHECK(httpd_start(&server, &cfg));
    httpd_uri_t uri = {.uri = "/media", .method = HTTP_GET, .handler = ws, .is_websocket = true};
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &uri));
    return xTaskCreate(pump, "media_net", 3072, NULL, 3, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
#else
esp_err_t kvm_media_network_start(void) { return ESP_OK; }
#endif
