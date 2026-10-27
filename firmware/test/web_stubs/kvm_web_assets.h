#pragma once
#include <stddef.h>
typedef struct {
    const char *path, *content_type, *encoding, *etag;
    const unsigned char *data;
    size_t size;
} kvm_web_asset_t;
const kvm_web_asset_t *kvm_web_asset_find(const char *uri);
