/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "boot_repeat.h"
#include "ch9329.h"
#include "kvm_media.h"
#include "tusb.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
int64_t mock_time;
int mock_lock_depth;
static unsigned completed, hid_frames;
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
int main(void)
{
    assert(media_crc((const uint8_t *)"123456789", 9, 0xffffffff) == (0xcbf43926 ^ 0xffffffff));
    assert(media_range(UINT64_C(1) << 40, (UINT64_C(1) << 40) - 512, 512));
    assert(!media_range(512, 511, 2));
    assert(kvm_media_init() == ESP_OK);
    media_msg_t m = command(M_HELLO, 0, 0);
    assert(!m.flags);
    session = m.session;
    assert(command(M_INSERT, M_WRITABLE, 1024 * 1024).flags == M_OK);
    assert(!tud_msc_test_unit_ready_cb(0));
    assert(tud_msc_test_unit_ready_cb(0));
    uint8_t usb[4096];
    memset(usb, 0xcc, sizeof(usb));
    memset(data, 0x5a, sizeof(data));
    assert(tud_msc_read10_cb(0, 0, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request();
    assert(m.length == 8192);
    media_msg_t stale = m;
    stale.id++;
    answer(stale, M_OK);
    assert(!completed && usb[0] == 0xcc);
    answer(m, M_OK);
    assert(!completed);
    finish();
    assert(completed == 1 && completion == 4096 && usb[0] == 0x5a);
    /* Read-ahead cache satisfies adjacent requests with no network operation. */
    assert(tud_msc_read10_cb(0, 8, 0, usb, sizeof(usb)) == 4096);
    memset(usb, 0x72, sizeof(usb));
    assert(tud_msc_write10_cb(0, 8, 0, usb, sizeof(usb)) == TUD_MSC_RET_ASYNC);
    m = poll_request();
    assert(request[32] == 0x72);
    assert(command(M_EJECT, 0, 0).flags == M_BUSY);
    assert(completed == 1);
    answer(m, M_OK);
    finish();
    assert(completed == 2);
    /* Bus resets invalidate both pending response IDs and prevention state. */
    assert(tud_msc_prevent_allow_medium_removal_cb(0, 1, 0));
    assert(command(M_EJECT, 0, 0).flags == M_PROTECTED);
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
    mock_time += 3000001;
    finish();
    assert(completion == TUD_MSC_RET_ERROR);
    assert(!tud_msc_test_unit_ready_cb(0));
    m = command(M_HELLO, 0, 0);
    session = m.session;
    assert(command(M_INSERT, 0, 1024 * 1024).flags == M_OK);
    assert(tud_msc_write10_cb(0, 0, 0, usb, sizeof(usb)) == TUD_MSC_RET_ERROR);
    assert(command(M_EJECT, 0, 0).flags == M_OK);
    mock_time += 5000001;
    size_t n;
    kvm_media_poll(request, &n);
    assert(command(M_STATUS, 0, 0).flags == M_STALE);
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
         "reset, ejection, disconnect deadlines, boot repetition");
}
