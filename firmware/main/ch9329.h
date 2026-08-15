/* SPDX-License-Identifier: GPL-3.0-or-later */

#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Frame: 0x57 0xAB <addr> <cmd> <len> <payload...> <checksum>
 * checksum = sum of every preceding byte, mod 256. See docs/PROTOCOL.md. */
#define CH9329_HDR0 0x57
#define CH9329_HDR1 0xAB

#define CH9329_CMD_GET_INFO  0x01
#define CH9329_CMD_KEYBOARD  0x02
#define CH9329_CMD_MOUSE_ABS 0x04
#define CH9329_CMD_MOUSE_REL 0x05
#define CH9329_CMD_RESET     0x0F

#define CH9329_REPLY_OK(cmd)  ((uint8_t)((cmd) | 0x80))
#define CH9329_REPLY_ERR(cmd) ((uint8_t)((cmd) | 0xC0))

#define CH9329_ERR_TIMEOUT  0xE1
#define CH9329_ERR_HEADER   0xE2
#define CH9329_ERR_COMMAND  0xE3
#define CH9329_ERR_CHECKSUM 0xE4
#define CH9329_ERR_PARAM    0xE5

#define CH9329_LEN_KEYBOARD  8
#define CH9329_LEN_MOUSE_ABS 7
#define CH9329_LEN_MOUSE_REL 5

#define CH9329_MAX_PAYLOAD 64

esp_err_t ch9329_start(void);

uint8_t ch9329_checksum(const uint8_t *data, size_t len);

#ifdef __cplusplus
}
#endif
