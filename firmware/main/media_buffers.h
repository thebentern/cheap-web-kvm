/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "media_ws.h"
#include "sdkconfig.h"
#include <stddef.h>
#include <stdint.h>
#ifndef CONFIG_KVM_MEDIA_WIFI_MAX_IO
#define CONFIG_KVM_MEDIA_WIFI_MAX_IO MEDIA_LEGACY_WIFI_MAX_IO
#endif
#if CONFIG_KVM_MEDIA_WIFI_MAX_IO < MEDIA_SERIAL_MAX_IO || CONFIG_KVM_MEDIA_WIFI_MAX_IO > MEDIA_MAX_IO || CONFIG_KVM_MEDIA_WIFI_MAX_IO % 512
#error "Wi-Fi media ceiling must be 512-byte aligned, from 8 KiB through 128 KiB"
#endif

/* One optional PSRAM allocation serves both the core and network transport.
 * Every pointer has the declared max_io capacity (plus its wire prefixes). */
typedef struct {
    uint8_t *io, *cache, *rx, *reply, *tx;
    uint32_t max_io;
} media_buffers_t;
#define MEDIA_BUFFER_BYTES(max_io) (5u * (max_io) + 3u * MEDIA_HEADER + 2u * MEDIA_WS_PREFIX)
/* Call during single-threaded startup before USB/network tasks. If PSRAM
 * allocation fails, allocate an 8 KiB IO pool internally. False means neither
 * pool could be allocated; callers must not start media with null buffers. */
bool media_buffers_init(void);
const media_buffers_t *media_buffers_get(void);
