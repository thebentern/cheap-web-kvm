/* SPDX-License-Identifier: GPL-3.0-or-later
 * Host tests for the timing and arbitration shared by every LED update. */

#include <assert.h>
#include <stdio.h>

#include "kvm_led_pattern.h"

static void expect(kvm_led_pattern_t *state, uint64_t now, unsigned cap,
                   unsigned red, unsigned green, unsigned blue)
{
    const kvm_led_rgb_t rgb = kvm_led_pattern_rgb(state, now, cap);
    assert(rgb.red == red && rgb.green == green && rgb.blue == blue);
}

int main(void)
{
    kvm_led_pattern_t state = {0};

    /* Enumeration before LED setup survives initialization and its fade. */
    kvm_led_pattern_target(&state, true);
    kvm_led_pattern_begin(&state, 100);
    expect(&state, 100, 100, 0, 0, 0);
    expect(&state, 450, 10, 25, 25, 25);
    expect(&state, 800, 10, 0, 12, 0);

    /* Startup suppresses activity, but warnings take precedence and expire. */
    kvm_led_pattern_input(&state, true, 450);
    assert(state.activity_until_ms == 0);
    kvm_led_pattern_input(&state, false, 450);
    expect(&state, 450, 10, 25, 0, 0);
    expect(&state, 629, 10, 25, 0, 0);
    const kvm_led_rgb_t restored_startup = kvm_led_pattern_rgb(&state, 630, 100);
    assert(restored_startup.red == restored_startup.green && restored_startup.green == restored_startup.blue);

    /* The first and second pairing pulses have exact edges. State changes and
     * successful traffic cannot hide pairing, even when USB is available. */
    kvm_led_pattern_pairing(&state, true, 1000);
    expect(&state, 1000, 10, 0, 0, 25);
    expect(&state, 1119, 10, 0, 0, 25);
    expect(&state, 1120, 10, 0, 0, 0);
    expect(&state, 1399, 10, 0, 0, 0);
    expect(&state, 1400, 10, 0, 0, 25);
    expect(&state, 1520, 10, 0, 0, 0);
    expect(&state, 3400, 10, 0, 0, 25);
    kvm_led_pattern_input(&state, true, 3400);
    assert(state.activity_until_ms == 0);
    kvm_led_pattern_input(&state, false, 3410);
    expect(&state, 3410, 10, 25, 0, 0);
    expect(&state, 3590, 10, 0, 0, 0);
    kvm_led_pattern_pairing(&state, false, 3600);
    expect(&state, 3600, 10, 0, 12, 0);

    /* Continuous activity merges into a single lift; fresh pulses have a
     * cooldown so a stream arriving just slower than 80ms cannot strobe. */
    kvm_led_pattern_input(&state, true, 4000);
    expect(&state, 4000, 10, 0, 25, 0);
    kvm_led_pattern_input(&state, true, 4070);
    expect(&state, 4149, 10, 0, 25, 0);
    expect(&state, 4150, 10, 0, 12, 0);
    kvm_led_pattern_input(&state, true, 4200);
    expect(&state, 4200, 10, 0, 12, 0);
    kvm_led_pattern_input(&state, true, 4500);
    expect(&state, 4500, 10, 0, 25, 0);

    /* Repeated drops cannot latch red forever; they restore live target
     * status between at most two warning flashes each second. */
    kvm_led_pattern_input(&state, false, 5000);
    kvm_led_pattern_input(&state, false, 5100);
    expect(&state, 5179, 10, 25, 0, 0);
    expect(&state, 5180, 10, 0, 12, 0);
    kvm_led_pattern_input(&state, false, 5499);
    expect(&state, 5499, 10, 0, 12, 0);
    kvm_led_pattern_input(&state, false, 5500);
    expect(&state, 5500, 10, 25, 0, 0);

    /* Disconnect clears stale activity. Pairing completion without a USB
     * target returns to amber, rather than falsely showing ready green. */
    kvm_led_pattern_target(&state, false);
    assert(state.activity_until_ms == 0);
    kvm_led_pattern_pairing(&state, true, 6000);
    kvm_led_pattern_pairing(&state, false, 6100);
    expect(&state, 6000, 100, 20, 10, 0);
    expect(&state, 7500, 100, 255, 127, 0);
    expect(&state, 9000, 100, 20, 10, 0);
    kvm_led_pattern_input(&state, true, 9000);
    assert(state.activity_until_ms == 0);

    /* A user-supplied cap always bounds all channels, including white and
     * warning frames; zero also works for host callers. */
    for (unsigned cap = 0; cap <= 100; ++cap) {
        for (uint64_t now = 6100; now < 9100; now += 11) {
            const kvm_led_rgb_t rgb = kvm_led_pattern_rgb(&state, now, cap);
            const unsigned ceiling = 255 * cap / 100;
            assert(rgb.red <= ceiling && rgb.green <= ceiling && rgb.blue <= ceiling);
        }
    }
    expect(&state, 7500, 0, 0, 0, 0);
    expect(&state, 7500, 200, 255, 127, 0);

    puts("LED pattern timing and priority tests passed");
    return 0;
}
