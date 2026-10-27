/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "media_serial.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static unsigned received, releases, ch;
static uint8_t got[MEDIA_HEADER + MEDIA_SERIAL_MAX_IO];
static size_t got_len;
static void receive(bool media, const uint8_t *p, size_t n)
{
    if (media) {
        if (!n)
            releases++;
        else {
            received++;
            memcpy(got, p, n);
            got_len = n;
        }
    } else {
        ch++;
        assert(n == 12 && !memcmp(p + 5, "KVS1", 4));
    }
}
static void feed(media_serial_parser_t *p, const void *v, size_t n, int64_t now)
{
    const uint8_t *b = v;
    for (size_t i = 0; i < n; i++)
        media_serial_feed(p, b[i], now + i);
}
int main(void)
{
    media_serial_parser_t parser;
    media_serial_init(&parser, receive);
    uint8_t packet[MEDIA_HEADER + MEDIA_SERIAL_MAX_IO + 6] = {'K', 'V', 'S', '1', 0x20, 0x20};
    memset(packet + 6, 0x57, sizeof(packet) - 6);
    memcpy(packet + 12, "KVS1", 4);
    feed(&parser, packet, sizeof(packet), 0);
    assert(received == 1 && got_len == MEDIA_HEADER + MEDIA_SERIAL_MAX_IO);
    assert(!memcmp(got, packet + 6, got_len));
    const uint8_t hid[] = {0x57, 0xab, 0, 2, 6, 'K', 'V', 'S', '1', 0, 0, 0};
    feed(&parser, hid, sizeof(hid), 10000);
    assert(ch == 1 && received == 1);
    const uint8_t release[] = {'K', 'V', 'S', '1', 0, 0};
    feed(&parser, release, sizeof(release), 20000);
    assert(releases == 1);
    feed(&parser, packet, 20, 30000);
    feed(&parser, hid, sizeof(hid), MEDIA_SERIAL_TIMEOUT_US + 30001);
    assert(ch == 2 && received == 1);
    /* Invalid prefix, oversized/short lengths and noise recover at a new header. */
    const uint8_t noise[] = {0x57, 'K', 'K', 'V', 'S', '1', 0xff, 0xff,
                            'K', 'V', 'S', '1', 1, 0, 0x20};
    feed(&parser, noise, sizeof(noise), 3000000);
    feed(&parser, release, sizeof(release), 4000000);
    assert(releases == 2);
    puts("PASS: serial media framing, full-size fragmented payload, embedded magic, HID multiplexing, release and timeout recovery");
}
