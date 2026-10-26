/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "media_protocol.h"
#include <string.h>
static uint64_t get(const uint8_t *p, unsigned n)
{
    uint64_t v = 0;
    for (unsigned i = 0; i < n; i++)
        v |= (uint64_t)p[i] << (8 * i);
    return v;
}
static void put(uint8_t *p, uint64_t v, unsigned n)
{
    for (unsigned i = 0; i < n; i++)
        p[i] = v >> (8 * i);
}
uint32_t media_crc(const uint8_t *p, size_t n, uint32_t crc)
{
    for (size_t i = 0; i < n; i++) {
        crc ^= p[i];
        for (int j = 0; j < 8; j++)
            crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return crc;
}
bool media_decode(const uint8_t *p, size_t n, media_msg_t *m)
{
    if (n < MEDIA_HEADER || n > MEDIA_HEADER + MEDIA_MAX_IO || memcmp(p, "KVM1", 4) ||
        p[4] != MEDIA_VERSION)
        return false;
    uint32_t crc = media_crc(p, 28, 0xffffffff);
    crc = media_crc(p + 32, n - 32, crc) ^ 0xffffffff;
    if (crc != get(p + 28, 4))
        return false;
    *m = (media_msg_t){.op = p[5],
                       .flags = get(p + 6, 2),
                       .session = get(p + 8, 4),
                       .id = get(p + 12, 4),
                       .offset = get(p + 16, 8),
                       .length = get(p + 24, 4)};
    return m->id != 0 && m->length <= MEDIA_MAX_IO;
}
size_t media_encode(uint8_t *p, const media_msg_t *m, const void *payload, size_t n)
{
    if (n > MEDIA_MAX_IO)
        return 0;
    memcpy(p, "KVM1", 4);
    p[4] = MEDIA_VERSION;
    p[5] = m->op;
    put(p + 6, m->flags, 2);
    put(p + 8, m->session, 4);
    put(p + 12, m->id, 4);
    put(p + 16, m->offset, 8);
    put(p + 24, m->length, 4);
    if (n)
        memcpy(p + 32, payload, n);
    uint32_t crc = media_crc(p, 28, 0xffffffff);
    crc = media_crc(p + 32, n, crc) ^ 0xffffffff;
    put(p + 28, crc, 4);
    return 32 + n;
}
bool media_range(uint64_t capacity, uint64_t offset, uint32_t n)
{
    return n > 0 && n <= MEDIA_MAX_IO && offset <= capacity && n <= capacity - offset;
}
