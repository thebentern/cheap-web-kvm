/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once

#include <stdbool.h>
#include "sdkconfig.h"

#if CONFIG_KVM_LED_ENABLED
/* Starts a best-effort, low-priority task. Only that task touches the strip;
 * these callback-safe updates never wait for an RMT transaction. */
void kvm_led_start(void);
void kvm_led_target(bool ready);
void kvm_led_pairing(bool active);
/* True means USB accepted a report for transmission, not target receipt. */
void kvm_led_input(bool accepted);
#else
static inline void kvm_led_start(void) {}
static inline void kvm_led_target(bool ready) { (void)ready; }
static inline void kvm_led_pairing(bool active) { (void)active; }
static inline void kvm_led_input(bool accepted) { (void)accepted; }
#endif
