/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "esp_err.h"
#include "media_protocol.h"
/* Initialize before USB; Wi-Fi starts separately after NVS. */
esp_err_t kvm_media_init(void);
esp_err_t kvm_media_network_start(void);
/* Called by the network owner task. No USB calls or unbounded waits. */
size_t kvm_media_command(const uint8_t *in, size_t len, uint8_t *reply);
bool kvm_media_poll(uint8_t *out, size_t *len);
void kvm_media_disconnect(void);
