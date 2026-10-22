/* SPDX-License-Identifier: GPL-3.0-or-later */

#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Starts advertising the KVM GATT service. Needs NVS initialised first: the
 * controller keeps PHY calibration there and NimBLE keeps bonds there. */
esp_err_t kvm_ble_start(void);

#ifdef __cplusplus
}
#endif
