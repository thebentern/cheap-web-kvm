/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "media_protocol.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define MEDIA_WS_PREFIX 10
#define MEDIA_WS_MAX_PAYLOAD (MEDIA_HEADER + MEDIA_MAX_IO)
#define MEDIA_WS_MESSAGE_TIMEOUT_US INT64_C(10000000)
#define MEDIA_WS_MAX_FRAGMENTS 64
/* Bound TLS encryption scratch space independently of the disk request size. */
#define MEDIA_WS_SEND_CHUNK 4096
typedef struct {
    size_t length;
    unsigned fragments;
    int64_t deadline;
    bool active;
} media_ws_message_t;
/* Validate and reserve a binary/continuation fragment before receiving it.
 * Caller writes at the previous length (or zero for a new message). Bounded
 * total size, fragment count and deadline apply to the whole message. */
bool media_ws_message_accept(media_ws_message_t *message, uint8_t opcode, bool final,
                             size_t length, size_t capacity, int64_t now);
typedef int (*media_ws_send_fn)(void *context, const uint8_t *data, size_t length);

/* Payload begins at buffer + MEDIA_WS_PREFIX. The buffer must hold that prefix
 * and payload. Sends one final, unmasked binary frame, including short writes. */
bool media_ws_send_binary(uint8_t *buffer, size_t length, media_ws_send_fn send, void *context);

/* Final CLOSE with an application code (4000..4999) and a fixed UTF-8 reason
 * of at most 123 bytes. Uses its own buffer, leaving an owner's frame intact. */
bool media_ws_send_close(uint16_t code, const char *reason, media_ws_send_fn send, void *context);
