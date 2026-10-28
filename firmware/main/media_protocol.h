/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define MEDIA_HEADER 32
#define MEDIA_MAX_IO 131072
#define MEDIA_LEGACY_WIFI_MAX_IO 32768
#define MEDIA_SERIAL_MAX_IO 8192
#define MEDIA_VERSION 1
/* Header is explicitly encoded little endian; never cast a wire buffer. */
enum {
    M_HELLO = 1,
    M_INSERT,
    M_EJECT,
    M_ECHO,
    M_HEARTBEAT,
    M_STATUS,
    M_HID,
    M_BOOT,
    M_CANCEL,
    M_READ = 16,
    M_WRITE
};
enum { M_OK, M_INVALID, M_BUSY, M_STALE, M_IO, M_READ_ONLY, M_OFFLINE, M_PROTECTED };
enum { M_WRITABLE = 1, M_LOCAL = 2, M_PRESENT = 4, M_FAILED = 8, M_PREVENTED = 16, M_MACRO = 32 };
typedef struct {
    uint8_t op;
    uint16_t flags;
    uint32_t session, id;
    uint64_t offset;
    uint32_t length;
} media_msg_t;
uint32_t media_crc(const uint8_t *data, size_t len, uint32_t crc);
bool media_decode(const uint8_t *data, size_t len, media_msg_t *msg);
size_t media_encode(uint8_t *out, const media_msg_t *msg, const void *payload, size_t len);
bool media_range(uint64_t capacity, uint64_t offset, uint32_t length);
