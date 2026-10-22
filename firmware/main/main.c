/* SPDX-License-Identifier: GPL-3.0-or-later */

#include "sdkconfig.h"

#include "esp_err.h"
#include "esp_log.h"
#include "nvs_flash.h"

#include "ch9329.h"
#include "kvm_ble.h"
#include "kvm_hid.h"

static const char *TAG = "kvm";

void app_main(void)
{
    ESP_LOGI(TAG, "cheap-web-kvm firmware starting");

    /* USB first: the target may already be powered and waiting to enumerate. */
    ESP_ERROR_CHECK(kvm_hid_start());

#if CONFIG_KVM_BLE_ENABLED
    /* Bonds and the passkey live in NVS, which must be up before UART0 can
     * take a set-passkey command. A partition written by an older layout is
     * wiped rather than left to block startup; the cost is re-pairing and the
     * passkey falling back to the build's default. */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
#endif

    ESP_ERROR_CHECK(ch9329_start());

#if CONFIG_KVM_BLE_ENABLED
    ESP_ERROR_CHECK(kvm_ble_start());
    ESP_LOGI(TAG, "ready - CH9329 on UART0 @ 115200 and Bluetooth LE, HID on native USB");
#else
    ESP_LOGI(TAG, "ready - CH9329 on UART0 @ 115200, HID on native USB");
#endif
}
