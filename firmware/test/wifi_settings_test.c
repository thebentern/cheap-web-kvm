/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "wifi_settings.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static wifi_settings_t config(void)
{
    wifi_settings_t c = {.magic = WIFI_SETTINGS_MAGIC, .mode = WIFI_SETTING_CLIENT, .recovery = 1};
    strcpy(c.ap_ssid, "Recovery");
    strcpy(c.ap_password, "safe-password");
    strcpy(c.sta_ssid, "Router");
    strcpy(c.sta_password, "router-password");
    strcpy(c.token, "0123456789abcdef0123456789abcdef");
    return c;
}
int main(void)
{
    wifi_settings_t c = config();
    assert(wifi_settings_valid(&c));
    memset(c.sta_ssid, 'a', 32);
    c.sta_ssid[32] = 0;
    assert(wifi_settings_valid(&c));
    c.sta_password[0] = 0;
    assert(!wifi_settings_valid(&c));
    c.mode = WIFI_SETTING_AP;
    assert(wifi_settings_valid(&c));
    c.mode = WIFI_SETTING_CLIENT;
    strcpy(c.sta_password, "short");
    assert(!wifi_settings_valid(&c));
    c = config();
    memset(c.ap_ssid, 'x', sizeof(c.ap_ssid));
    assert(!wifi_settings_valid(&c));
    c = config();
    c.mode = 3;
    assert(!wifi_settings_valid(&c));
    c = config();
    c.recovery = 2;
    assert(!wifi_settings_valid(&c));
    wifi_stage_t s = {.value = config(), .owner = (void *)1, .id = 0x12345678, .deadline = 100};
    uint8_t p[64] = {1, WF_STA_PASSWORD, 0x78, 0x56, 0x34, 0x12, 0, 63};
    memset(p + 8, 'p', 56);
    assert(!wifi_stage_chunk(&s, (void *)2, p, sizeof(p), 0));
    assert(!s.touched[WF_STA_PASSWORD]);
    assert(wifi_stage_chunk(&s, (void *)1, p, sizeof(p), 0));
    assert(!wifi_stage_complete(&s, (void *)1, s.id, 1));
    p[6] = 55;
    assert(!wifi_stage_chunk(&s, (void *)1, p, 15, 1));
    p[6] = 56;
    assert(wifi_stage_chunk(&s, (void *)1, p, 15, 1));
    assert(strlen(s.value.sta_password) == 63);
    assert(wifi_stage_complete(&s, (void *)1, s.id, 2));
    assert(!wifi_stage_complete(&s, (void *)2, s.id, 2));
    assert(!wifi_stage_complete(&s, (void *)1, s.id + 1, 2));
    assert(!wifi_stage_complete(&s, (void *)1, s.id, 30000002));
    p[6] = 0;
    p[7] = 0;
    assert(wifi_stage_chunk(&s, (void *)1, p, 8, 2));
    assert(s.value.sta_password[0] == 0);
    assert(!wifi_stage_complete(&s, (void *)1, s.id, 3));
    p[1] = WF_TOKEN;
    p[7] = 81;
    assert(!wifi_stage_chunk(&s, (void *)1, p, 8, 3));
    p[1] = WF_STA_SSID;
    p[7] = 5;
    p[8] = 0;
    assert(!wifi_stage_chunk(&s, (void *)1, p, 13, 3));
    p[1] = WF_RECOVERY;
    p[7] = 2;
    assert(!wifi_stage_chunk(&s, (void *)1, p, 10, 3));
    puts("PASS: Wi-Fi modes, open-client rejection, recovery settings, bounds, fragmented credentials, "
         "owner/transaction isolation, timeout and incomplete-stage rejection");
}
