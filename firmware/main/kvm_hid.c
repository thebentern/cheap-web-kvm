/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * All tud_hid_* calls happen on this one task, so the UART parser never blocks
 * on USB and TinyUSB never blocks on us. */

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "tinyusb.h"
#include "tinyusb_default_config.h"

#include "kvm_hid.h"
#include "usb_descriptors.h"

static const char *TAG = "kvm_hid";

#define KVM_HID_QUEUE_DEPTH 64

/* Targets, BIOS firmware especially, drop characters when reports arrive faster
 * than this. The endpoint interval is also 10 ms, so it rarely adds delay. */
#define KVM_MIN_REPORT_INTERVAL_MS 10

/* Must stay under CH9329_POST_TIMEOUT_MS, or a stalled endpoint on one
 * interface backs the shared queue up and turns host ACKs into errors. */
#define KVM_HID_READY_TIMEOUT_MS 40

#define KVM_HID_TASK_STACK 4096
#define KVM_HID_TASK_PRIO  4

static QueueHandle_t   s_evt_queue;
static volatile bool   s_mounted;
static volatile uint8_t s_kbd_leds;
static int64_t         s_last_report_us[KVM_HID_ITF_COUNT];

typedef struct __attribute__((packed)) {
    uint8_t modifier;
    uint8_t reserved;
    uint8_t keycode[6];
} kvm_kbd_report_t;

typedef struct __attribute__((packed)) {
    uint8_t  buttons;
    uint16_t x;
    uint16_t y;
    int8_t   wheel;
} kvm_mouse_abs_report_t;

typedef struct __attribute__((packed)) {
    uint8_t buttons;
    int8_t  dx;
    int8_t  dy;
    int8_t  wheel;
} kvm_mouse_rel_report_t;

_Static_assert(sizeof(kvm_kbd_report_t) == 8, "boot keyboard report must be 8 bytes");
_Static_assert(sizeof(kvm_mouse_abs_report_t) == 6, "absolute mouse report must be 6 bytes");
_Static_assert(sizeof(kvm_mouse_rel_report_t) == 4, "relative mouse report must be 4 bytes");

/* Last report sent on each path, so Get_Report can be answered and so
 * hid_release_all() can clear buttons without moving the pointer. */
static kvm_kbd_report_t       s_last_kbd;
static kvm_mouse_abs_report_t s_last_abs;
static kvm_mouse_rel_report_t s_last_rel;

bool kvm_hid_mounted(void)
{
    return s_mounted;
}

uint8_t kvm_hid_leds(void)
{
    return s_kbd_leds;
}

