/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <stdint.h>

/* Boot-lifetime count of server handshakes that exceeded their total budget.
 * Thread-local guard state initializes automatically; no startup call needed. */
uint32_t media_tls_guard_timeouts(void);
