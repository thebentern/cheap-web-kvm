/* SPDX-License-Identifier: GPL-3.0-or-later */

#include "kvm_led.h"

#if CONFIG_KVM_LED_ENABLED

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "led_strip.h"

#include "kvm_led_pattern.h"

static const char *TAG = "kvm_led";
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static kvm_led_pattern_t s_pattern;

static uint64_t now_ms(void)
{
    return (uint64_t)(esp_timer_get_time() / 1000);
}

void kvm_led_target(bool ready)
{
    portENTER_CRITICAL(&s_lock);
    kvm_led_pattern_target(&s_pattern, ready);
    portEXIT_CRITICAL(&s_lock);
}

void kvm_led_pairing(bool active)
{
    const uint64_t now = now_ms();
    portENTER_CRITICAL(&s_lock);
    kvm_led_pattern_pairing(&s_pattern, active, now);
    portEXIT_CRITICAL(&s_lock);
}

void kvm_led_input(bool accepted)
{
    const uint64_t now = now_ms();
    portENTER_CRITICAL(&s_lock);
    kvm_led_pattern_input(&s_pattern, accepted, now);
    portEXIT_CRITICAL(&s_lock);
}

static void led_task(void *arg)
{
    (void)arg;
    const led_strip_config_t strip_config = {
        .strip_gpio_num = CONFIG_KVM_LED_GPIO,
        .max_leds = 1,
        .led_model = LED_MODEL_WS2812,
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
    };
    const led_strip_rmt_config_t rmt_config = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000,
        .flags.with_dma = true,
    };
    led_strip_handle_t strip = NULL;
    esp_err_t err = led_strip_new_rmt_device(&strip_config, &rmt_config, &strip);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "status LED unavailable: %s", esp_err_to_name(err));
        vTaskDelete(NULL);
        return;
    }

    /* Begin the startup fade when the strip is available, preserving USB and
     * BLE state already published while this lower-priority task was waiting. */
    const uint64_t start = now_ms();
    portENTER_CRITICAL(&s_lock);
    kvm_led_pattern_begin(&s_pattern, start);
    portEXIT_CRITICAL(&s_lock);

    kvm_led_rgb_t previous = {255, 255, 255};
    for (;;) {
        portENTER_CRITICAL(&s_lock);
        const kvm_led_pattern_t snapshot = s_pattern;
        portEXIT_CRITICAL(&s_lock);
        /* Read time after the snapshot: a callback may publish a pairing
         * timestamp while we wait for the lock, and elapsed must not wrap. */
        const uint64_t now = now_ms();
        const kvm_led_rgb_t rgb = kvm_led_pattern_rgb(&snapshot, now, CONFIG_KVM_LED_BRIGHTNESS);
        if (rgb.red != previous.red || rgb.green != previous.green || rgb.blue != previous.blue) {
            err = led_strip_set_pixel(strip, 0, rgb.red, rgb.green, rgb.blue);
            if (err == ESP_OK) {
                err = led_strip_refresh(strip);
            }
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "status LED stopped: %s", esp_err_to_name(err));
                led_strip_clear(strip);
                led_strip_del(strip);
                vTaskDelete(NULL);
                return;
            }
            previous = rgb;
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

void kvm_led_start(void)
{
    if (xTaskCreate(led_task, "kvm_led", 3072, NULL, 1, NULL) != pdPASS) {
        ESP_LOGW(TAG, "could not start status LED task");
    }
}

#endif /* CONFIG_KVM_LED_ENABLED */
