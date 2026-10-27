/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "boot_repeat.h"
#include "ch9329.h"
#include "kvm_media.h"
#include "media_buffers.h"
#include "esp_heap_caps.h"
#include "device/dcd.h"
#include "tusb.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int64_t mock_time;
int mock_lock_depth;
static bool fail_pool, fail_fallback;
static unsigned pool_allocations;
static uint8_t *allocated_pool;
static size_t allocated_size;
void *heap_caps_malloc(size_t size, unsigned caps)
{
    bool external = caps == (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    assert(external || caps == (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    assert(size == MEDIA_BUFFER_BYTES(external ? CONFIG_KVM_MEDIA_WIFI_MAX_IO : MEDIA_SERIAL_MAX_IO));
    pool_allocations++;
    if (external ? fail_pool : fail_fallback)
        return NULL;
    allocated_pool = malloc(size + 16);
    assert(allocated_pool);
    memset(allocated_pool + size, 0xa7, 16);
    allocated_size = size;
    return allocated_pool;
}
static unsigned completed, hid_frames;
static bool ble_wifi_media_active;
static unsigned ble_pauses;
void kvm_ble_set_wifi_media_active(bool active)
{
    ble_wifi_media_active = active;
    if (active)
        ble_pauses++;
}
static int32_t completion;
static void (*deferred)(void *);
static void *deferred_arg;
bool tud_msc_set_sense(uint8_t a, uint8_t b, uint8_t c, uint8_t d)
{
    (void)a;
    (void)b;
    (void)c;
    (void)d;
    return true;
}
bool tud_msc_async_io_done(int32_t n, bool isr)
{
    (void)isr;
    completed++;
    completion = n;
    return true;
}
void usbd_defer_func(void (*fn)(void *), void *arg, bool isr)
{
    (void)isr;
    assert(!mock_lock_depth);
    assert(!deferred);
    deferred = fn;
    deferred_arg = arg;
}
bool __real_mscd_control_xfer_cb(uint8_t p, uint8_t s, const tusb_control_request_t *r)
{
    (void)p;
    (void)s;
    (void)r;
    return true;
}
bool kvm_boot_active(void) { return false; }
void kvm_hid_release_link(void) {}
void kvm_boot_cancel(void) {}
bool kvm_boot_arm(uint8_t k, uint32_t d, uint32_t p, uint32_t i, uint32_t n)
{
    boot_config_t c = {k, d, p, i, n};
    return boot_config_valid(&c);
}
void ch9329_parser_init(ch9329_parser_t *p, ch9329_tx_fn_t tx) { p->tx = tx; }
void ch9329_parser_feed(ch9329_parser_t *p, uint8_t b)
{
    (void)p;
    (void)b;
    hid_frames++;
}
extern int32_t tud_msc_read10_cb(uint8_t, uint32_t, uint32_t, void *, uint32_t);
extern int32_t tud_msc_write10_cb(uint8_t, uint32_t, uint32_t, uint8_t *, uint32_t);
extern bool tud_msc_test_unit_ready_cb(uint8_t);
extern bool tud_msc_prevent_allow_medium_removal_cb(uint8_t, uint8_t, uint8_t);
extern bool tud_msc_start_stop_cb(uint8_t, uint8_t, bool, bool);
extern void tud_event_hook_cb(uint8_t, uint32_t, bool);
extern bool __wrap_mscd_control_xfer_cb(uint8_t, uint8_t, const tusb_control_request_t *);
static uint8_t frame[MEDIA_HEADER + MEDIA_MAX_IO], reply[MEDIA_HEADER + MEDIA_MAX_IO],
    request[MEDIA_HEADER + MEDIA_MAX_IO], data[MEDIA_MAX_IO];
static uint32_t session, id;
static media_msg_t command(uint8_t op, uint16_t flags, uint64_t offset)
{
    media_msg_t m = {.op = op, .id = ++id, .session = session, .offset = offset, .flags = flags};
    size_t n = media_encode(frame, &m, NULL, 0);
    n = kvm_media_command(frame, n, reply);
    assert(n);
    assert(media_decode(reply, n, &m));
    return m;
}
static media_msg_t poll_request(void)
{
    size_t n;
    assert(kvm_media_poll(request, &n));
    media_msg_t m;
    assert(media_decode(request, n, &m));
    return m;
}
static uint32_t hello(media_source_t source, uint64_t desired)
{
    media_msg_t m = {.op = M_HELLO, .id = ++id, .session = session, .offset = desired};
    size_t n = media_encode(frame, &m, NULL, 0);
    n = kvm_media_command_from(source, frame, n, reply);
    assert(media_decode(reply, n, &m) && m.flags == M_OK && m.length == 8);
    session = m.session;
    uint32_t units = reply[MEDIA_HEADER + 4] | (uint32_t)reply[MEDIA_HEADER + 5] << 8;
    return units * (reply[MEDIA_HEADER + 6] == 3 ? 512 : 1);
}
static void answer(media_msg_t m, uint16_t status)
{
    m.op |= 128;
    m.flags = status;
    size_t n = media_encode(frame, &m, m.op == (M_READ | 128) ? data : NULL,
                            m.op == (M_READ | 128) ? m.length : 0);
    kvm_media_command(frame, n, reply);
}
static void finish(void)
{
    size_t n;
    assert(!kvm_media_poll(request, &n));
    assert(deferred);
    void (*fn)(void *) = deferred;
    deferred = NULL;
    fn(deferred_arg);
}
#if CONFIG_KVM_MEDIA_PREFETCH
static void answer_fill(media_msg_t m, uint8_t value)
{
    memset(data, value, sizeof(data));
    answer(m, M_OK);
}
static uint8_t disk_pattern(uint64_t address)
{
    return (uint8_t)((address / 512) ^ (address / 65536) ^ (address % 512));
}
static void answer_pattern(media_msg_t m)
{
    for (uint32_t i = 0; i < m.length; i++)
        data[i] = disk_pattern(m.offset + i);
    answer(m, M_OK);
}
static void warm_prefetch(uint8_t *usb, uint32_t start, uint32_t capacity_bytes)
{
    kvm_media_disconnect();
    assert(!deferred);
    assert(hello(MEDIA_SOURCE_HTTP, MEDIA_MAX_IO) == MEDIA_MAX_IO);
    assert(command(M_INSERT, M_WRITABLE, capacity_bytes).flags == M_OK);
    assert(tud_msc_read10_cb(0, start / 512, 0, usb, 8192) == TUD_MSC_RET_ASYNC);
    media_msg_t m = poll_request();
    assert(m.offset == start && m.length == 32768);
    answer_fill(m, 0x11); finish();
    assert(usb[0] == 0x11 && usb[8191] == 0x11);
    assert(tud_msc_read10_cb(0, (start + 8192) / 512, 0, usb, 8192) == 8192);
}
static void test_prefetch(void)
{
    uint8_t usb[8192];
    size_t n;
    if (fail_pool) {
        assert(hello(MEDIA_SOURCE_HTTP, MEDIA_MAX_IO) == MEDIA_SERIAL_MAX_IO);
        assert(command(M_INSERT, 0, 1048576).flags == M_OK);
        assert(tud_msc_read10_cb(0, 0, 0, usb, 4096) == TUD_MSC_RET_ASYNC);
        media_msg_t m = poll_request();
        assert(m.length == 8192);
        answer_fill(m, 0x11); finish();
        assert(tud_msc_read10_cb(0, 8, 0, usb, 4096) == 4096);
        assert(!kvm_media_poll(request, &n) && !deferred);
        assert(command(M_EJECT, 0, 0).flags == M_OK);
        puts("PASS: prefetch profile falls back to bounded 8 KiB IO without PSRAM");
        return;
    }
    /* Receive the next range while USB continues reading the current cache. */
    warm_prefetch(usb, 0, 1048576);
    media_msg_t m = poll_request();
    assert(m.offset == 32768 && m.length == 65536);
    unsigned before = completed;
    assert(tud_msc_read10_cb(0, 32, 0, usb, sizeof(usb)) == sizeof(usb));
    assert(usb[0] == 0x11);
    assert(tud_msc_read10_cb(0, 48, 0, usb, sizeof(usb)) == sizeof(usb));
    assert(!kvm_media_poll(request, &n) && !deferred);
    media_msg_t stale = m; stale.id++;
    answer_fill(stale, 0xee);
    answer_fill(m, 0x22);
    assert(!kvm_media_poll(request, &n) && !deferred && completed == before);
    for (uint32_t at = 32768; at < 65536; at += sizeof(usb)) {
        assert(tud_msc_read10_cb(0, at / 512, 0, usb, sizeof(usb)) == sizeof(usb));
        assert(usb[0] == 0x22 && usb[8191] == 0x22);
    }
    m = poll_request();
    assert(m.offset == 98304 && m.length == 131072);
    for (uint32_t at = 65536; at < 98304; at += sizeof(usb))
        assert(tud_msc_read10_cb(0, at / 512, 0, usb, sizeof(usb)) == sizeof(usb));
    /* USB catches up: the existing prefetch becomes the demand's completion. */
    memset(usb, 0xcc, sizeof(usb));
    assert(tud_msc_read10_cb(0, 98304 / 512, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    assert(!kvm_media_poll(request, &n) && !deferred && usb[0] == 0xcc);
    answer_fill(m, 0x33); finish();
    assert(completed == before + 1 && completion == sizeof(usb));
    assert(usb[0] == 0x33 && usb[8191] == 0x33);
    assert(command(M_EJECT, 0, 0).flags == M_OK);

    /* A demand can start inside a speculative range rather than at its
     * beginning; completion must copy the corresponding offset only. */
    warm_prefetch(usb, 0, 1048576);
    m = poll_request();
    assert(tud_msc_read10_cb(0, 40960 / 512, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    answer_pattern(m); finish();
    for (unsigned i = 0; i < sizeof(usb); i++)
        assert(usb[i] == disk_pattern(40960 + i));

    /* Unsent speculation is cancelled immediately; a sent READ is drained
     * before a WRITE can enter the browser's single remote IO slot. */
    warm_prefetch(usb, 0, 1048576);
    memset(usb, 0x6d, sizeof(usb));
    assert(tud_msc_write10_cb(0, 0, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request(); assert(m.op == M_WRITE && m.length == sizeof(usb));
    answer(m, M_OK); finish();
    warm_prefetch(usb, 0, 1048576);
    m = poll_request(); before = completed;
    memset(usb, 0x6d, sizeof(usb));
    assert(tud_msc_write10_cb(0, 0, 0, usb, sizeof(usb)) == TUD_MSC_RET_BUSY);
    assert(!kvm_media_poll(request, &n) && !deferred);
    answer_fill(m, 0xee);
    assert(completed == before && usb[0] == 0x6d);
    assert(tud_msc_write10_cb(0, 0, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    media_msg_t write = poll_request();
    assert(write.op == M_WRITE && request[MEDIA_HEADER] == 0x6d);
    answer(write, M_OK); finish();
    assert(tud_msc_read10_cb(0, 0, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    media_msg_t fresh = poll_request();
    assert(fresh.op == M_READ && fresh.length == 32768);
    answer_fill(m, 0xee); // A late duplicate cannot fill the post-write cache.
    assert(!kvm_media_poll(request, &n) && !deferred);
    answer_fill(fresh, 0x77); finish();
    assert(usb[0] == 0x77);

    /* Random seeks reset growth and never reuse the speculative range. */
    warm_prefetch(usb, 0, 1048576);
    m = poll_request();
    assert(tud_msc_read10_cb(0, 1024, 0, usb, sizeof(usb)) == TUD_MSC_RET_BUSY);
    answer_fill(m, 0xee);
    assert(tud_msc_read10_cb(0, 1024, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    fresh = poll_request(); assert(fresh.offset == 524288 && fresh.length == 32768);
    answer_fill(fresh, 0x44); finish(); assert(usb[0] == 0x44);

    /* A reset drains the old request but never touches a later USB buffer. */
    warm_prefetch(usb, 0, 1048576);
    m = poll_request(); before = completed;
    tud_event_hook_cb(0, DCD_EVENT_BUS_RESET, false);
    memset(usb, 0xcc, sizeof(usb));
    assert(tud_msc_read10_cb(0, 0, 0, usb, sizeof(usb)) == TUD_MSC_RET_BUSY);
    answer_fill(m, 0xee);
    assert(!deferred && completed == before && usb[0] == 0xcc);
    assert(tud_msc_read10_cb(0, 0, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    fresh = poll_request(); assert(fresh.id != m.id && fresh.length == 32768);
    answer_fill(m, 0xee);
    assert(!kvm_media_poll(request, &n) && !deferred);
    answer_fill(fresh, 0x55); finish(); assert(usb[0] == 0x55);

    /* The reply can be the first task to observe a reset. A speculative
     * request already attached to USB must also drain without completion. */
    warm_prefetch(usb, 0, 1048576);
    m = poll_request(); before = completed;
    memset(usb, 0xcc, sizeof(usb));
    assert(tud_msc_read10_cb(0, 32768 / 512, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    tud_event_hook_cb(0, DCD_EVENT_BUS_RESET, false);
    answer_fill(m, 0xee);
    assert(!kvm_media_poll(request, &n) && !deferred && completed == before && usb[0] == 0xcc);
    assert(tud_msc_read10_cb(0, 0, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    fresh = poll_request(); answer_fill(fresh, 0x55); finish();

    /* Ejection and timeouts cannot leave a completed speculation holding
     * the medium forever, or synthesize a USB completion with no waiter. */
    warm_prefetch(usb, 0, 1048576);
    m = poll_request(); before = completed;
    assert(command(M_EJECT, 0, 0).flags == M_BUSY);
    answer_fill(m, 0xee);
    assert(command(M_EJECT, 0, 0).flags == M_OK && completed == before);
    warm_prefetch(usb, 0, 1048576);
    m = poll_request(); answer_fill(m, 0x22);
    assert(tud_msc_start_stop_cb(0, 0, false, true));
    warm_prefetch(usb, 0, 1048576);
    poll_request(); before = completed;
    mock_time += 10000001;
    assert(!kvm_media_poll(request, &n) && !deferred && completed == before);
    assert(!tud_msc_test_unit_ready_cb(0));
    media_metrics_t metrics;
    assert(kvm_media_metrics(&metrics) && metrics.first_failure == MEDIA_FAILURE_IO_TIMEOUT);
    warm_prefetch(usb, 0, 1048576);
    m = poll_request(); before = completed;
    memset(usb, 0xcc, sizeof(usb));
    answer(m, M_IO);
    assert(!kvm_media_poll(request, &n) && !deferred && completed == before);
    assert(usb[0] == 0xcc && !tud_msc_test_unit_ready_cb(0));
    assert(kvm_media_metrics(&metrics) && metrics.first_failure == MEDIA_FAILURE_BACKEND);

    /* Read-ahead never crosses the end of a disk. */
    const uint32_t tail_start = 1048576 - 49152;
    warm_prefetch(usb, tail_start, 1048576);
    m = poll_request(); assert(m.offset == 1048576 - 16384 && m.length == 16384);
    answer_fill(m, 0x66);
    assert(tud_msc_read10_cb(0, (1048576 - 8192) / 512, 0, usb, sizeof(usb)) == sizeof(usb));
    assert(usb[0] == 0x66 && !kvm_media_poll(request, &n) && !deferred);
    assert(command(M_EJECT, 0, 0).flags == M_OK);

    /* Read a complete synthetic disk, delaying each speculative reply across
     * two USB callbacks. Check every byte through repeated buffer rotations. */
    assert(hello(MEDIA_SOURCE_HTTP, MEDIA_MAX_IO) == MEDIA_MAX_IO);
    assert(command(M_INSERT, 0, 1048576).flags == M_OK);
    bool pending = false, saw64 = false, saw128 = false;
    unsigned held = 0;
    for (uint32_t at = 0; at < 1048576; at += sizeof(usb)) {
        mock_time += 5000;
        memset(usb, 0xcc, sizeof(usb));
        int32_t result = tud_msc_read10_cb(0, at / 512, 0, usb, sizeof(usb));
        if (result == TUD_MSC_RET_ASYNC) {
            if (!pending)
                m = poll_request();
            assert(m.offset <= at && m.offset + m.length >= at + sizeof(usb));
            answer_pattern(m); pending = false; finish();
        } else
            assert(result == sizeof(usb));
        for (unsigned i = 0; i < sizeof(usb); i++)
            assert(usb[i] == disk_pattern(at + i));
        if (kvm_media_poll(request, &n)) {
            assert(!pending && media_decode(request, n, &m));
            assert(m.op == M_READ && m.offset + m.length <= 1048576);
            saw64 |= m.length == 65536;
            saw128 |= m.length == 131072;
            pending = true; held = 0;
        }
        if (pending && ++held == 2) {
            answer_pattern(m);
            pending = false;
        }
    }
    assert(!pending && saw64 && saw128);
    assert(kvm_media_metrics(&metrics) && metrics.read_bytes == 1048576 &&
           metrics.first_failure == MEDIA_FAILURE_NONE);
    assert(command(M_EJECT, 0, 0).flags == M_OK);

    /* Two tiny metadata reads should not trigger a large speculative fetch. */
    assert(command(M_INSERT, 0, 1048576).flags == M_OK);
    assert(tud_msc_read10_cb(0, 0, 0, usb, 512) == TUD_MSC_RET_ASYNC);
    m = poll_request(); answer_pattern(m); finish();
    assert(tud_msc_read10_cb(0, 1, 0, usb, 512) == 512);
    assert(!kvm_media_poll(request, &n) && !deferred);
    assert(command(M_EJECT, 0, 0).flags == M_OK);
    kvm_media_disconnect();
    assert(hello(MEDIA_SOURCE_SERIAL, MEDIA_MAX_IO) == MEDIA_SERIAL_MAX_IO);
    for (unsigned i = 0; i < 16; i++)
        assert(allocated_pool[allocated_size + i] == 0xa7);
    puts("PASS: overlapping 32/64/128 KiB reads, 8 KiB USB, demand attachment, write/random/reset cancellation, ejection, timeout and disk bounds");
}
#endif
int main(int argc, char **argv)
{
    fail_fallback = argc == 2 && !strcmp(argv[1], "--oom");
    fail_pool = fail_fallback || (argc == 2 && !strcmp(argv[1], "--fallback"));
    assert(argc == 1 || fail_pool);
    if (fail_fallback) {
        assert(kvm_media_init() == ESP_ERR_NO_MEM && pool_allocations == 2);
        assert(!media_buffers_get()->io && !media_buffers_get()->max_io);
        puts("PASS: complete allocation failure rejects media startup");
        return 0;
    }
    assert(media_crc((const uint8_t *)"123456789", 9, 0xffffffff) == (0xcbf43926 ^ 0xffffffff));
    assert(media_range(UINT64_C(1) << 40, (UINT64_C(1) << 40) - 512, 512));
    assert(!media_range(512, 511, 2));
    assert(kvm_media_init() == ESP_OK);
    assert(kvm_media_max_io() == MEDIA_SERIAL_MAX_IO);
    const media_buffers_t *buffers = media_buffers_get();
    assert(pool_allocations == (fail_pool ? 2 : 1));
    assert(buffers->max_io == (fail_pool ? MEDIA_SERIAL_MAX_IO : CONFIG_KVM_MEDIA_WIFI_MAX_IO));
    assert(buffers->cache == buffers->io + buffers->max_io);
    assert(buffers->rx == buffers->cache + buffers->max_io);
    assert(buffers->tx + MEDIA_WS_PREFIX + MEDIA_HEADER + buffers->max_io ==
           buffers->io + MEDIA_BUFFER_BYTES(buffers->max_io));
    assert(media_buffers_init());
    assert(pool_allocations == (fail_pool ? 2 : 1));
#if CONFIG_KVM_MEDIA_PREFETCH
    test_prefetch();
    return 0;
#endif
    assert(!ble_wifi_media_active);
    media_msg_t m = command(M_HELLO, 0, 0);
    assert(!m.flags);
    session = m.session;
    media_metrics_t metrics;
    assert(!kvm_media_metrics(NULL));
    assert(kvm_media_metrics(&metrics) && !metrics.reads && !metrics.read_bytes);
    media_msg_t competing = {.op = M_HELLO, .id = ++id};
    size_t competing_n = media_encode(frame, &competing, NULL, 0);
    competing_n = kvm_media_command_from(MEDIA_SOURCE_SERIAL, frame, competing_n, reply);
    assert(media_decode(reply, competing_n, &competing) && competing.flags == M_BUSY);
    kvm_media_disconnect_from(MEDIA_SOURCE_SERIAL);
    assert(command(M_STATUS, 0, 0).flags == M_OK);
    assert(kvm_media_network_change_begin());
    assert(command(M_INSERT, M_WRITABLE, 1024 * 1024).flags == M_BUSY);
    assert(!ble_wifi_media_active && !ble_pauses);
    kvm_media_network_change_end();
    assert(command(M_INSERT, M_WRITABLE, 1024 * 1024).flags == M_OK);
    assert(ble_wifi_media_active && ble_pauses == 1);
    assert(!kvm_media_network_change_begin());
    assert(!tud_msc_test_unit_ready_cb(0));
    assert(tud_msc_test_unit_ready_cb(0));
    uint8_t usb[4096];
    memset(usb, 0xcc, sizeof(usb));
    memset(data, 0x5a, sizeof(data));
    assert(tud_msc_read10_cb(0, 0, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request();
    assert(m.length == 8192);
    mock_time += 50000;
    media_msg_t stale = m;
    stale.id++;
    answer(stale, M_OK);
    assert(!completed && usb[0] == 0xcc);
    assert(kvm_media_metrics(&metrics) && !metrics.reads);
    answer(m, M_OK);
    answer(m, M_OK); /* Duplicate replies must not inflate timing or bytes. */
    assert(kvm_media_metrics(&metrics));
    assert(metrics.reads == 1 && metrics.read_bytes == 8192);
    assert(metrics.read_time_us == 50000 && metrics.read_max_us == 50000);
    assert(!completed);
    finish();
    assert(completed == 1 && completion == 4096 && usb[0] == 0x5a);
    /* Read-ahead cache satisfies adjacent requests with no network operation. */
    assert(tud_msc_read10_cb(0, 8, 0, usb, sizeof(usb)) == 4096);
    assert(kvm_media_metrics(&metrics) && metrics.cache_bytes == 4096 && metrics.reads == 1);
    memset(usb, 0x72, sizeof(usb));
    assert(tud_msc_write10_cb(0, 8, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request();
    assert(request[32] == 0x72);
    assert(command(M_EJECT, 0, 0).flags == M_BUSY);
    assert(ble_wifi_media_active);
    assert(completed == 1);
    answer(m, M_OK);
    finish();
    assert(completed == 2);
    assert(kvm_media_metrics(&metrics) && metrics.reads == 1 && metrics.read_bytes == 8192);
    /* Bus resets invalidate both pending response IDs and prevention state. */
    assert(tud_msc_prevent_allow_medium_removal_cb(0, 1, 0));
    assert(command(M_EJECT, 0, 0).flags == M_PROTECTED);
    assert(ble_wifi_media_active);
    assert(tud_msc_read10_cb(0, 40, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    stale = poll_request();
    tud_event_hook_cb(0, 1, false);
    assert(tud_msc_read10_cb(0, 40, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request();
    assert(m.id != stale.id);
    answer(stale, M_OK);
    assert(completed == 2);
    answer(m, M_OK);
    finish();
    assert(completed == 3);
    assert(tud_msc_read10_cb(0, 64, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    stale = poll_request();
    tusb_control_request_t reset = {.bmRequestType = 0x21, .bRequest = 0xff, .wIndex = 2};
    assert(__wrap_mscd_control_xfer_cb(0, 0, &reset));
    assert(tud_msc_read10_cb(0, 64, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request();
    answer(stale, M_OK);
    answer(m, M_OK);
    finish();
    assert(completed == 4);
    assert(tud_msc_write10_cb(0, 2048, 0, usb, sizeof(usb)) == TUD_MSC_RET_ERROR);
    /* A failed/expired operation is never successful, nor fabricated zeros. */
    assert(tud_msc_read10_cb(0, 100, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    poll_request();
    mock_time += 10000001;
    finish();
    assert(completion == TUD_MSC_RET_ERROR);
    assert(!ble_wifi_media_active); /* A failed HTTP disk restores discovery. */
    assert(!tud_msc_test_unit_ready_cb(0));
    assert(kvm_media_metrics(&metrics) && metrics.reads == 3 && metrics.read_bytes == 3 * 8192);
    assert(metrics.first_failure == MEDIA_FAILURE_IO_TIMEOUT && metrics.io_timeouts == 1 &&
           !metrics.lease_timeouts && !metrics.backend_errors && !metrics.disconnects);
    kvm_media_disconnect();
    assert(kvm_media_metrics(&metrics) && metrics.first_failure == MEDIA_FAILURE_IO_TIMEOUT &&
           metrics.io_timeouts == 1 && !metrics.disconnects);
    m = command(M_HELLO, 0, 0);
    session = m.session;
    assert(kvm_media_metrics(&metrics) && !metrics.reads && !metrics.read_time_us && !metrics.cache_bytes);
    assert(command(M_INSERT, 0, 1024 * 1024).flags == M_OK);
    assert(ble_wifi_media_active && ble_pauses == 2);
    assert(tud_msc_write10_cb(0, 0, 0, usb, sizeof(usb)) == TUD_MSC_RET_ERROR);
    assert(command(M_EJECT, 0, 0).flags == M_OK);
    assert(!ble_wifi_media_active);
    mock_time += 5000001;
    size_t n;
    kvm_media_poll(request, &n);
    assert(command(M_STATUS, 0, 0).flags == M_STALE);
    assert(kvm_media_metrics(&metrics) && metrics.first_failure == MEDIA_FAILURE_LEASE &&
           metrics.lease_timeouts == 1 && !metrics.io_timeouts);
    /* Only the active transport can command, receive IO, or disconnect. */
    media_msg_t serial = {.op = M_HELLO, .id = ++id};
    n = media_encode(frame, &serial, NULL, 0);
    n = kvm_media_command_from(MEDIA_SOURCE_SERIAL, frame, n, reply);
    assert(media_decode(reply, n, &serial) && !serial.flags);
    assert(reply[39] == 1); /* UART transport capability hint. */
    session = serial.session;
    assert(command(M_HELLO, 0, 0).flags == M_BUSY);
    kvm_media_disconnect_from(MEDIA_SOURCE_HTTP);
    serial = (media_msg_t){.op = M_INSERT, .id = ++id, .session = session,
                           .offset = 1024 * 1024};
    n = media_encode(frame, &serial, NULL, 0);
    n = kvm_media_command_from(MEDIA_SOURCE_SERIAL, frame, n, reply);
    assert(media_decode(reply, n, &serial) && !serial.flags);
    assert(!ble_wifi_media_active && ble_pauses == 2); /* UART disks do not pause BLE. */
    assert(tud_msc_read10_cb(0, 160, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    assert(!kvm_media_poll_from(MEDIA_SOURCE_HTTP, request, &n));
    assert(kvm_media_poll_from(MEDIA_SOURCE_SERIAL, request, &n));
    assert(media_decode(request, n, &serial));
    serial.op |= 128;
    n = media_encode(frame, &serial, data, serial.length);
    assert(!kvm_media_command_from(MEDIA_SOURCE_HTTP, frame, n, reply));
    assert(completed == 5);
    size_t raw_length = n;
    assert(!kvm_media_poll_from(MEDIA_SOURCE_SERIAL, request, &n));
    assert(!deferred); /* A valid CRC/session from the other transport is ignored. */
    kvm_media_command_from(MEDIA_SOURCE_SERIAL, frame, raw_length, reply);
    assert(!kvm_media_poll_from(MEDIA_SOURCE_SERIAL, request, &n));
    assert(deferred);
    void (*fn)(void *) = deferred;
    deferred = NULL;
    fn(deferred_arg);
    assert(completion == sizeof(usb));
    kvm_media_disconnect_from(MEDIA_SOURCE_SERIAL);
    assert(!tud_msc_test_unit_ready_cb(0));
    assert(command(M_HELLO, 0, 0).flags == M_OK);

    /* Real IO is owner liveness even if a background heartbeat timer stalls.
     * Each reply still finishes inside its own bounded IO deadline. */
    session = command(M_HELLO, 0, 0).session;
    assert(command(M_INSERT, 0, 1024 * 1024).flags == M_OK);
    for (unsigned i = 0; i < 4; i++) {
        mock_time += 2000000;
        assert(tud_msc_read10_cb(0, 200 + i * 16, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
        m = poll_request();
        answer(m, M_OK);
        finish();
        assert(completion == sizeof(usb));
    }
    assert(command(M_EJECT, 0, 0).flags == M_OK);
    assert(!ble_wifi_media_active);
    mock_time += 5000001;
    assert(!kvm_media_poll(request, &n));
    assert(command(M_STATUS, 0, 0).flags == M_STALE); /* Idle lease is unchanged. */

    /* UART reuses the parser's full-capacity buffer for in-place replies. */
    session = command(M_HELLO, 0, 0).session;
    media_msg_t echo = {.op = M_ECHO, .id = ++id, .session = session,
                        .length = MEDIA_SERIAL_MAX_IO};
    memset(data, 0x57, sizeof(data));
    n = media_encode(frame, &echo, data, echo.length);
    n = kvm_media_command(frame, n, frame);
    assert(media_decode(frame, n, &echo) && echo.op == (M_ECHO | 128));
    assert(n == MEDIA_HEADER + MEDIA_SERIAL_MAX_IO && !memcmp(frame + MEDIA_HEADER, data, echo.length));

    /* Target ejection and HTTP disconnect also restore discovery; a protected
     * target eject must leave it paused until the disk is actually removed. */
    assert(command(M_INSERT, 0, 1024 * 1024).flags == M_OK);
    assert(ble_wifi_media_active);
    assert(tud_msc_prevent_allow_medium_removal_cb(0, 1, 0));
    assert(!tud_msc_start_stop_cb(0, 0, false, true) && ble_wifi_media_active);
    assert(tud_msc_prevent_allow_medium_removal_cb(0, 0, 0));
    assert(tud_msc_start_stop_cb(0, 0, false, true) && !ble_wifi_media_active);
    assert(command(M_INSERT, 0, 1024 * 1024).flags == M_OK && ble_wifi_media_active);
    kvm_media_disconnect();
    assert(!ble_wifi_media_active);

    /* A pending read can survive a six-second server pause, beyond the idle
     * lease, then complete normally inside its ten-second IO deadline. */
    session = command(M_HELLO, 0, 0).session;
    assert(command(M_INSERT, 0, 1024 * 1024).flags == M_OK);
    assert(tud_msc_read10_cb(0, 400, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request();
    mock_time += 6000000;
    assert(!kvm_media_poll(request, &n) && !deferred && ble_wifi_media_active);
    assert(kvm_media_metrics(&metrics) && metrics.first_failure == MEDIA_FAILURE_NONE);
    answer(m, M_OK);
    finish();
    assert(completion == sizeof(usb));
    assert(kvm_media_metrics(&metrics) && metrics.reads == 1 && metrics.read_time_us == 6000000 &&
           !metrics.io_timeouts && !metrics.lease_timeouts);
    assert(command(M_EJECT, 0, 0).flags == M_OK);
    mock_time += 5000001;
    assert(!kvm_media_poll(request, &n));
    assert(kvm_media_metrics(&metrics) && metrics.first_failure == MEDIA_FAILURE_LEASE);

    /* A stalled write still has no USB completion until its durable ACK. */
    session = command(M_HELLO, 0, 0).session;
    assert(command(M_INSERT, M_WRITABLE, 1024 * 1024).flags == M_OK);
    unsigned before_write = completed;
    assert(tud_msc_write10_cb(0, 420, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request();
    mock_time += 6000000;
    assert(!kvm_media_poll(request, &n) && !deferred && completed == before_write);
    answer(m, M_OK);
    finish();
    assert(completed == before_write + 1 && completion == sizeof(usb));
    assert(command(M_EJECT, 0, 0).flags == M_OK);

    /* Replies arriving after the IO deadline fail even if no poll ran during
     * the pause; cleanup must not overwrite the original failure cause. */
    session = command(M_HELLO, 0, 0).session;
    assert(command(M_INSERT, 0, 1024 * 1024).flags == M_OK);
    assert(tud_msc_read10_cb(0, 440, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request();
    mock_time += 10000001;
    answer(m, M_OK);
    finish();
    kvm_media_disconnect();
    assert(completion == TUD_MSC_RET_ERROR && !ble_wifi_media_active);
    assert(kvm_media_metrics(&metrics) && metrics.first_failure == MEDIA_FAILURE_IO_TIMEOUT &&
           metrics.io_timeouts == 1 && !metrics.reads && !metrics.disconnects);

    session = command(M_HELLO, 0, 0).session;
    assert(command(M_INSERT, 0, 1024 * 1024).flags == M_OK);
    assert(tud_msc_read10_cb(0, 460, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request();
    answer(m, M_IO);
    finish();
    kvm_media_disconnect();
    assert(kvm_media_metrics(&metrics) && metrics.first_failure == MEDIA_FAILURE_BACKEND &&
           metrics.backend_errors == 1 && !metrics.io_timeouts && !metrics.disconnects);

    /* Negotiation is opt-in, bounded, and always limited to 8 KiB on UART.
     * The exact same tests run again with a failed PSRAM allocation. */
    assert(hello(MEDIA_SOURCE_HTTP, 0) == MEDIA_SERIAL_MAX_IO);
    assert(kvm_media_max_io() == MEDIA_SERIAL_MAX_IO);
    assert(command(M_HELLO, 0, MEDIA_SERIAL_MAX_IO - 512).flags == M_INVALID);
    assert(command(M_HELLO, 0, MEDIA_SERIAL_MAX_IO + 1).flags == M_INVALID);
    assert(command(M_HELLO, 0, MEDIA_MAX_IO + 512).flags == M_INVALID);
    memset(reply, 0x6d, sizeof(reply));
    echo = (media_msg_t){.op = M_ECHO, .id = ++id, .session = session, .length = MEDIA_MAX_IO};
    n = media_encode(frame, &echo, data, echo.length);
    n = kvm_media_command(frame, n, reply);
    assert(media_decode(reply, n, &echo) && echo.flags == M_INVALID && n == MEDIA_HEADER);
    for (size_t i = MEDIA_HEADER; i < sizeof(reply); i++) assert(reply[i] == 0x6d);
    /* An oversized response cannot complete or overwrite an 8 KiB request. */
    assert(command(M_INSERT, 0, 1024 * 1024).flags == M_OK);
    assert(tud_msc_read10_cb(0, 500, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request();
    assert(m.length == MEDIA_SERIAL_MAX_IO);
    stale = m; stale.length = MEDIA_MAX_IO;
    answer(stale, M_OK);
    assert(!kvm_media_poll(request, &n) && !deferred);
    answer(m, M_OK); finish();
    assert(completion == sizeof(usb));
    assert(command(M_EJECT, 0, 0).flags == M_OK);
    kvm_media_disconnect();
    assert(hello(MEDIA_SOURCE_SERIAL, MEDIA_MAX_IO) == MEDIA_SERIAL_MAX_IO);
    assert(tud_msc_read10_cb(0, 0, 0, usb, sizeof(usb)) == TUD_MSC_RET_ERROR); /* Not inserted. */
    serial = (media_msg_t){.op = M_INSERT, .id = ++id, .session = session, .offset = 1024 * 1024};
    n = media_encode(frame, &serial, NULL, 0);
    n = kvm_media_command_from(MEDIA_SOURCE_SERIAL, frame, n, reply);
    assert(media_decode(reply, n, &serial) && serial.flags == M_OK);
    assert(tud_msc_read10_cb(0, 0, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    assert(kvm_media_poll_from(MEDIA_SOURCE_SERIAL, request, &n));
    assert(media_decode(request, n, &serial) && serial.length == MEDIA_SERIAL_MAX_IO);
    serial.op |= 128;
    n = media_encode(frame, &serial, data, serial.length);
    assert(!kvm_media_command_from(MEDIA_SOURCE_SERIAL, frame, n, reply));
    finish();
    assert(completion == sizeof(usb));
    kvm_media_disconnect_from(MEDIA_SOURCE_SERIAL);

    assert(hello(MEDIA_SOURCE_HTTP, 16384) == (fail_pool ? MEDIA_SERIAL_MAX_IO : 16384));
    assert(hello(MEDIA_SOURCE_HTTP, MEDIA_LEGACY_WIFI_MAX_IO) ==
           (fail_pool ? MEDIA_SERIAL_MAX_IO : MEDIA_LEGACY_WIFI_MAX_IO));
    assert(reply[MEDIA_HEADER + 6] == 1); /* Old browsers keep byte units. */
    kvm_media_disconnect();
    uint32_t selected = hello(MEDIA_SOURCE_HTTP, MEDIA_MAX_IO);
    assert(selected == buffers->max_io);
    assert(kvm_media_max_io() == selected);
    assert(command(M_INSERT, M_WRITABLE, 1024 * 1024).flags == M_OK);
    for (size_t i = 0; i < sizeof(data); i++) data[i] = (uint8_t)(i / sizeof(usb));
    assert(tud_msc_read10_cb(0, 0, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request();
    assert(m.length == selected);
    stale = m; stale.id++;
    answer(stale, M_OK);
    assert(!kvm_media_poll(request, &n) && !deferred);
    answer(m, M_OK); finish();
    assert(usb[0] == 0 && usb[sizeof(usb) - 1] == 0);
    for (uint32_t chunk = 1; chunk < selected / sizeof(usb); chunk++) {
        assert(tud_msc_read10_cb(0, chunk * 8, 0, usb, sizeof(usb)) == sizeof(usb));
        assert(usb[0] == chunk && usb[sizeof(usb) - 1] == chunk);
    }
    assert(kvm_media_metrics(&metrics) && metrics.reads == 1 &&
           metrics.cache_bytes == selected - sizeof(usb));
    /* The first request outside the full negotiated cache must fetch again. */
    assert(tud_msc_read10_cb(0, selected / 512, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request(); assert(m.offset == selected && m.length == selected);
    answer(m, M_OK); finish();
    media_msg_t prior_read = m;
    assert(tud_msc_write10_cb(0, selected / 512, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request(); assert(m.op == M_WRITE && m.length == sizeof(usb));
    answer(prior_read, M_OK);
    assert(!kvm_media_poll(request, &n) && !deferred);
    answer(m, M_OK); finish();
    /* A durable write invalidates all prefetched bytes before another read. */
    assert(tud_msc_read10_cb(0, selected / 512, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request(); assert(m.length == selected);
    answer(m, M_OK); finish();
    /* Tail reads are clipped to capacity rather than the negotiated maximum. */
    assert(tud_msc_read10_cb(0, 2040, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request(); assert(m.offset == 1024 * 1024 - sizeof(usb) && m.length == sizeof(usb));
    answer(m, M_OK); finish();
    assert(tud_msc_read10_cb(0, 2048, 0, usb, sizeof(usb)) == TUD_MSC_RET_ERROR);
    assert(command(M_EJECT, 0, 0).flags == M_OK);
    /* Full-size ECHO is also limited to the negotiated value. */
    echo = (media_msg_t){.op = M_ECHO, .id = ++id, .session = session, .length = selected};
    n = media_encode(frame, &echo, data, selected);
    n = kvm_media_command(frame, n, reply);
    assert(media_decode(reply, n, &echo) && echo.flags == M_OK && echo.length == selected);
    assert(n == MEDIA_HEADER + selected && !memcmp(reply + MEDIA_HEADER, data, selected));
    if (allocated_pool) {
        for (size_t i = 0; i < 16; i++)
            assert(allocated_pool[allocated_size + i] == 0xa7);
    }
    assert(pool_allocations == (fail_pool ? 2 : 1));

    /* Distinct pulses, bounded reboot window, validation, and deadline. */
    boot_config_t c = {0x45, 100, 80, 300, 1000};
    boot_repeat_t b;
    assert(boot_config_valid(&c));
    boot_repeat_arm(&b, &c, 0);
    boot_repeat_step(&b, 99, true);
    assert(!b.down);
    boot_repeat_step(&b, 100, true);
    assert(b.down);
    boot_repeat_step(&b, 179, true);
    assert(b.down);
    boot_repeat_step(&b, 180, true);
    assert(!b.down);
    boot_repeat_step(&b, 400, false);
    assert(!b.down);
    boot_repeat_step(&b, 500, true);
    assert(b.down);
    boot_repeat_step(&b, 1100, false);
    assert(!b.active && !b.down);
    c.interval = 80;
    assert(!boot_config_valid(&c));
    puts("PASS: protocol, async reads/write ACKs, prefetch, bounds, stale responses, bus/BOT "
         "reset, ejection, disconnect deadlines, BLE discovery policy, negotiated read-ahead/fallback, boot repetition");
}
