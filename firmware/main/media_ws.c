/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "media_ws.h"

bool media_ws_send_binary(uint8_t *buffer, size_t length, media_ws_send_fn send, void *context)
{
    if (!buffer || !send || length > MEDIA_WS_MAX_PAYLOAD)
        return false;
    size_t header = length <= 125 ? 2 : 4;
    uint8_t *frame = buffer + MEDIA_WS_PREFIX - header;
    frame[0] = 0x82; /* FIN, binary; server frames are not masked. */
    if (header == 2)
        frame[1] = (uint8_t)length;
    else {
        frame[1] = 126;
        frame[2] = (uint8_t)(length >> 8);
        frame[3] = (uint8_t)length;
    }
    size_t remaining = header + length;
    while (remaining) {
        int sent = send(context, frame, remaining);
        if (sent <= 0 || (size_t)sent > remaining)
            return false;
        frame += sent;
        remaining -= sent;
    }
    return true;
}
