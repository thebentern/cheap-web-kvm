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

/* Kept well under the 300 ms the web UI waits for its ACK. */
#define KVM_HID_READY_TIMEOUT_MS 100

#define KVM_HID_TASK_STACK 4096
#define KVM_HID_TASK_PRIO  4

static QueueHandle_t s_evt_queue;
static volatile bool s_mounted;
static int64_t       s_last_report_us[KVM_HID_ITF_COUNT];

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

bool kvm_hid_mounted(void)
{
    return s_mounted;
}

static bool hid_wait_writable(uint8_t instance)
{
    const int64_t floor_us = (int64_t)KVM_MIN_REPORT_INTERVAL_MS * 1000;
    int64_t elapsed = esp_timer_get_time() - s_last_report_us[instance];
    if (elapsed < floor_us) {
        vTaskDelay(pdMS_TO_TICKS((floor_us - elapsed + 999) / 1000));
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

static void hid_send(uint8_t instance, uint8_t report_id, const void *report, uint16_t len)
{
    if (!s_mounted) {
        return;
    }
    if (!hid_wait_writable(instance)) {
        ESP_LOGW(TAG, "HID interface %u not writable, dropping report", instance);
        return;
    }
    if (!tud_hid_n_report(instance, report_id, report, len)) {
        ESP_LOGW(TAG, "tud_hid_n_report failed on interface %u", instance);
        return;
    }
    s_last_report_us[instance] = esp_timer_get_time();
}

/* Stops a key held when the link dropped from staying down on the target. */
static void hid_release_all(void)
{
    const kvm_kbd_report_t kbd = {0};
    hid_send(KVM_HID_ITF_KEYBOARD, 0, &kbd, sizeof(kbd));

    const kvm_mouse_rel_report_t rel = {0};
    hid_send(KVM_HID_ITF_MOUSE, KVM_REPORT_ID_MOUSE_REL, &rel, sizeof(rel));
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

uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id,
                               hid_report_type_t report_type, uint8_t *buffer,
                               uint16_t reqlen)
{
    (void)instance;
    (void)report_id;
    (void)report_type;
    (void)buffer;
    (void)reqlen;
    return 0;
}

/* Only OUT report is the keyboard LED state; the target owns it, so ignore. */
void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id,
                           hid_report_type_t report_type, const uint8_t *buffer,
                           uint16_t bufsize)
{
    (void)report_id;
    if (instance == KVM_HID_ITF_KEYBOARD && report_type == HID_REPORT_TYPE_OUTPUT &&
        bufsize >= 1) {
        ESP_LOGD(TAG, "keyboard LED state: 0x%02x", buffer[0]);
    }
}
