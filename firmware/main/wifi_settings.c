/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "wifi_settings.h"
#include <string.h>
static bool text(const char *p, size_t cap, size_t min, size_t max, bool ascii)
{
    const char *end = memchr(p, 0, cap);
    if (!end)
        return false;
    size_t n = end - p;
    if (n < min || n > max)
        return false;
    for (size_t i = 0; i < n; i++)
        if ((unsigned char)p[i] < 32 || (ascii && (unsigned char)p[i] > 126))
            return false;
    return true;
}
bool wifi_settings_valid(const wifi_settings_t *c)
{
    if (memchr(c->token, ' ', sizeof(c->token)))
        return false;
    if (c->magic != WIFI_SETTINGS_MAGIC || c->mode > WIFI_SETTING_CLIENT || c->recovery > 1)
        return false;
    if (!text(c->ap_ssid, sizeof(c->ap_ssid), 1, 32, false) ||
        !text(c->ap_password, sizeof(c->ap_password), 8, 63, true) ||
        !text(c->token, sizeof(c->token), 16, 80, true))
        return false;
    if (!text(c->sta_ssid, sizeof(c->sta_ssid), c->mode == WIFI_SETTING_CLIENT ? 1 : 0, 32, false))
        return false;
    return text(c->sta_password, sizeof(c->sta_password),
                c->mode == WIFI_SETTING_CLIENT ? 8 : 0, 63, true) &&
           (!c->sta_password[0] || strlen(c->sta_password) >= 8);
}
void *wifi_setting_field(wifi_settings_t *c, uint8_t field, size_t *capacity, bool *string)
{
    *string = true;
    switch (field) {
    case WF_MODE:
        *capacity = 1;
        *string = false;
        return &c->mode;
    case WF_AP_SSID:
        *capacity = sizeof(c->ap_ssid);
        return c->ap_ssid;
    case WF_AP_PASSWORD:
        *capacity = sizeof(c->ap_password);
        return c->ap_password;
    case WF_STA_SSID:
        *capacity = sizeof(c->sta_ssid);
        return c->sta_ssid;
    case WF_STA_PASSWORD:
        *capacity = sizeof(c->sta_password);
        return c->sta_password;
    case WF_TOKEN:
        *capacity = sizeof(c->token);
        return c->token;
    case WF_RECOVERY:
        *capacity = 1;
        *string = false;
        return &c->recovery;
    default:
        return NULL;
    }
}
bool wifi_stage_chunk(wifi_stage_t *s, const void *owner, const uint8_t *p, size_t n, int64_t now)
{
    if (n < 8 || p[0] != 1 || !p[1] || p[1] >= WF_COUNT || !s->id || owner != s->owner ||
        now > s->deadline)
        return false;
    uint32_t id = 0;
    for (int i = 0; i < 4; i++)
        id |= (uint32_t)p[2 + i] << (8 * i);
    uint8_t field = p[1], offset = p[6], total = p[7];
    size_t bytes = n - 8, cap;
    bool string;
    void *dst = wifi_setting_field(&s->value, field, &cap, &string);
    if (id != s->id || !dst || total > (string ? cap - 1 : cap) || (!string && total != 1) ||
        offset > total || bytes > (size_t)(total - offset) || (total && bytes == 0) ||
        (string && memchr(p + 8, 0, bytes)))
        return false;
    if (!offset) {
        memset(dst, 0, cap);
        s->received[field] = 0;
        s->total[field] = total;
        s->touched[field] = true;
    }
    if (!s->touched[field] || s->total[field] != total || offset != s->received[field])
        return false;
    memcpy((uint8_t *)dst + offset, p + 8, bytes);
    s->received[field] += bytes;
    s->deadline = now + WIFI_STAGE_TIMEOUT_US;
    return true;
}
bool wifi_stage_complete(const wifi_stage_t *s, const void *owner, uint32_t id, int64_t now)
{
    if (!id || id != s->id || owner != s->owner || now > s->deadline)
        return false;
    for (int i = 1; i < WF_COUNT; i++)
        if (s->touched[i] && s->received[i] != s->total[i])
            return false;
    return wifi_settings_valid(&s->value);
}
