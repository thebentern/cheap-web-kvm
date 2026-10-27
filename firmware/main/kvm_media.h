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

typedef enum {
    MEDIA_FAILURE_NONE,
    MEDIA_FAILURE_IO_TIMEOUT,
    MEDIA_FAILURE_LEASE,
    MEDIA_FAILURE_BACKEND,
    MEDIA_FAILURE_DISCONNECT,
} media_failure_t;

/* Successful remote READ replies only. Timing starts when the request is
 * handed to the transport and ends after its reply passes protocol validation.
 * Failure counters identify the first failure, before cascading cleanup.
 * Reset on HELLO; no image data, names, or offsets are exposed. */
typedef struct {
    uint64_t read_bytes, read_time_us, read_max_us, cache_bytes;
    uint32_t reads;
    uint32_t io_timeouts, lease_timeouts, backend_errors, disconnects;
    media_failure_t first_failure;
} media_metrics_t;
bool kvm_media_metrics(media_metrics_t *out);

/* Reserve a disk-free window while changing the network, blocking insertion. */
bool kvm_media_network_change_begin(void);
void kvm_media_network_change_end(void);
/* Owned by the Wi-Fi settings task; stop joins the HTTP task before restart. */
esp_err_t kvm_media_http_start(const char *token);
esp_err_t kvm_media_https_ensure(const uint8_t client_ip[4], const uint8_t ap_ip[4]);
void kvm_media_http_stop(void);
