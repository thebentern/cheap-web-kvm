/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "esp_err.h"
#include "tusb.h"
enum { TINYUSB_EVENT_ATTACHED = 1, TINYUSB_EVENT_DETACHED = 2 };
typedef struct { int id; } tinyusb_event_t;
typedef void (*tinyusb_event_cb_t)(tinyusb_event_t *, void *);
typedef struct {
    struct {
        const tusb_desc_device_t *device;
        const char **string;
        int string_count;
        const uint8_t *full_speed_config;
    } descriptor;
    tinyusb_event_cb_t event_cb;
    void *event_arg;
} tinyusb_config_t;
esp_err_t tinyusb_driver_install(const tinyusb_config_t *config);
