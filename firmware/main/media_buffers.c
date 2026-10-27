/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "media_buffers.h"
#include "sdkconfig.h"
#include "esp_heap_caps.h"
#include <stdbool.h>

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
bool media_buffers_init(void)
{
    if (initialized)
        return true;
#if CONFIG_KVM_MEDIA_WIFI
    uint8_t *pool = heap_caps_malloc(MEDIA_BUFFER_BYTES(CONFIG_KVM_MEDIA_WIFI_MAX_IO), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (pool) {
        configure(pool, CONFIG_KVM_MEDIA_WIFI_MAX_IO);
        initialized = true;
        return true;
    }
#endif
    /* Allocate before USB/Wi-Fi/BLE startup. A working PSRAM pool must not
     * permanently reserve another ~40 KiB of scarce internal RAM. */
    uint8_t *fallback = heap_caps_malloc(MEDIA_BUFFER_BYTES(MEDIA_SERIAL_MAX_IO),
                                        MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!fallback)
        return false;
    configure(fallback, MEDIA_SERIAL_MAX_IO);
    initialized = true;
    return true;
}
const media_buffers_t *media_buffers_get(void) { return &buffers; }
