/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "kvm_wifi.h"
#include "ch9329.h"
#include "sdkconfig.h"
#if CONFIG_KVM_MEDIA_WIFI
#include "bootloader_random.h"
#include "esp_event.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "kvm_media.h"
#include "nvs.h"
#include "wifi_settings.h"
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
static SemaphoreHandle_t mutex;
static TaskHandle_t worker;
static wifi_settings_t settings;
static wifi_stage_t stage;
static esp_netif_t *ap_netif;
static atomic_bool stopping;
static bool driver_initialized, pending;
/* State: off, hotspot, joining, connected, error. No passwords in status. */
static uint8_t state, retries, ap_ip[4], sta_ip[4];
static uint16_t reason;
static esp_err_t last_error;
static int64_t join_deadline;
static bool join_expired;
static uint32_t le32(const uint8_t *p)
{
    return p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void random_text(char *out, size_t n)
{
    static const char alphabet[] =
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
    for (size_t i = 0; i < n; i++)
        out[i] = alphabet[esp_random() & 63];
    out[n] = 0;
}
static esp_err_t save(const wifi_settings_t *c)
{
    nvs_handle_t h;
    esp_err_t e = nvs_open("kvm_wifi", NVS_READWRITE, &h);
    if (e != ESP_OK)
        return e;
    e = nvs_set_blob(h, "settings", c, sizeof(*c));
    if (e == ESP_OK)
        e = nvs_commit(h);
    nvs_close(h);
    return e;
}
static void load(void)
{
    nvs_handle_t h;
    size_t n = sizeof(settings);
    esp_err_t e = nvs_open("kvm_wifi", NVS_READONLY, &h);
    if (e == ESP_OK) {
        e = nvs_get_blob(h, "settings", &settings, &n);
        nvs_close(h);
        if (e == ESP_OK && n == sizeof(settings) && wifi_settings_valid(&settings))
            return;
    }
    memset(&settings, 0, sizeof(settings));
    settings.magic = WIFI_SETTINGS_MAGIC;
    settings.recovery = 1;
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(settings.ap_ssid, sizeof(settings.ap_ssid), "cheap-web-kvm-%02X%02X", mac[4], mac[5]);
    if (strlen(CONFIG_KVM_MEDIA_SSID) > 0 && strlen(CONFIG_KVM_MEDIA_SSID) <= 32)
        strlcpy(settings.ap_ssid, CONFIG_KVM_MEDIA_SSID, sizeof(settings.ap_ssid));
    /* Startup precedes Wi-Fi/BLE, so enable the hardware entropy source while
     * generating factory credentials instead of relying on RF-off RNG output. */
    bootloader_random_enable();
    random_text(settings.ap_password, 20);
    random_text(settings.token, 40);
    bootloader_random_disable();
    if (strlen(CONFIG_KVM_MEDIA_PASSWORD) >= 8 && strlen(CONFIG_KVM_MEDIA_PASSWORD) <= 63 &&
        strlen(CONFIG_KVM_MEDIA_TOKEN) >= 16 && strlen(CONFIG_KVM_MEDIA_TOKEN) <= 80) {
        strlcpy(settings.ap_password, CONFIG_KVM_MEDIA_PASSWORD, sizeof(settings.ap_password));
        strlcpy(settings.token, CONFIG_KVM_MEDIA_TOKEN, sizeof(settings.token));
        settings.mode = WIFI_SETTING_AP;
    }
    last_error = save(&settings);
}
static void event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    bool reconnect = false;
    xSemaphoreTake(mutex, portMAX_DELAY);
    if (!atomic_load(&stopping) && settings.mode == WIFI_SETTING_CLIENT) {
        if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
            state = 2;
            reconnect = true;
        } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
            reason = ((wifi_event_sta_disconnected_t *)data)->reason;
            memset(sta_ip, 0, 4);
            if (!join_deadline)
                join_deadline = esp_timer_get_time() + 45000000;
            if (retries < 5 && !join_expired) {
                retries++;
                state = 2;
                reconnect = true;
            } else
                state = 4;
        } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
            ip_event_got_ip_t *got = data;
            uint8_t ip[] = {IP2STR(&got->ip_info.ip)};
            memcpy(sta_ip, ip, 4);
            state = 3;
            reason = 0;
            retries = 0;
            join_deadline = 0;
            join_expired = false;
            last_error = ESP_OK;
        }
    }
    xSemaphoreGive(mutex);
    if (reconnect)
        esp_wifi_connect();
}
static esp_err_t apply(const wifi_settings_t *c)
{
    atomic_store(&stopping, true);
    kvm_media_http_stop();
    if (driver_initialized) {
        esp_wifi_stop();
        esp_wifi_deinit();
        driver_initialized = false;
    }
    xSemaphoreTake(mutex, portMAX_DELAY);
    state = 0;
    join_deadline = 0;
    join_expired = false;
    retries = 0;
    reason = 0;
    memset(ap_ip, 0, 4);
    memset(sta_ip, 0, 4);
    xSemaphoreGive(mutex);
    if (c->mode == WIFI_SETTING_OFF) {
        atomic_store(&stopping, false);
        return ESP_OK;
    }
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    esp_err_t e = esp_wifi_init(&init);
    if (e != ESP_OK)
        return e;
    driver_initialized = true;
    e = esp_wifi_set_storage(WIFI_STORAGE_RAM);
    if (e != ESP_OK)
        return e;
    bool ap = c->mode == WIFI_SETTING_AP || c->recovery;
    e = esp_wifi_set_mode(c->mode == WIFI_SETTING_AP ? WIFI_MODE_AP
                                                     : (ap ? WIFI_MODE_APSTA : WIFI_MODE_STA));
    if (e != ESP_OK)
        return e;
    if (ap) {
        wifi_config_t w = {
            .ap = {.max_connection = 2, .authmode = WIFI_AUTH_WPA2_PSK, .channel = 6}};
        w.ap.ssid_len = strlen(c->ap_ssid);
        memcpy(w.ap.ssid, c->ap_ssid, w.ap.ssid_len);
        strlcpy((char *)w.ap.password, c->ap_password, sizeof(w.ap.password));
        e = esp_wifi_set_config(WIFI_IF_AP, &w);
        if (e != ESP_OK)
            return e;
    }
    if (c->mode == WIFI_SETTING_CLIENT) {
        wifi_config_t w = {0};
        memcpy(w.sta.ssid, c->sta_ssid, strlen(c->sta_ssid));
        strlcpy((char *)w.sta.password, c->sta_password, sizeof(w.sta.password));
        w.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
        e = esp_wifi_set_config(WIFI_IF_STA, &w);
        if (e != ESP_OK)
            return e;
    }
    xSemaphoreTake(mutex, portMAX_DELAY);
    state = c->mode == WIFI_SETTING_AP ? 1 : 2;
    join_deadline = c->mode == WIFI_SETTING_CLIENT ? esp_timer_get_time() + 45000000 : 0;
    xSemaphoreGive(mutex);
    atomic_store(&stopping, false);
    e = esp_wifi_start();
    if (e != ESP_OK)
        return e;
    if (ap) {
        esp_netif_ip_info_t info;
        if (esp_netif_get_ip_info(ap_netif, &info) == ESP_OK) {
            uint8_t ip[] = {IP2STR(&info.ip)};
            xSemaphoreTake(mutex, portMAX_DELAY);
            memcpy(ap_ip, ip, 4);
            xSemaphoreGive(mutex);
        }
    }
    return kvm_media_http_start(c->token);
}
static void run(void *arg)
{
    (void)arg;
    for (;;) {
        if (!ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000))) {
            xSemaphoreTake(mutex, portMAX_DELAY);
            if (state == 2 && join_deadline && esp_timer_get_time() > join_deadline) {
                state = 4;
                join_expired = true;
                last_error = ESP_ERR_TIMEOUT;
            }
            xSemaphoreGive(mutex);
            continue;
        }
        /* Give serial/BLE/HTTP enough time to deliver the save acknowledgement. */
        vTaskDelay(pdMS_TO_TICKS(500));
        xSemaphoreTake(mutex, portMAX_DELAY);
        wifi_settings_t c = settings;
        xSemaphoreGive(mutex);
        esp_err_t e = apply(&c);
        xSemaphoreTake(mutex, portMAX_DELAY);
        last_error = e;
        if (e != ESP_OK)
            state = 4;
        pending = false;
        xSemaphoreGive(mutex);
        kvm_media_network_change_end();
    }
}
esp_err_t kvm_wifi_start(void)
{
    mutex = xSemaphoreCreateMutex();
    if (!mutex)
        return ESP_ERR_NO_MEM;
    load();
    esp_err_t e = esp_netif_init();
    if (e != ESP_OK)
        return e;
    e = esp_event_loop_create_default();
    if (e != ESP_OK && e != ESP_ERR_INVALID_STATE)
        return e;
    ap_netif = esp_netif_create_default_wifi_ap();
    esp_netif_create_default_wifi_sta();
    e = esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, event, NULL);
    if (e != ESP_OK)
        return e;
    e = esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, event, NULL);
    if (e != ESP_OK)
        return e;
    if (xTaskCreate(run, "wifi_settings", 5120, NULL, 3, &worker) != pdPASS)
        return ESP_ERR_NO_MEM;
    pending = true;
    xTaskNotifyGive(worker);
    return ESP_OK;
}
uint8_t kvm_wifi_command(const void *owner, uint8_t cmd, const uint8_t *p, size_t n,
                         uint8_t out[64], uint8_t *out_len)
{
    if (!mutex || !worker)
        return CH9329_ERR_OPERATE;
    if (xSemaphoreTake(mutex, pdMS_TO_TICKS(30)) != pdTRUE)
        return CH9329_ERR_TIMEOUT;
    uint8_t error = 0;
    *out_len = 1;
    out[0] = 0;
    switch (cmd) {
    case KVM_CMD_WIFI_GET:
        if (!n) {
            uint8_t meta[] = {1,
                              1,
                              settings.mode,
                              settings.recovery,
                              !!settings.ap_password[0],
                              !!settings.sta_password[0],
                              !!settings.token[0],
                              pending};
            memcpy(out, meta, sizeof(meta));
            *out_len = sizeof(meta);
        } else if (n == 3 && p[0] == 1 &&
                   (p[1] == WF_AP_SSID || p[1] == WF_STA_SSID || p[1] == WF_AP_PASSWORD ||
                    p[1] == WF_TOKEN)) {
            size_t cap;
            bool string;
            char *value = wifi_setting_field(&settings, p[1], &cap, &string);
            size_t len = strlen(value), offset = p[2];
            if (offset > len)
                error = CH9329_ERR_PARAM;
            else {
                size_t count = len - offset;
                if (count > 60)
                    count = 60;
                out[0] = 1;
                out[1] = p[1];
                out[2] = len;
                out[3] = offset;
                memcpy(out + 4, value + offset, count);
                *out_len = 4 + count;
            }
        } else
            error = CH9329_ERR_PARAM;
        break;
    case KVM_CMD_WIFI_STAGE:
        if (n == 2 && p[0] == 1 && p[1] == 0) {
            if (pending ||
                (stage.id && stage.owner != owner && esp_timer_get_time() <= stage.deadline))
                error = CH9329_ERR_OPERATE;
            else {
                memset(&stage, 0, sizeof(stage));
                stage.value = settings;
                stage.owner = owner;
                stage.id = esp_random();
                if (!stage.id)
                    stage.id = 1;
                stage.deadline = esp_timer_get_time() + WIFI_STAGE_TIMEOUT_US;
                out[0] = 1;
                for (int i = 0; i < 4; i++)
                    out[1 + i] = stage.id >> (8 * i);
                *out_len = 5;
            }
        } else if (!wifi_stage_chunk(&stage, owner, p, n, esp_timer_get_time()))
            error = CH9329_ERR_PARAM;
        break;
    case KVM_CMD_WIFI_APPLY:
        if (n != 5 || p[0] != 1 ||
            !wifi_stage_complete(&stage, owner, le32(p + 1), esp_timer_get_time()))
            error = CH9329_ERR_PARAM;
        else if (pending || !kvm_media_network_change_begin())
            error = CH9329_ERR_OPERATE;
        else {
            esp_err_t e = save(&stage.value);
            if (e != ESP_OK) {
                last_error = e;
                error = CH9329_ERR_OPERATE;
                kvm_media_network_change_end();
            } else {
                settings = stage.value;
                memset(&stage, 0, sizeof(stage));
                pending = true;
                xTaskNotifyGive(worker);
            }
        }
        break;
    case KVM_CMD_WIFI_STATUS:
        if (n)
            error = CH9329_ERR_PARAM;
        else {
            out[0] = 1;
            out[1] = settings.mode;
            out[2] = state;
            out[3] = pending;
            memcpy(out + 4, ap_ip, 4);
            memcpy(out + 8, sta_ip, 4);
            out[12] = retries;
            out[13] = reason;
            out[14] = reason >> 8;
            for (int i = 0; i < 4; i++)
                out[15 + i] = (uint32_t)last_error >> (8 * i);
            *out_len = 19;
        }
        break;
    default:
        error = CH9329_ERR_COMMAND;
    }
    xSemaphoreGive(mutex);
    return error;
}
#else
esp_err_t kvm_wifi_start(void) { return ESP_OK; }
uint8_t kvm_wifi_command(const void *owner, uint8_t cmd, const uint8_t *p, size_t n,
                         uint8_t out[64], uint8_t *out_len)
{
    (void)owner;
    (void)cmd;
    (void)p;
    (void)n;
    (void)out;
    (void)out_len;
    return CH9329_ERR_COMMAND;
}
#endif
