/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "media_ws.h"
#include <stddef.h>
#include <stdint.h>

/* One optional PSRAM allocation serves both the core and network transport.
 * Every pointer has the declared max_io capacity (plus its wire prefixes). */
typedef struct {
    uint8_t *io, *cache, *rx, *reply, *tx;
    uint32_t max_io;
} media_buffers_t;
#define MEDIA_BUFFER_BYTES(max_io) (5u * (max_io) + 3u * MEDIA_HEADER + 2u * MEDIA_WS_PREFIX)
/* Call during single-threaded media startup, before USB/network tasks. One
 * failed PSRAM allocation leaves the permanent 8 KiB fallback fully usable. */
void media_buffers_init(void);
const media_buffers_t *media_buffers_get(void);
