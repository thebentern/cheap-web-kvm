/* SPDX-License-Identifier: GPL-3.0-or-later */

#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Keyboard must stay at instance 0: some UEFI HID stacks only bind interface 0. */
enum {
    KVM_HID_ITF_KEYBOARD = 0,
    KVM_HID_ITF_MOUSE    = 1,
    KVM_HID_ITF_COUNT,
};

enum {
    KVM_REPORT_ID_MOUSE_ABS = 1,
    KVM_REPORT_ID_MOUSE_REL = 2,
};

/* Matches the range the web UI puts on the wire, so no rescaling is needed. */
#define KVM_ABS_LOGICAL_MAX 4095

typedef enum {
    KVM_EVT_KEYBOARD,
    KVM_EVT_MOUSE_ABS,
    KVM_EVT_MOUSE_REL,
    KVM_EVT_RESET,
} kvm_evt_type_t;

typedef struct {
    uint8_t modifier;
    uint8_t keys[6];
} kvm_kbd_evt_t;

typedef struct {
    uint8_t  buttons;
    uint16_t x;
    uint16_t y;
    int8_t   wheel;
} kvm_mouse_abs_evt_t;

typedef struct {
    uint8_t buttons;
    int8_t  dx;
    int8_t  dy;
    int8_t  wheel;
} kvm_mouse_rel_evt_t;

typedef struct {
    kvm_evt_type_t type;
    union {
        kvm_kbd_evt_t       kbd;
        kvm_mouse_abs_evt_t abs;
        kvm_mouse_rel_evt_t rel;
    };
} kvm_event_t;

esp_err_t kvm_hid_start(void);

/* Returns ESP_ERR_TIMEOUT if the queue stayed full. Never blocks the caller
 * longer than timeout_ms. */
esp_err_t kvm_hid_post(const kvm_event_t *evt, uint32_t timeout_ms);

bool kvm_hid_mounted(void);

/* Keyboard LED bitmap last pushed by the target (Num/Caps/Scroll Lock). */
uint8_t kvm_hid_leds(void);

#ifdef __cplusplus
}
#endif
