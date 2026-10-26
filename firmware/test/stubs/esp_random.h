#pragma once
#include <stdint.h>
static inline uint32_t esp_random(void)
{
    static uint32_t r = 100;
    return ++r;
}