static bool hid_wait_writable(uint8_t instance)
{
    const int64_t floor_us = (int64_t)KVM_MIN_REPORT_INTERVAL_MS * 1000;
    int64_t elapsed = esp_timer_get_time() - s_last_report_us[instance];
    if (elapsed < floor_us) {
        vTaskDelay(pdMS_TO_TICKS((floor_us - elapsed + 999) / 1000));
    }

    /* tud_hid_n_ready() goes false on bus suspend while s_mounted stays true,
     * so without this every event would burn the whole timeout and be dropped. */
    if (tud_suspended()) {
        if (!tud_remote_wakeup()) {
            return false;
        }
    }

    const TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(KVM_HID_READY_TIMEOUT_MS);
    while (!tud_hid_n_ready(instance)) {
        if (!s_mounted || xTaskGetTickCount() >= deadline) {
            return false;
        }
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    return true;
}

static bool hid_send(uint8_t instance, uint8_t report_id, const void *report, uint16_t len)
{
    if (!s_mounted) {
        return false;
    }
    if (!hid_wait_writable(instance)) {
        ESP_LOGW(TAG, "HID interface %u not writable, dropping report", instance);
        return false;
    }
    if (!tud_hid_n_report(instance, report_id, report, len)) {
        ESP_LOGW(TAG, "tud_hid_n_report failed on interface %u", instance);
        return false;
    }
    s_last_report_us[instance] = esp_timer_get_time();
    return true;
}

/* Stops a key or button held when the link dropped from staying down on the
 * target. Both pointer report IDs are separate top-level collections, so hosts
 * track their button state independently and both must be cleared. The absolute
 * report keeps its last position so clearing does not fling the cursor. */
static void hid_release_all(void)
{
    memset(&s_last_kbd, 0, sizeof(s_last_kbd));
    hid_send(KVM_HID_ITF_KEYBOARD, 0, &s_last_kbd, sizeof(s_last_kbd));

    s_last_abs.buttons = 0;
    s_last_abs.wheel   = 0;
    hid_send(KVM_HID_ITF_MOUSE, KVM_REPORT_ID_MOUSE_ABS, &s_last_abs, sizeof(s_last_abs));

    memset(&s_last_rel, 0, sizeof(s_last_rel));
    hid_send(KVM_HID_ITF_MOUSE, KVM_REPORT_ID_MOUSE_REL, &s_last_rel, sizeof(s_last_rel));
}

/* The web UI puts modifier usages (0xE0-0xE7) in the keycode array instead of
 * the modifier byte - paste-box.js sends Shift as SendKeyboardPress(16), which
 * maps to usage 0xE1 and lands in a keycode slot. Boot-protocol consumers only
 * read the modifier byte, so a BIOS would see lowercase for every shifted
 * character. Fold them across; the resulting report is strictly more standard
 * and identical for hosts that already handled the array form. */
static void fold_array_modifiers(kvm_kbd_report_t *report)
{
    uint8_t keys[6] = {0};
    uint8_t n = 0;

    for (int i = 0; i < 6; i++) {
        uint8_t k = report->keycode[i];
        if (k == 0) {
            continue;
        }
        if (k >= 0xE0 && k <= 0xE7) {
            report->modifier |= (uint8_t)(1u << (k - 0xE0));
        } else if (n < sizeof(keys)) {
            keys[n++] = k;
        }
    }
    memcpy(report->keycode, keys, sizeof(keys));
}

static void kvm_hid_task(void *arg)
{
    (void)arg;
    kvm_event_t evt;

    for (;;) {
        if (xQueueReceive(s_evt_queue, &evt, portMAX_DELAY) != pdTRUE) {
            continue;
        }

        switch (evt.type) {
        case KVM_EVT_KEYBOARD: {
            kvm_kbd_report_t report = {
                .modifier = evt.kbd.modifier,
                .reserved = 0,
            };
            memcpy(report.keycode, evt.kbd.keys, sizeof(report.keycode));
            fold_array_modifiers(&report);
            s_last_kbd = report;
            hid_send(KVM_HID_ITF_KEYBOARD, 0, &report, sizeof(report));
            break;
        }

        case KVM_EVT_MOUSE_ABS: {
            uint16_t x = evt.abs.x > KVM_ABS_LOGICAL_MAX ? KVM_ABS_LOGICAL_MAX : evt.abs.x;
            uint16_t y = evt.abs.y > KVM_ABS_LOGICAL_MAX ? KVM_ABS_LOGICAL_MAX : evt.abs.y;
            const kvm_mouse_abs_report_t report = {
                .buttons = evt.abs.buttons,
                .x       = x,
                .y       = y,
                .wheel   = evt.abs.wheel,
            };
            s_last_abs = report;
            hid_send(KVM_HID_ITF_MOUSE, KVM_REPORT_ID_MOUSE_ABS, &report, sizeof(report));
            break;
        }

        case KVM_EVT_MOUSE_REL: {
            const kvm_mouse_rel_report_t report = {
                .buttons = evt.rel.buttons,
                .dx      = evt.rel.dx,
                .dy      = evt.rel.dy,
                .wheel   = evt.rel.wheel,
            };
            s_last_rel = report;
            hid_send(KVM_HID_ITF_MOUSE, KVM_REPORT_ID_MOUSE_REL, &report, sizeof(report));
            break;
        }

        case KVM_EVT_RESET:
            hid_release_all();
            break;

        default:
            break;
        }
    }
}

esp_err_t kvm_hid_post(const kvm_event_t *evt, uint32_t timeout_ms)
{
    if (evt == NULL || s_evt_queue == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xQueueSend(s_evt_queue, evt, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    return ESP_OK;
}

static void kvm_usb_event_cb(tinyusb_event_t *event, void *arg)
{
    (void)arg;
    switch (event->id) {
    case TINYUSB_EVENT_ATTACHED:
        s_mounted = true;
        ESP_LOGI(TAG, "target enumerated the HID device");
        /* Clear state left over from before the target power cycled. */
        if (s_evt_queue != NULL) {
            const kvm_event_t reset_evt = {.type = KVM_EVT_RESET};
            xQueueSend(s_evt_queue, &reset_evt, 0);
        }
        break;
    case TINYUSB_EVENT_DETACHED:
        s_mounted = false;
        s_kbd_leds = 0;
        ESP_LOGW(TAG, "target detached (powered off or unplugged)");
        break;
    default:
        break;
    }
}

esp_err_t kvm_hid_start(void)
{
    s_evt_queue = xQueueCreate(KVM_HID_QUEUE_DEPTH, sizeof(kvm_event_t));
    if (s_evt_queue == NULL) {
        return ESP_ERR_NO_MEM;
    }

    kvm_usb_descriptors_init();

    int string_count = 0;
    const char **strings = kvm_usb_string_descriptors(&string_count);

    tinyusb_config_t tusb_cfg = TINYUSB_DEFAULT_CONFIG(kvm_usb_event_cb, NULL);
    tusb_cfg.descriptor.device            = kvm_usb_device_descriptor();
    tusb_cfg.descriptor.string            = strings;
    tusb_cfg.descriptor.string_count      = string_count;
    tusb_cfg.descriptor.full_speed_config = kvm_usb_config_descriptor();

    esp_err_t err = tinyusb_driver_install(&tusb_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "tinyusb_driver_install failed: %s", esp_err_to_name(err));
        vQueueDelete(s_evt_queue);
        s_evt_queue = NULL;
        return err;
    }

    if (xTaskCreate(kvm_hid_task, "kvm_hid", KVM_HID_TASK_STACK, NULL,
                    KVM_HID_TASK_PRIO, NULL) != pdPASS) {
        ESP_LOGE(TAG, "failed to create HID task");
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "USB HID started");
    return ESP_OK;
}

/* Get_Report is a mandatory HID class request; returning 0 would STALL EP0. */
uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id,
                               hid_report_type_t report_type, uint8_t *buffer,
                               uint16_t reqlen)
{
    const void *src = NULL;
    uint16_t len = 0;

    if (report_type == HID_REPORT_TYPE_INPUT) {
        if (instance == KVM_HID_ITF_KEYBOARD) {
            src = &s_last_kbd;
            len = sizeof(s_last_kbd);
        } else if (instance == KVM_HID_ITF_MOUSE) {
            if (report_id == KVM_REPORT_ID_MOUSE_ABS) {
                src = &s_last_abs;
                len = sizeof(s_last_abs);
            } else if (report_id == KVM_REPORT_ID_MOUSE_REL) {
                src = &s_last_rel;
                len = sizeof(s_last_rel);
            }
        }
    } else if (report_type == HID_REPORT_TYPE_OUTPUT &&
               instance == KVM_HID_ITF_KEYBOARD) {
        static uint8_t leds;
        leds = s_kbd_leds;
        src  = &leds;
        len  = sizeof(leds);
    }

    if (src == NULL || len > reqlen) {
        return 0;
    }
    memcpy(buffer, src, len);
    return len;
}

/* Only OUT report is the keyboard LED state; kept so CH9329 GET_INFO can
 * report it. */
void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id,
                           hid_report_type_t report_type, const uint8_t *buffer,
                           uint16_t bufsize)
{
    (void)report_id;
    if (instance == KVM_HID_ITF_KEYBOARD && report_type == HID_REPORT_TYPE_OUTPUT &&
        bufsize >= 1) {
        s_kbd_leds = buffer[0];
    }
}
