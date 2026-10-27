/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "media_ws.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint8_t buffer[MEDIA_WS_PREFIX + MEDIA_WS_MAX_PAYLOAD];
static uint8_t received[sizeof(buffer)];
static size_t received_length, calls, limit;
static unsigned fail_call;
static int failure;
static int capture(void *context, const uint8_t *data, size_t length)
{
    assert(context == &buffer);
    calls++;
    if (calls == fail_call)
        return failure;
    size_t n = length < limit ? length : limit;
    assert(received_length + n <= sizeof(received));
    memcpy(received + received_length, data, n);
    received_length += n;
    return (int)n;
}
static void reset(void)
{
    memset(buffer, 0xcc, sizeof(buffer));
    for (size_t i = 0; i < MEDIA_WS_MAX_PAYLOAD; i++)
        buffer[MEDIA_WS_PREFIX + i] = (uint8_t)i;
    received_length = calls = fail_call = 0;
    limit = sizeof(buffer);
    failure = 0;
}
static void exact(size_t n)
{
    reset();
    assert(media_ws_send_binary(buffer, n, capture, &buffer));
    size_t header = n <= 125 ? 2 : 4;
    assert(calls == 1 && received_length == header + n);
    assert(received[0] == 0x82);
    if (header == 2) {
        assert(received[1] == n);
        assert(buffer[0] == 0xcc && buffer[1] == 0xcc);
    } else {
        assert(received[1] == 126 && received[2] == (uint8_t)(n >> 8) &&
               received[3] == (uint8_t)n);
    }
    for (size_t i = 0; i < n; i++)
        assert(received[header + i] == (uint8_t)i);
}
int main(void)
{
    exact(0);
    exact(32);
    exact(125);
    exact(126);
    exact(256);
    exact(MEDIA_WS_MAX_PAYLOAD);
    /* Short writes can split the header or payload; resume at the exact byte. */
    reset();
    limit = 1;
    assert(media_ws_send_binary(buffer, 126, capture, &buffer));
    assert(calls == 130 && received_length == 130);
    assert(received[0] == 0x82 && received[1] == 126 && received[2] == 0 && received[3] == 126);
    assert(!memcmp(received + 4, buffer + MEDIA_WS_PREFIX, 126));
    reset();
    limit = 509;
    assert(media_ws_send_binary(buffer, MEDIA_WS_MAX_PAYLOAD, capture, &buffer));
    assert(calls > 1 && received_length == sizeof(buffer));
    assert(!memcmp(received, buffer, sizeof(buffer)));
    /* Zero and negative results fail immediately, including after a prefix. */
    for (int code = 0; code >= -3; code--) {
        reset();
        fail_call = 1;
        failure = code;
        assert(!media_ws_send_binary(buffer, 32, capture, &buffer));
        assert(calls == 1 && received_length == 0);
        reset();
        limit = 3;
        fail_call = 2;
        failure = code;
        assert(!media_ws_send_binary(buffer, 126, capture, &buffer));
        assert(calls == 2 && received_length == 3);
    }
    reset();
    fail_call = 1;
    failure = 35; /* A broken sender must not claim more than the 34-byte frame. */
    assert(!media_ws_send_binary(buffer, 32, capture, &buffer) && calls == 1);
    reset();
    assert(!media_ws_send_binary(buffer, MEDIA_WS_MAX_PAYLOAD + 1, capture, &buffer));
    assert(!media_ws_send_binary(NULL, 32, capture, &buffer));
    assert(!media_ws_send_binary(buffer, 32, NULL, &buffer));
    assert(calls == 0);

    /* Reject an upgraded client with real CLOSE bytes, not an HTTP response. */
    reset();
    assert(media_ws_send_close(4001, "Unauthorized", capture, &buffer));
    const uint8_t unauthorized[] = {0x88, 14, 0x0f, 0xa1, 'U', 'n', 'a', 'u', 't', 'h', 'o', 'r', 'i', 'z', 'e', 'd'};
    assert(calls == 1 && received_length == sizeof(unauthorized));
    assert(!memcmp(received, unauthorized, sizeof(unauthorized)));
    reset();
    limit = 1;
    assert(media_ws_send_close(4009, "Busy", capture, &buffer));
    const uint8_t busy[] = {0x88, 6, 0x0f, 0xa9, 'B', 'u', 's', 'y'};
    assert(calls == sizeof(busy) && received_length == sizeof(busy));
    assert(!memcmp(received, busy, sizeof(busy)));
    char reason[125];
    memset(reason, 'x', sizeof(reason));
    reason[123] = 0;
    reset();
    assert(media_ws_send_close(4009, reason, capture, &buffer));
    assert(received_length == 127 && received[1] == 125);
    reason[123] = 'x'; reason[124] = 0;
    reset();
    assert(!media_ws_send_close(4009, reason, capture, &buffer));
    assert(!media_ws_send_close(3999, "", capture, &buffer));
    assert(!media_ws_send_close(5000, "", capture, &buffer));
    assert(!media_ws_send_close(4001, NULL, capture, &buffer));
    assert(!media_ws_send_close(4001, "", NULL, &buffer));
    assert(calls == 0);
    for (int code = 0; code >= -3; code--) {
        reset();
        limit = 2; fail_call = 2; failure = code;
        assert(!media_ws_send_close(4001, "Unauthorized", capture, &buffer));
        assert(calls == 2 && received_length == 2);
    }
    puts("PASS: binary/CLOSE WebSocket wire headers, bounded payloads, partial sends and failure handling");
}
