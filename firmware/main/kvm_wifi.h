/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "esp_err.h"
#include <stddef.h>
#include <stdint.h>
#define KVM_CMD_WIFI_GET 0x35
#define KVM_CMD_WIFI_STAGE 0x36
#define KVM_CMD_WIFI_APPLY 0x37
#define KVM_CMD_WIFI_STATUS 0x38
/* Returns CH9329 error code, or 0; no saved router password is ever returned. */
uint8_t kvm_wifi_command(const void *owner, uint8_t cmd, const uint8_t *in, size_t len,
                         uint8_t out[64], uint8_t *out_len);
esp_err_t kvm_wifi_start(void);
