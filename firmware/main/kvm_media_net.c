/* SPDX-License-Identifier: GPL-3.0-or-later
 * Opt-in WPA2 AP. Use the HTTPS helper for secure browser contexts. Only one
 * authenticated WebSocket owns the medium. USB work never calls the network.
 */
#include "kvm_media.h"
#include "kvm_wifi.h"
#include "sdkconfig.h"
#if CONFIG_KVM_MEDIA_WIFI

#include "esp_http_server.h"
#include "esp_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include <stdatomic.h>
#include <string.h>
#include <unistd.h>
static httpd_handle_t server;
static SemaphoreHandle_t net_lock;
static TaskHandle_t pump_task;
static char access_token[81];
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
            strcmp(token, access_token)) {
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
    httpd_handle_t handle = arg;
    size_t n = 0;
    if (kvm_media_poll(tx, &n)) {
        int fd = atomic_load(&owner);
        if (fd >= 0) {
            httpd_ws_frame_t f = {.type = HTTPD_WS_TYPE_BINARY, .payload = tx, .len = n};
            if (httpd_ws_send_frame_async(handle, fd, &f) != ESP_OK)
                httpd_sess_trigger_close(handle, fd);
        } else
            kvm_media_disconnect();
    }
    atomic_store(&queued, false);
}
static void pump(void *arg)
{
    (void)arg;
    for (;;) {
        xSemaphoreTake(net_lock, portMAX_DELAY);
        httpd_handle_t handle = server;
        bool expected = false;
        if (handle && atomic_compare_exchange_strong(&queued, &expected, true)) {
            if (httpd_queue_work(handle, send_work, handle) != ESP_OK)
                atomic_store(&queued, false);
        }
        xSemaphoreGive(net_lock);
        if (!handle) {
            size_t n;
            if (kvm_media_poll(tx, &n))
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
    xSemaphoreGive(net_lock);
    if (old)
        httpd_stop(old);
    atomic_store(&queued, false);
}
esp_err_t kvm_media_http_start(const char *token)
{
    if (!net_lock)
        net_lock = xSemaphoreCreateMutex();
    if (!net_lock)
        return ESP_ERR_NO_MEM;
    strlcpy(access_token, token, sizeof(access_token));
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.close_fn = closed;
    cfg.stack_size = 6144;
    cfg.recv_wait_timeout = 1;
    cfg.send_wait_timeout = 1;
    cfg.max_open_sockets = 3;
    httpd_handle_t handle;
    esp_err_t err = httpd_start(&handle, &cfg);
    if (err != ESP_OK)
        return err;
    httpd_uri_t uri = {.uri = "/media", .method = HTTP_GET, .handler = ws, .is_websocket = true};
    err = httpd_register_uri_handler(handle, &uri);
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
#endif
esp_err_t kvm_media_network_start(void) { return kvm_wifi_start(); }
