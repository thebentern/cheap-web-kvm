/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "esp_err.h"
#include "media_protocol.h"
/* Initialize before USB; Wi-Fi starts separately after NVS. */
esp_err_t kvm_media_init(void);
esp_err_t kvm_media_network_start(void);
/* Only the session owner receives requests or may release the medium.
 * Reply may alias the input when that buffer has full frame capacity. */
typedef enum { MEDIA_SOURCE_NONE, MEDIA_SOURCE_HTTP, MEDIA_SOURCE_SERIAL } media_source_t;
size_t kvm_media_command_from(media_source_t source, const uint8_t *in, size_t len, uint8_t *reply);
bool kvm_media_poll_from(media_source_t source, uint8_t *out, size_t *len);
void kvm_media_disconnect_from(media_source_t source);
/* Compatibility entry points use the HTTP source. */
size_t kvm_media_command(const uint8_t *in, size_t len, uint8_t *reply);
bool kvm_media_poll(uint8_t *out, size_t *len);
void kvm_media_disconnect(void);

/* Reserve a disk-free window while changing the network, blocking insertion. */
bool kvm_media_network_change_begin(void);
void kvm_media_network_change_end(void);
/* Owned by the Wi-Fi settings task; stop joins the HTTP task before restart. */
esp_err_t kvm_media_http_start(const char *token);
esp_err_t kvm_media_https_ensure(const uint8_t client_ip[4], const uint8_t ap_ip[4]);
void kvm_media_http_stop(void);
