/* SPDX-License-Identifier: GPL-3.0-or-later */

#include "kvm_led_pattern.h"

#define STARTUP_MS 700
#define ACTIVITY_MS 80
#define WARNING_MS 180
/* New flashes at most twice a second. Closely spaced successful reports keep
 * one lift bright instead of producing a flash for every pointer packet. */
#define FLASH_INTERVAL_MS 500

static bool starting(const kvm_led_pattern_t *state, uint64_t now_ms)
{
    return state->started && now_ms - state->started_ms < STARTUP_MS;
}

void kvm_led_pattern_begin(kvm_led_pattern_t *state, uint64_t now_ms)
{
    state->started = true;
    state->started_ms = now_ms;
}

void kvm_led_pattern_target(kvm_led_pattern_t *state, bool ready)
{
    state->target_ready = ready;
    if (!ready) {
        state->activity_until_ms = 0;
    }
}

void kvm_led_pattern_pairing(kvm_led_pattern_t *state, bool active, uint64_t now_ms)
{
    if (active && !state->pairing) {
        state->pairing_ms = now_ms;
        state->activity_until_ms = 0;
    }
    state->pairing = active;
}

void kvm_led_pattern_input(kvm_led_pattern_t *state, bool accepted, uint64_t now_ms)
{
    if (!accepted) {
        if (now_ms >= state->next_warning_ms) {
            state->warning_until_ms = now_ms + WARNING_MS;
            state->next_warning_ms = now_ms + FLASH_INTERVAL_MS;
        }
        return;
    }
    if (!state->target_ready || state->pairing || starting(state, now_ms)) {
        return;
    }
    if (now_ms < state->activity_until_ms) {
        state->activity_until_ms = now_ms + ACTIVITY_MS;
    } else if (now_ms >= state->next_activity_ms) {
        state->activity_until_ms = now_ms + ACTIVITY_MS;
        state->next_activity_ms = now_ms + FLASH_INTERVAL_MS;
    }
}

/* Smoothstep easing without floating point or a math-library dependency. */
static unsigned ease(unsigned level)
{
    return level * level * (765 - 2 * level) / (255 * 255);
}

kvm_led_rgb_t kvm_led_pattern_rgb(const kvm_led_pattern_t *state, uint64_t now_ms,
                                unsigned brightness_percent)
{
    kvm_led_rgb_t rgb = {0};
    if (now_ms < state->warning_until_ms) {
        rgb.red = 255;
    } else if (starting(state, now_ms)) {
        const unsigned phase = (unsigned)(now_ms - state->started_ms);
        const unsigned ramp = phase < 350 ? phase : STARTUP_MS - phase;
        const uint8_t level = (uint8_t)ease(ramp * 255 / 350);
        rgb = (kvm_led_rgb_t){level, level, level};
    } else if (state->pairing) {
        const unsigned phase = (unsigned)((now_ms - state->pairing_ms) % 2400);
        if (phase < 120 || (phase >= 400 && phase < 520)) {
            rgb.blue = 255;
        }
    } else if (!state->target_ready) {
        const unsigned phase = (unsigned)(now_ms % 3000);
        const unsigned ramp = phase < 1500 ? phase : 3000 - phase;
        const unsigned level = 20 + 235 * ease(ramp * 255 / 1500) / 255;
        rgb.red = (uint8_t)level;
        rgb.green = (uint8_t)(level / 2);
    } else {
        rgb.green = now_ms < state->activity_until_ms ? 255 : 128;
    }

    if (brightness_percent > 100) {
        brightness_percent = 100;
    }
    rgb.red = (uint8_t)(rgb.red * brightness_percent / 100);
    rgb.green = (uint8_t)(rgb.green * brightness_percent / 100);
    rgb.blue = (uint8_t)(rgb.blue * brightness_percent / 100);
    return rgb;
}
