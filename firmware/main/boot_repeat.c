/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "boot_repeat.h"
bool boot_config_valid(const boot_config_t *c)
{
    return c->key >= 4 && c->key <= 0x73 && c->delay <= 120000 && c->press >= 20 &&
           c->press <= 2000 && c->interval >= c->press + 10 && c->interval <= 10000 &&
           c->duration >= c->press && c->duration <= 300000;
}
void boot_repeat_arm(boot_repeat_t *s, const boot_config_t *c, uint64_t now)
{
    *s = (boot_repeat_t){.config = *c,
                         .start = now + c->delay,
                         .end = now + c->delay + c->duration,
                         .next = now + c->delay,
                         .active = true};
}
void boot_repeat_step(boot_repeat_t *s, uint64_t now, bool ready)
{
    if (!s->active)
        return;
    if (now >= s->end) {
        s->active = false;
        s->down = false;
        return;
    }
    if (!ready) {
        s->down = false;
        s->next = now;
        return;
    }
    if (s->down && now >= s->release) {
        s->down = false;
        return;
    }
    if (!s->down && now >= s->start && now >= s->next) {
        s->down = true;
        s->release = now + s->config.press;
        s->next = now + s->config.interval;
    }
}
