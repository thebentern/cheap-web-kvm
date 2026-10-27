/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "esp_http_server.h"
#include <stdbool.h>
/* Register read-only assets and certificate/session setup on a server. */
esp_err_t device_web_register(httpd_handle_t server, bool secure);
void device_web_reset_sessions(const char *token);
bool device_web_authorized(httpd_req_t *req, bool secure);
