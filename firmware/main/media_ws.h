/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "media_protocol.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define MEDIA_WS_PREFIX 4
#define MEDIA_WS_MAX_PAYLOAD (MEDIA_HEADER + MEDIA_MAX_IO)
typedef int (*media_ws_send_fn)(void *context, const uint8_t *data, size_t length);

/* Payload begins at buffer + MEDIA_WS_PREFIX. The buffer must hold that prefix
 * and payload. Sends one final, unmasked binary frame, including short writes. */
bool media_ws_send_binary(uint8_t *buffer, size_t length, media_ws_send_fn send, void *context);
