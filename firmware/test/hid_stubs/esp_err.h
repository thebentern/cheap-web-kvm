/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERR_NO_MEM 1
#define ESP_ERR_INVALID_STATE 2
#define ESP_ERR_TIMEOUT 3
const char *esp_err_to_name(esp_err_t err);
