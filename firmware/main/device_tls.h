/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>

/* Call only after Wi-Fi/BLE enables the hardware entropy source, with HTTPS
 * stopped. NULL/0.0.0.0 addresses omit that IPv4 SAN. The per-device trust CA and
 * private server key survive DHCP changes; only the signed leaf is renewed.
 * NVS errors are fatal: an unpersisted replacement identity is never exposed. */
esp_err_t device_tls_prepare(const uint8_t client_ipv4[4], const uint8_t ap_ipv4[4]);
/* Serialized with prepare: renews oversized legacy leaves or within 30 days of
 * expiry. A missing RTC uses build time and the persisted leaf as a fallback. */
bool device_tls_needs_renewal(void);
/* Stable name derived from the factory Wi-Fi MAC; does not itself publish mDNS. */
const char *device_tls_hostname(void);
/* NULL until prepare succeeds. PEM lengths for esp_https_server include NUL. */
const char *device_tls_certificate(void);
const char *device_tls_private_key(void);
const char *device_tls_trust_certificate(void);
/* SHA-256 of the DER trust certificate, lowercase hex (64 characters). */
const char *device_tls_fingerprint(void);
