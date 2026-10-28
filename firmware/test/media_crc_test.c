/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "media_protocol.h"
#include <assert.h>
#include <stdio.h>

static uint8_t data[MEDIA_MAX_IO + 1];
static uint32_t reference(const uint8_t *p, size_t n, uint32_t crc)
{
    while (n--) {
        crc ^= *p++;
        for (unsigned bit = 0; bit < 8; bit++)
            crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
    }
    return crc;
}
int main(void)
{
    const size_t lengths[] = {0, 1, 28, 31, 32, 4096, 65535, 65536, MEDIA_MAX_IO};
    const uint32_t seeds[] = {0, 0xffffffffu, 0x12345678u};
    for (size_t i = 0; i < sizeof(data); i++)
        data[i] = (uint8_t)(i ^ (i >> 8) ^ (i >> 16));
    assert(media_crc((const uint8_t *)"123456789", 9, 0xffffffffu) == ~0xcbf43926u);
    for (unsigned seed = 0; seed < sizeof(seeds) / sizeof(*seeds); seed++)
        for (unsigned i = 0; i < sizeof(lengths) / sizeof(*lengths); i++) {
            size_t n = lengths[i], split = n / 3;
            const uint8_t *p = data + 1; /* Unaligned PSRAM payloads are valid. */
            uint32_t expected = reference(p, n, seeds[seed]);
            assert(media_crc(p, n, seeds[seed]) == expected);
            assert(media_crc(p + split, n - split, media_crc(p, split, seeds[seed])) == expected);
        }
    puts("PASS: CRC seeds, chaining, unaligned buffers and 128 KiB payloads");
}
