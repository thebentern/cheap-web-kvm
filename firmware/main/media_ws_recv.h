/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "esp_http_server.h"
#include <stdbool.h>
#include <stddef.h>

/* IDF 5.4's WebSocket parser assumes its 2/4/8-byte header reads are complete.
 * Fill short positive reads through the original HTTP/TLS receiver. */
int __wrap_httpd_recv_with_opt(httpd_req_t *req, char *buffer, size_t length, bool halt_after_pending);
