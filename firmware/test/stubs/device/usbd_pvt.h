#pragma once
#include <stdbool.h>
void usbd_defer_func(void (*fn)(void *), void *arg, bool isr);
