/* SPDX-License-Identifier: GPL-3.0-or-later */

#pragma once

#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Starts advertising the KVM GATT service. Needs NVS initialised first: the
 * controller keeps PHY calibration there and NimBLE keeps bonds there. */
esp_err_t kvm_ble_start(void);

/* The passkey a new host must enter to pair: the one saved in NVS, else
 * CONFIG_KVM_BLE_PASSKEY. */
uint32_t kvm_ble_passkey(void);

/* Saves a new passkey (0..999999) to NVS and uses it for every pairing from
 * now on. Hosts already bonded keep their bond. Safe from any task once NVS is
 * initialised; returns ESP_ERR_INVALID_ARG past six digits. */
esp_err_t kvm_ble_set_passkey(uint32_t passkey);

#ifdef __cplusplus
}
#endif
