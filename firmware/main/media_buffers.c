/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "media_buffers.h"
#include "sdkconfig.h"
#include "esp_heap_caps.h"
#include <stdbool.h>

static _Alignas(4) uint8_t fallback[MEDIA_BUFFER_BYTES(MEDIA_SERIAL_MAX_IO)];
static media_buffers_t buffers;
static bool initialized;
static void configure(uint8_t *pool, uint32_t max_io)
{
    buffers.io = pool;
    buffers.cache = pool + max_io;
    buffers.rx = pool + 2u * max_io;
    buffers.reply = buffers.rx + MEDIA_HEADER + max_io;
    buffers.tx = buffers.reply + MEDIA_WS_PREFIX + MEDIA_HEADER + max_io;
    buffers.max_io = max_io;
}
void media_buffers_init(void)
{
    if (initialized)
        return;
    configure(fallback, MEDIA_SERIAL_MAX_IO);
#if CONFIG_KVM_MEDIA_WIFI
    uint8_t *pool = heap_caps_malloc(MEDIA_BUFFER_BYTES(MEDIA_MAX_IO), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (pool)
        configure(pool, MEDIA_MAX_IO);
#endif
    initialized = true;
}
const media_buffers_t *media_buffers_get(void) { return &buffers; }
