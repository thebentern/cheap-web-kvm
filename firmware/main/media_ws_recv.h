/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "esp_http_server.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Bound the remaining header and payload of one media frame to 10s total.
 * Call begin once before IDF's header-only receive and end after its payload
 * receive, including every error path. The opcode was already read by IDF.
 * Scope is local to this HTTP task and request/socket; HTTP and pending-only
 * receives retain their original behavior and socket timeout. */
int media_ws_recv_begin(httpd_req_t *req);
/* Continuation frames share their message's original absolute deadline.
 * Zero selects the normal 10s frame budget. */
int media_ws_recv_begin_until(httpd_req_t *req, int64_t deadline);
int media_ws_recv_end(httpd_req_t *req);
uint32_t media_ws_recv_frame_timeouts(void);

/* Used by the existing TLS BIO wrapper: one TLS record can require several
 * socket reads. Match only a scoped receive on this task and fd, and clamp
 * each underlying wait to the same absolute deadline. Unmatched calls do no
 * socket work. Return zero or an HTTPD_SOCK_ERR_* failure. */
int media_ws_recv_before_tls_recv(int fd);
int media_ws_recv_after_tls_recv(int fd);

/* IDF 5.4's WebSocket parser assumes its 2/4/8-byte header reads are complete.
 * Fill short positive reads through the original HTTP/TLS receiver. */
int __wrap_httpd_recv_with_opt(httpd_req_t *req, char *buffer, size_t length, bool halt_after_pending);
