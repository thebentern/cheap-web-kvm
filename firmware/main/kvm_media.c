/* SPDX-License-Identifier: GPL-3.0-or-later
 * No filesystem on the device. One bounded, asynchronous request in flight.
 * Completion is deferred to the USB task and checked against the bus epoch
 * before touching TinyUSB's buffer. A reset can never complete a later CBW.
 */
#include "kvm_media.h"
#include "ch9329.h"
#include "device/dcd.h"
#include "device/usbd_pvt.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "kvm_boot.h"
#include "kvm_ble.h"
#include "media_buffers.h"
#include "kvm_hid.h"
#include "sdkconfig.h"
#include "tusb.h"
#include <stdatomic.h>
#include <string.h>
#define IO_TIMEOUT_US 10000000
#define LEASE_US 5000000
#if CONFIG_KVM_MEDIA_LOCAL_PROOF
extern const uint8_t proof_start[] asm("_binary_local_proof_img_start");
extern const uint8_t proof_end[] asm("_binary_local_proof_img_end");
#endif
static SemaphoreHandle_t lock;
static atomic_uint epoch;
static uint32_t session, next_id, observed_epoch;
static media_source_t owner;
static uint64_t capacity;
static atomic_uint max_io = MEDIA_SERIAL_MAX_IO;
static atomic_bool present, writable, failed, prevented, changed, connected;
static atomic_uint block_count;
static int64_t heartbeat;
static bool wifi_input_used;
static bool network_changing;
static struct {
    bool active, sent, done, completion;
    uint32_t id, epoch, length, usb_length;
    uint64_t offset;
    uint8_t op;
    int64_t deadline;
    uint8_t *usb;
    uint8_t *data;
    bool ok;
} io;
static uint8_t *cache;
static uint64_t cache_offset;
static uint32_t cache_length;
static uint8_t hid_reply[CH9329_MAX_PAYLOAD + 6];
static size_t hid_reply_len;
static media_metrics_t metrics;
static int64_t read_sent_at;
uint32_t kvm_media_max_io(void)
{
    return atomic_load(&connected) ? atomic_load(&max_io) : MEDIA_SERIAL_MAX_IO;
}
bool kvm_media_metrics(media_metrics_t *out)
{
    if (!out || !lock || xSemaphoreTake(lock, pdMS_TO_TICKS(5)) != pdTRUE)
        return false;
    *out = metrics;
    xSemaphoreGive(lock);
    return true;
}
static void hid_tx(const uint8_t *p, size_t n)
{
    memcpy(hid_reply, p, n);
    hid_reply_len = n;
}
/* HTTP calls are serialized by one server task. Parser never shares UART/BLE state. */
static ch9329_parser_t hid_parser;
static void invalidate(void)
{
    cache_length = 0;
    changed = true;
}
static void sync_reset(void)
{
    uint32_t current = atomic_load(&epoch);
    if (current != observed_epoch) {
        observed_epoch = current;
        io.active = false;
        prevented = false;
        invalidate();
    }
}
static void fail_link(media_failure_t reason)
{
    if (metrics.first_failure == MEDIA_FAILURE_NONE) {
        metrics.first_failure = reason;
        switch (reason) {
        case MEDIA_FAILURE_IO_TIMEOUT: metrics.io_timeouts++; break;
        case MEDIA_FAILURE_LEASE: metrics.lease_timeouts++; break;
        case MEDIA_FAILURE_BACKEND: metrics.backend_errors++; break;
        case MEDIA_FAILURE_DISCONNECT: metrics.disconnects++; break;
        default: break;
        }
    }
    if (wifi_input_used) {
        wifi_input_used = false;
        kvm_hid_release_link();
    }
    connected = false;
    owner = MEDIA_SOURCE_NONE;
    present = false;
    kvm_ble_set_wifi_media_active(false);
    failed = true;
    invalidate();
    if (io.active) {
        io.done = true;
        io.ok = false;
    }
}
static uint16_t state(void)
{
    return (present ? M_PRESENT : 0) | (writable ? M_WRITABLE : 0) | (failed ? M_FAILED : 0) |
           (prevented ? M_PREVENTED : 0) | (kvm_boot_active() ? M_MACRO : 0);
}
esp_err_t kvm_media_init(void)
{
    media_buffers_init();
    const media_buffers_t *buffers = media_buffers_get();
    io.data = buffers->io;
    cache = buffers->cache;
    lock = xSemaphoreCreateMutex();
    ch9329_parser_init(&hid_parser, hid_tx);
#if CONFIG_KVM_MEDIA_LOCAL_PROOF
    capacity = proof_end - proof_start;
    atomic_store(&block_count, capacity / 512);
    present = true;
    connected = true;
    changed = true;
#endif
    return lock ? ESP_OK : ESP_ERR_NO_MEM;
}
void tud_event_hook_cb(uint8_t rhport, uint32_t eventid, bool in_isr)
{
    (void)rhport;
    (void)in_isr;
    if (eventid == DCD_EVENT_BUS_RESET || eventid == DCD_EVENT_UNPLUGGED)
        atomic_fetch_add_explicit(&epoch, 1, memory_order_relaxed);
}
/* TinyUSB 0.21 has no application BOT-reset callback. Intercept just that
 * driver's control handler via --wrap, preserving its normal implementation. */
