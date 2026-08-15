/* SPDX-License-Identifier: GPL-3.0-or-later */

#pragma once

#include <stdint.h>

#include "tusb.h"

#include "kvm_hid.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Call before tinyusb_driver_install(); fills the serial number from the MAC. */
void kvm_usb_descriptors_init(void);

const tusb_desc_device_t *kvm_usb_device_descriptor(void);
const uint8_t *kvm_usb_config_descriptor(void);
const char **kvm_usb_string_descriptors(int *count);

#ifdef __cplusplus
}
#endif
