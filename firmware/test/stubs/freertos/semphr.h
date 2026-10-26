#pragma once
#include <assert.h>
extern int mock_lock_depth;
typedef void *SemaphoreHandle_t;
static inline SemaphoreHandle_t xSemaphoreCreateMutex(void) { return (void *)1; }
static inline int xSemaphoreTake(SemaphoreHandle_t m, unsigned t)
{
    (void)m;
    (void)t;
    mock_lock_depth++;
    return 1;
}
static inline void xSemaphoreGive(SemaphoreHandle_t m) { (void)m; }
