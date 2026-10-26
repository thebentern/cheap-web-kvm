/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define WIFI_SETTINGS_MAGIC 0x4b574631
#define WIFI_SETTINGS_VERSION 1
#define WIFI_STAGE_TIMEOUT_US 30000000LL
enum { WIFI_SETTING_OFF, WIFI_SETTING_AP, WIFI_SETTING_CLIENT };
enum {
    WF_MODE = 1,
    WF_AP_SSID,
    WF_AP_PASSWORD,
    WF_STA_SSID,
    WF_STA_PASSWORD,
    WF_TOKEN,
    WF_RECOVERY,
    WF_COUNT
};
typedef struct {
    uint32_t magic;
    uint8_t mode, recovery;
    char ap_ssid[33], ap_password[64], sta_ssid[33], sta_password[64], token[81];
} wifi_settings_t;
typedef struct {
    wifi_settings_t value;
    const void *owner;
    uint32_t id;
    int64_t deadline;
    uint8_t total[WF_COUNT], received[WF_COUNT];
    bool touched[WF_COUNT];
} wifi_stage_t;
bool wifi_settings_valid(const wifi_settings_t *c);
void *wifi_setting_field(wifi_settings_t *c, uint8_t field, size_t *capacity, bool *string);
bool wifi_stage_chunk(wifi_stage_t *s, const void *owner, const uint8_t *data, size_t len,
                      int64_t now);
bool wifi_stage_complete(const wifi_stage_t *s, const void *owner, uint32_t id, int64_t now);
