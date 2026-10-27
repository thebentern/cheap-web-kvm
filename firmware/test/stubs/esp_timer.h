#pragma once
#include <stdint.h>
extern int64_t mock_time;
static inline int64_t esp_timer_get_time(void) { return mock_time; }
