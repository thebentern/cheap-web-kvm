/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "media_protocol.h"
#define MEDIA_SERIAL_HEADER 6
#define MEDIA_SERIAL_TIMEOUT_US 2000000LL
/* KVS1 + uint16 LE byte length + one complete KVM1 frame. Zero releases UART. */
typedef void (*media_serial_receive_t)(bool media, const uint8_t *data, size_t len);
typedef struct {
    uint8_t data[MEDIA_HEADER + MEDIA_MAX_IO];
    size_t used, expected;
    uint8_t kind, prefix, size_low;
    int64_t started;
    media_serial_receive_t receive;
} media_serial_parser_t;
void media_serial_init(media_serial_parser_t *p, media_serial_receive_t receive);
void media_serial_feed(media_serial_parser_t *p, uint8_t byte, int64_t now);
