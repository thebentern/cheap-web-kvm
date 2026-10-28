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
    assert(length <= MEDIA_WS_SEND_CHUNK);
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
    size_t header = n <= 125 ? 2 : n <= UINT16_MAX ? 4 : 10;
    assert(calls == (header + n + MEDIA_WS_SEND_CHUNK - 1) / MEDIA_WS_SEND_CHUNK &&
           received_length == header + n);
    assert(received[0] == 0x82);
    if (header == 2) {
        assert(received[1] == n);
        assert(buffer[0] == 0xcc && buffer[1] == 0xcc);
    } else if (header == 4) {
        assert(received[1] == 126 && received[2] == (uint8_t)(n >> 8) &&
               received[3] == (uint8_t)n);
    } else {
        assert(received[1] == 127);
        uint64_t wire_length = 0;
        for (unsigned i = 0; i < 8; i++)
            wire_length = (wire_length << 8) | received[2 + i];
        assert(wire_length == n);
    }
    for (size_t i = 0; i < n; i++)
        assert(received[header + i] == (uint8_t)i);
}
int main(void)
{
    /* Chromium fragments 128 KiB messages (observed first fragment 130424
     * bytes). Accept the complete message once, within one bounded buffer. */
    media_ws_message_t message = {0};
    assert(media_ws_message_accept(&message, 2, false, 130424, MEDIA_WS_MAX_PAYLOAD, 100));
    assert(message.active && message.length == 130424 && message.fragments == 1);
    int64_t deadline = message.deadline;
    assert(media_ws_message_accept(&message, 0, true, MEDIA_WS_MAX_PAYLOAD - 130424,
                                   MEDIA_WS_MAX_PAYLOAD, 500100));
    assert(!message.active && message.length == MEDIA_WS_MAX_PAYLOAD && message.deadline == deadline);
    assert(media_ws_message_accept(&message, 2, true, 32, 8192, 600000));
    assert(!message.active && message.length == 32 && message.fragments == 1);
    message = (media_ws_message_t){0};
    assert(!media_ws_message_accept(&message, 0, true, 1, 8192, 0));
    assert(!media_ws_message_accept(&message, 1, true, 1, 8192, 0));
    assert(!media_ws_message_accept(&message, 2, true, 8193, 8192, 0));
    assert(!media_ws_message_accept(&message, 2, true, 1, MEDIA_WS_MAX_PAYLOAD + 1, 0));
    assert(media_ws_message_accept(&message, 2, false, 8190, 8192, 0));
    assert(!media_ws_message_accept(&message, 2, true, 2, 8192, 1));
    assert(!media_ws_message_accept(&message, 0, true, 3, 8192, 1));
    assert(media_ws_message_accept(&message, 0, true, 2, 8192, 1));
    message = (media_ws_message_t){0};
    assert(media_ws_message_accept(&message, 2, false, 1, 8192, 0));
    for (unsigned i = 1; i < MEDIA_WS_MAX_FRAGMENTS; i++)
        assert(media_ws_message_accept(&message, 0, false, 0, 8192, i));
    assert(!media_ws_message_accept(&message, 0, true, 0, 8192, MEDIA_WS_MAX_FRAGMENTS));
    message = (media_ws_message_t){0};
    assert(media_ws_message_accept(&message, 2, false, 1, 8192, 0));
    assert(!media_ws_message_accept(&message, 0, true, 1, 8192, MEDIA_WS_MESSAGE_TIMEOUT_US));
    exact(0);
    exact(32);
    exact(125);
    exact(126);
    exact(256);
    exact(MEDIA_WS_SEND_CHUNK - 4);
    exact(MEDIA_WS_SEND_CHUNK - 3);
    exact(65535);
    exact(65536);
    exact(65568);
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
    fail_call = 1;
    failure = MEDIA_WS_SEND_CHUNK + 1;
    assert(!media_ws_send_binary(buffer, 65536, capture, &buffer) && calls == 1);
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
