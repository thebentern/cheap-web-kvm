/* SPDX-License-Identifier: GPL-3.0-or-later */

#include "esp_err.h"
#include "esp_log.h"

#include "ch9329.h"
#include "kvm_hid.h"

static const char *TAG = "kvm";

void app_main(void)
{
    ESP_LOGI(TAG, "cheap-web-kvm firmware starting");

    /* USB first: the target may already be powered and waiting to enumerate. */
    ESP_ERROR_CHECK(kvm_hid_start());
    ESP_ERROR_CHECK(ch9329_start());

    ESP_LOGI(TAG, "ready - CH9329 on UART0 @ 115200, HID on native USB");
}