bool __real_mscd_control_xfer_cb(uint8_t rhport, uint8_t stage,
                                 const tusb_control_request_t *request);
bool __wrap_mscd_control_xfer_cb(uint8_t rhport, uint8_t stage,
                                 const tusb_control_request_t *request)
{
    if (stage == CONTROL_STAGE_SETUP && request->bmRequestType == 0x21 &&
        request->bRequest == 0xff && request->wIndex == 2 && !request->wLength && !request->wValue)
        atomic_fetch_add(&epoch, 1);
    return __real_mscd_control_xfer_cb(rhport, stage, request);
}
static void finish_usb(void *arg)
{
    uint32_t id = (uint32_t)(uintptr_t)arg;
    if (xSemaphoreTake(lock, 0) != pdTRUE) {
        usbd_defer_func(finish_usb, arg, false);
        return;
    }
    if (io.active && io.id == id) {
        io.completion = false;
        if (io.epoch != atomic_load(&epoch)) {
            io.active = false;
            cache_length = 0;
        } else if (io.done) {
            int32_t result = TUD_MSC_RET_ERROR;
            if (io.ok && present) {
                if (io.op == M_READ) {
                    memcpy(io.usb, io.data, io.usb_length);
                    memcpy(cache, io.data, io.length);
                    cache_offset = io.offset;
                    cache_length = io.length;
                }
                result = io.usb_length;
            }
            io.active = false;
            tud_msc_async_io_done(result, false);
        }
    }
    xSemaphoreGive(lock);
}
/* Network task polls even when disconnected, so USB timeouts are bounded. */
bool kvm_media_poll_from(media_source_t source, uint8_t *out, size_t *len)
{
    bool send = false;
    uint32_t defer_id = 0;
    if (xSemaphoreTake(lock, pdMS_TO_TICKS(5)) != pdTRUE)
        return false;
    sync_reset();
    int64_t now = esp_timer_get_time();
    if (io.active && io.epoch != atomic_load(&epoch)) {
        io.active = false;
        cache_length = 0;
        prevented = false;
    }
    /* An outstanding disk request owns its full bounded IO window. A delayed
     * idle heartbeat must not remove media while that request can still finish. */
    bool waiting = io.active && !io.done;
    if (connected && waiting && now > io.deadline)
        fail_link(MEDIA_FAILURE_IO_TIMEOUT);
#if !CONFIG_KVM_MEDIA_LOCAL_PROOF
    else if (connected && !waiting && now - heartbeat > LEASE_US)
        fail_link(MEDIA_FAILURE_LEASE);
#endif
    if (io.active) {
        if (io.done && !io.completion) {
            io.completion = true;
            defer_id = io.id;
        } else if (!io.done && !io.sent && owner == source) {
            media_msg_t m = {.op = io.op,
                             .session = session,
                             .id = io.id,
                             .offset = io.offset,
                             .length = io.length};
            *len = media_encode(out, &m, io.op == M_WRITE ? io.data : NULL,
                                io.op == M_WRITE ? io.length : 0);
            io.sent = true;
            if (io.op == M_READ)
                read_sent_at = now;
            send = true;
        }
    }
    xSemaphoreGive(lock);
    /* Queue submission can wait for the USB task to drain its queue. Never
     * hold the state mutex while waiting for that same task. */
    if (defer_id)
        usbd_defer_func(finish_usb, (void *)(uintptr_t)defer_id, false);
    return send;
}
bool kvm_media_network_change_begin(void)
{
    if (xSemaphoreTake(lock, pdMS_TO_TICKS(10)) != pdTRUE)
        return false;
    bool ok = !present && !io.active && !network_changing;
    if (ok)
        network_changing = true;
    xSemaphoreGive(lock);
    return ok;
}
void kvm_media_network_change_end(void)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    network_changing = false;
    xSemaphoreGive(lock);
}
void kvm_media_disconnect_from(media_source_t source)
{
    bool owned = false;
    if (xSemaphoreTake(lock, portMAX_DELAY) == pdTRUE) {
        if (owner == source) {
            owned = true;
            fail_link(MEDIA_FAILURE_DISCONNECT);
            prevented = false;
        }
        xSemaphoreGive(lock);
    }
    if (owned)
        kvm_boot_cancel();
}
void kvm_media_disconnect(void) { kvm_media_disconnect_from(MEDIA_SOURCE_HTTP); }
bool kvm_media_poll(uint8_t *out, size_t *len)
{
    return kvm_media_poll_from(MEDIA_SOURCE_HTTP, out, len);
}
size_t kvm_media_command(const uint8_t *in, size_t len, uint8_t *reply)
{
    return kvm_media_command_from(MEDIA_SOURCE_HTTP, in, len, reply);
}
size_t kvm_media_command_from(media_source_t source, const uint8_t *in, size_t n, uint8_t *out)
{
    media_msg_t m;
    if (!media_decode(in, n, &m))
        return 0; /* corrupt frames receive no acknowledgement */
    const uint8_t *p = in + 32;
    size_t pn = n - 32;
    if (xSemaphoreTake(lock, pdMS_TO_TICKS(10)) != pdTRUE)
        return 0;
    if (m.op == (M_READ | 0x80) || m.op == (M_WRITE | 0x80)) {
        if (m.length > max_io || pn > max_io) {
            xSemaphoreGive(lock);
            return 0;
        }
        if (owner == source && io.active && !io.done && m.session == session && m.id == io.id &&
            m.offset == io.offset && m.length == io.length && (m.op & 0x7f) == io.op &&
            io.epoch == atomic_load(&epoch)) {
            /* The HTTP task may have been occupied by a TLS handshake. Enforce
             * the same deadline even when a late reply arrives before polling. */
            if (esp_timer_get_time() > io.deadline) {
                fail_link(MEDIA_FAILURE_IO_TIMEOUT);
                xSemaphoreGive(lock);
                return 0;
            }
            io.ok = m.flags == M_OK && pn == (io.op == M_READ ? io.length : 0);
            /* A matching successful IO reply proves the owner is alive too.
             * Do not expire an active transfer solely because a browser's
             * heartbeat timer is delayed; the per-IO deadline still applies. */
            if (io.ok && io.sent)
                heartbeat = esp_timer_get_time();
            if (io.ok && io.op == M_READ) {
                memcpy(io.data, p, pn);
                if (io.sent) {
                    uint64_t elapsed = (uint64_t)(esp_timer_get_time() - read_sent_at);
                    metrics.reads++;
                    metrics.read_bytes += pn;
                    metrics.read_time_us += elapsed;
                    if (elapsed > metrics.read_max_us)
                        metrics.read_max_us = elapsed;
                }
            }
            io.done = true;
            if (!io.ok)
                fail_link(MEDIA_FAILURE_BACKEND);
        }
        xSemaphoreGive(lock);
        return 0;
    }
    uint16_t status = M_OK;
    uint8_t payload[CH9329_MAX_PAYLOAD + 6];
    size_t payload_n = 0;
    uint64_t reply_offset = m.offset;
    if (source == MEDIA_SOURCE_NONE || (connected && owner != source))
        status = M_BUSY;
    else if (m.op != M_HELLO && (!connected || owner != source || m.session != session))
        status = M_STALE;
    else if (m.length > max_io || pn > max_io)
        status = M_INVALID;
    else
        switch (m.op) {
        case M_HELLO: {
            if (m.offset && (m.offset < MEDIA_SERIAL_MAX_IO || m.offset > MEDIA_MAX_IO || m.offset % 512)) {
                status = M_INVALID;
                break;
            }
            if (pn || m.length || present || io.active) {
                status = M_BUSY;
                break;
            }
            session = esp_random();
            if (!session)
                session = 1;
            uint32_t selected = m.offset ? (uint32_t)m.offset : MEDIA_SERIAL_MAX_IO;
            uint32_t available = source == MEDIA_SOURCE_SERIAL ? MEDIA_SERIAL_MAX_IO : media_buffers_get()->max_io;
            if (selected > available)
                selected = available;
            atomic_store(&max_io, selected);
            connected = true;
            owner = source;
            memset(&metrics, 0, sizeof(metrics));
            heartbeat = esp_timer_get_time();
            failed = false;
            payload[0] = MEDIA_VERSION;
            payload[1] = 1; /* async / durable-write protocol */
            payload[2] = 0;
            payload[3] = 2; /* block size 512 LE */
            payload[4] = (uint8_t)max_io;
            payload[5] = (uint8_t)(max_io >> 8);
            payload[6] = 1;
            payload[7] = source == MEDIA_SOURCE_SERIAL ? 1 : 0; /* transport hint */
            payload_n = 8;
            break;
        }
        case M_INSERT:
            if (pn || m.length || (m.flags & ~M_WRITABLE) || m.offset < 512 || m.offset % 512 ||
                m.offset / 512 > UINT32_MAX)
                status = M_INVALID;
            else if (present || io.active || prevented || network_changing)
                status = M_BUSY;
            else {
                capacity = m.offset;
                atomic_store(&block_count, capacity / 512);
                writable = m.flags & M_WRITABLE;
                present = true;
                kvm_ble_set_wifi_media_active(owner == MEDIA_SOURCE_HTTP);
                failed = false;
                invalidate();
            }
            break;
        case M_EJECT:
            if (pn || m.length)
                status = M_INVALID;
            else if (prevented)
                status = M_PROTECTED;
            else if (io.active)
                status = M_BUSY;
            else {
                present = false;
                kvm_ble_set_wifi_media_active(false);
                failed = false;
                invalidate();
            }
            break;
        case M_ECHO:
            /* Echo is handled outside this small control buffer below. */
            if (pn != m.length)
                status = M_INVALID;
            break;
        case M_HEARTBEAT:
        case M_STATUS:
            if (pn || m.length)
                status = M_INVALID;
            else {
                heartbeat = esp_timer_get_time();
                reply_offset = capacity;
                payload[0] = state();
                payload_n = 1;
            }
            break;
        case M_HID:
            if (pn != m.length || pn > CH9329_MAX_PAYLOAD + 6 || pn < 6 || p[0] != CH9329_HDR0 ||
                p[1] != CH9329_HDR1 || pn != (size_t)p[4] + 6) {
                status = M_INVALID;
                break;
            }
            /* Fresh parser for each complete frame; no partial-command smuggling. */
            /* Configuration commands can acquire the network-change gate.
             * Never dispatch them while holding the media state mutex. */
            xSemaphoreGive(lock);
            ch9329_parser_init(&hid_parser, hid_tx);
            hid_reply_len = 0;
            for (size_t i = 0; i < pn; i++)
                ch9329_parser_feed(&hid_parser, p[i]);
            xSemaphoreTake(lock, portMAX_DELAY);
            if (!hid_reply_len)
                status = M_INVALID;
            else {
                if (p[3] == CH9329_CMD_RESET)
                    wifi_input_used = false;
                else if (p[3] == CH9329_CMD_KEYBOARD || p[3] == CH9329_CMD_MOUSE_ABS ||
                         p[3] == CH9329_CMD_MOUSE_REL)
                    wifi_input_used = true;
                memcpy(payload, hid_reply, hid_reply_len);
                payload_n = hid_reply_len;
            }
            break;
        case M_BOOT:
            if (pn != 17 || m.length != 17)
                status = M_INVALID;
            else {
                uint32_t t[4];
                for (int j = 0; j < 4; j++) {
                    t[j] = 0;
                    for (int i = 0; i < 4; i++)
                        t[j] |= (uint32_t)p[1 + 4 * j + i] << (8 * i);
                }
                if (!kvm_boot_arm(p[0], t[0], t[1], t[2], t[3]))
                    status = M_INVALID;
            }
            break;
        case M_CANCEL:
            if (pn || m.length)
                status = M_INVALID;
            else
                kvm_boot_cancel();
            break;
        default:
            status = M_INVALID;
            break;
        }
    media_msg_t r = {.op = m.op | 0x80,
                     .flags = status,
                     .session = session,
                     .id = m.id,
                     .offset = reply_offset,
                     .length = payload_n};
    size_t result;
    if (m.op == M_ECHO && status == M_OK) {
        r.length = pn;
        result = media_encode(out, &r, p, pn);
    } else
        result = media_encode(out, &r, payload, payload_n);
    xSemaphoreGive(lock);
    return result;
}
static bool ready(uint8_t lun)
{
    if (lun || !present || failed || !connected) {
        tud_msc_set_sense(lun, SCSI_SENSE_NOT_READY, 0x3a, 0);
        return false;
    }
    return true;
}
void tud_msc_inquiry_cb(uint8_t lun, uint8_t vendor[8], uint8_t product[16], uint8_t rev[4])
{
    (void)lun;
    memcpy(vendor, "$KVM    ", 8);
    memcpy(product, "Client disk     ", 16);
    memcpy(rev, "0001", 4);
}
bool tud_msc_test_unit_ready_cb(uint8_t lun)
{
    /* Readiness/write protection/capacity must not transiently change merely
     * because a network control owns the short state mutex. */
    if (!ready(lun))
        return false;
    if (atomic_exchange(&changed, false)) {
        tud_msc_set_sense(lun, SCSI_SENSE_UNIT_ATTENTION, 0x28, 0);
        return false;
    }
    return true;
}
void tud_msc_capacity_cb(uint8_t lun, uint32_t *count, uint16_t *size)
{
    *size = 512;
    *count = !lun && present && connected && !failed ? atomic_load(&block_count) : 0;
}
bool tud_msc_is_writable_cb(uint8_t lun)
{
    return !lun && present && connected && !failed && writable;
}
static int32_t transfer(uint8_t lun, uint32_t lba, uint32_t off, void *buf, uint32_t n, bool write)
{
    if (xSemaphoreTake(lock, 0) != pdTRUE)
        return TUD_MSC_RET_BUSY;
    sync_reset();
    uint64_t address = (uint64_t)lba * 512 + off;
    int32_t result = TUD_MSC_RET_ERROR;
    if (!ready(lun) || n > max_io || !media_range(capacity, address, n) || (write && !writable))
        goto done;
    if (io.active && io.epoch != atomic_load(&epoch)) {
        io.active = false;
        cache_length = 0;
    }
    if (io.active) {
        result = TUD_MSC_RET_BUSY;
        goto done;
    }
#if CONFIG_KVM_MEDIA_LOCAL_PROOF
    if (!write) {
        memcpy(buf, proof_start + address, n);
        result = n;
        goto done;
    }
#endif
    if (!write && cache_length && address >= cache_offset &&
        address + n <= cache_offset + cache_length) {
        memcpy(buf, cache + (address - cache_offset), n);
        metrics.cache_bytes += n;
        result = n;
        goto done;
    }
    cache_length = 0;
    io.active = true;
    io.sent = false;
    io.done = false;
    io.completion = false;
    io.ok = false;
    io.id = ++next_id;
    if (!io.id)
        io.id = ++next_id;
    io.epoch = atomic_load(&epoch);
    io.offset = address;
    io.usb_length = n;
    io.length = write ? n
                      : (uint32_t)((capacity - address) < max_io ? (capacity - address) : max_io);
    io.op = write ? M_WRITE : M_READ;
    io.deadline = esp_timer_get_time() + IO_TIMEOUT_US;
    io.usb = buf;
    if (write)
        memcpy(io.data, buf, n);
    result = TUD_MSC_RET_ASYNC;
done:
    xSemaphoreGive(lock);
    return result;
}
int32_t tud_msc_read10_cb(uint8_t lun, uint32_t lba, uint32_t off, void *buf, uint32_t n)
{
    return transfer(lun, lba, off, buf, n, false);
}
int32_t tud_msc_write10_cb(uint8_t lun, uint32_t lba, uint32_t off, uint8_t *buf, uint32_t n)
{
    return transfer(lun, lba, off, buf, n, true);
}
bool tud_msc_start_stop_cb(uint8_t lun, uint8_t power, bool start, bool eject)
{
    (void)power;
    if (lun)
        return false;
    if (xSemaphoreTake(lock, 0) != pdTRUE)
        return false;
    bool ok = !io.active && !(eject && !start && prevented);
    if (ok && eject && !start) {
        present = false;
        kvm_ble_set_wifi_media_active(false);
        invalidate();
    }
    /* A target cannot insert an ejected browser source without consent. */
    if (eject && start && !present)
        ok = false;
    xSemaphoreGive(lock);
    return ok;
}
bool tud_msc_prevent_allow_medium_removal_cb(uint8_t lun, uint8_t prohibit, uint8_t control)
{
    (void)control;
    if (lun || prohibit > 1 || xSemaphoreTake(lock, 0) != pdTRUE)
        return false;
    prevented = prohibit;
    xSemaphoreGive(lock);
    return true;
}
int32_t tud_msc_scsi_cb(uint8_t lun, const uint8_t cmd[16], void *buf, uint16_t n)
{
    (void)buf;
    (void)n;
    /* Every successful WRITE10 is already durable. No volatile write cache. */
    if (cmd[0] == 0x35 && xSemaphoreTake(lock, 0) == pdTRUE) {
        bool ok = ready(lun) && !io.active;
        xSemaphoreGive(lock);
        return ok ? 0 : -1;
    }
    tud_msc_set_sense(lun, SCSI_SENSE_ILLEGAL_REQUEST, 0x20, 0);
    return -1;
}
