/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <stdbool.h>
#include <stdint.h>
typedef struct {
    uint8_t key;
    uint32_t delay, press, interval, duration;
} boot_config_t;
typedef struct {
    boot_config_t config;
    uint64_t start, end, next, release;
    bool active, down;
} boot_repeat_t;
bool boot_config_valid(const boot_config_t *config);
void boot_repeat_arm(boot_repeat_t *s, const boot_config_t *config, uint64_t now);
/* ready means USB can accept a keyboard report. Timing never extends end. */
void boot_repeat_step(boot_repeat_t *s, uint64_t now, bool ready);
