/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "media_serial.h"
#include <string.h>
static void reset(media_serial_parser_t *p)
{
    p->kind = p->prefix = 0;
    p->used = p->expected = 0;
}
void media_serial_init(media_serial_parser_t *p, media_serial_receive_t receive)
{
    memset(p, 0, sizeof(*p));
    p->receive = receive;
}
void media_serial_feed(media_serial_parser_t *p, uint8_t b, int64_t now)
{
    static const uint8_t magic[] = {'K', 'V', 'S', '1'};
    if (p->kind && now - p->started > MEDIA_SERIAL_TIMEOUT_US)
        reset(p);
    if (!p->kind) {
        if (b == 0x57) {
            p->kind = 1;
            p->data[p->used++] = b;
        } else if (b == magic[0]) {
            p->kind = 2;
            p->prefix = 1;
        }
        p->started = now;
        return;
    }
    if (p->kind == 1) {
        if (p->used == 1 && b != 0xab) {
            reset(p);
            media_serial_feed(p, b, now);
            return;
        }
        p->data[p->used++] = b;
        if (p->used == 5) {
            if (b > 64) {
                /* Preserve CH9329's parameter-error reply for an invalid length. */
                p->receive(false, p->data, p->used);
                reset(p);
                return;
            }
            p->expected = (size_t)b + 6;
        }
        if (p->expected && p->used == p->expected) {
            p->receive(false, p->data, p->used);
            reset(p);
        }
        return;
    }
    if (p->prefix < 4) {
        if (b == magic[p->prefix])
            p->prefix++;
        else {
            reset(p);
            media_serial_feed(p, b, now);
        }
        return;
    }
    if (p->prefix == 4) {
        p->size_low = b;
        p->prefix++;
        return;
    }
    if (p->prefix == 5) {
        p->expected = p->size_low | (size_t)b << 8;
        p->prefix++;
        if (!p->expected) {
            p->receive(true, NULL, 0);
            reset(p);
        } else if (p->expected < MEDIA_HEADER || p->expected > sizeof(p->data))
            reset(p);
        return;
    }
    p->data[p->used++] = b;
    if (p->used == p->expected) {
        p->receive(true, p->data, p->used);
        reset(p);
    }
}
