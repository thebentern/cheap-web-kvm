/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Pure animation state: times are monotonic milliseconds. The LED task takes
 * a snapshot while callbacks update it under a short critical section. */
typedef struct {
    bool started;
    bool target_ready;
    bool pairing;
    uint64_t started_ms;
    uint64_t pairing_ms;
    uint64_t activity_until_ms;
    uint64_t next_activity_ms;
    uint64_t warning_until_ms;
    uint64_t next_warning_ms;
} kvm_led_pattern_t;

typedef struct {
    uint8_t red;
    uint8_t green;
    uint8_t blue;
} kvm_led_rgb_t;

void kvm_led_pattern_begin(kvm_led_pattern_t *state, uint64_t now_ms);
void kvm_led_pattern_target(kvm_led_pattern_t *state, bool ready);
void kvm_led_pattern_pairing(kvm_led_pattern_t *state, bool active, uint64_t now_ms);
void kvm_led_pattern_input(kvm_led_pattern_t *state, bool accepted, uint64_t now_ms);
kvm_led_rgb_t kvm_led_pattern_rgb(const kvm_led_pattern_t *state, uint64_t now_ms,
                                unsigned brightness_percent);
