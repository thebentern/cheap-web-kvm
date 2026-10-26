/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <stdbool.h>
#include <stdint.h>
/* Boot state is owned by the HID task, control changes use its own mailbox. */
bool kvm_boot_arm(uint8_t key, uint32_t delay, uint32_t press, uint32_t interval,
                  uint32_t duration);
void kvm_boot_cancel(void);
bool kvm_boot_active(void);
