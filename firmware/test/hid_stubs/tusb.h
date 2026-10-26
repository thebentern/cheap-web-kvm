/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <stdbool.h>
#include <stdint.h>
typedef struct { uint8_t unused; } tusb_desc_device_t;
typedef enum {
    HID_REPORT_TYPE_INPUT = 1,
    HID_REPORT_TYPE_OUTPUT = 2,
    HID_REPORT_TYPE_FEATURE = 3,
} hid_report_type_t;
enum { HID_PROTOCOL_BOOT = 0, HID_PROTOCOL_REPORT = 1 };
bool tud_mounted(void);
bool tud_suspended(void);
bool tud_remote_wakeup(void);
bool tud_hid_n_ready(uint8_t instance);
uint8_t tud_hid_n_get_protocol(uint8_t instance);
bool tud_hid_n_report(uint8_t instance, uint8_t report_id, const void *report, uint16_t len);
