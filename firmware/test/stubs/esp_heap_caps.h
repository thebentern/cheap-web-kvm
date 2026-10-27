#pragma once
#include <stddef.h>
#define MALLOC_CAP_SPIRAM 1u
#define MALLOC_CAP_8BIT 2u
#define MALLOC_CAP_INTERNAL 4u
void *heap_caps_malloc(size_t size, unsigned caps);
