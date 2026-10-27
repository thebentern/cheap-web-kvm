/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "media_ws_recv.h"
#include "lwip/sockets.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int64_t mock_time;
static httpd_req_t request;
static httpd_ws_client_info_t client_type;
static int parts[8];
static int64_t elapsed[8];
static unsigned calls, get_calls, set_calls, fail_set;
static bool fail_get, last_halt;
static size_t source_at, wanted[8];
static int64_t timeouts[12];
static struct timeval original, current_timeout;
static const uint8_t source[] = {0x20, 0x20, 0x80, 0x12, 0x34, 0x56, 0x78, 0x9a};
static void reset(void)
{
    request = (httpd_req_t){.handle = &request, .fd = 42};
    client_type = HTTPD_WS_CLIENT_WEBSOCKET;
    memset(parts, 0, sizeof(parts));
    memset(elapsed, 0, sizeof(elapsed));
    memset(wanted, 0, sizeof(wanted));
    mock_time = calls = get_calls = set_calls = fail_set = source_at = 0;
    fail_get = last_halt = false;
    original = current_timeout = (struct timeval){.tv_sec = 2};
}
int httpd_req_to_sockfd(httpd_req_t *req) { return req->fd; }
httpd_ws_client_info_t httpd_ws_get_fd_info(httpd_handle_t handle, int fd)
{
    assert(handle == &request && fd == 42);
    return client_type;
}
int __real_httpd_recv_with_opt(httpd_req_t *req, char *buffer, size_t length, bool halt)
{
    assert(req == &request || !req);
    assert(calls < 8);
    wanted[calls] = length;
    last_halt = halt;
    int n = parts[calls];
    mock_time += elapsed[calls++];
    if (n > 0 && (size_t)n <= length && buffer) {
        assert(source_at + (size_t)n <= sizeof(source));
        memcpy(buffer, source + source_at, (size_t)n);
        source_at += (size_t)n;
    }
    return n;
}
int getsockopt(int fd, int level, int option, void *value, socklen_t *length)
{
    assert(fd == 42 && level == SOL_SOCKET && option == SO_RCVTIMEO);
    assert(*length == sizeof(original));
    get_calls++;
    if (fail_get)
        return -1;
    memcpy(value, &original, sizeof(original));
    return 0;
}
int setsockopt(int fd, int level, int option, const void *value, socklen_t length)
{
    assert(fd == 42 && level == SOL_SOCKET && option == SO_RCVTIMEO);
    assert(length == sizeof(current_timeout) && set_calls < 12);
    const struct timeval *timeout = value;
    timeouts[set_calls++] = (int64_t)timeout->tv_sec * 1000000 + timeout->tv_usec;
    if (set_calls == fail_set)
        return -1;
    current_timeout = *timeout;
    return 0;
}
static int receive(size_t length)
{
    uint8_t buffer[8] = {0};
    int n = __wrap_httpd_recv_with_opt(&request, (char *)buffer, length, false);
    if (n > 0 && (size_t)n == length)
        assert(!memcmp(buffer, source, length));
    return n;
}
int main(void)
{
    /* Every split of 2/4/8-byte length and mask fields, including one-byte TLS
     * records, must yield exactly the same header with no skipped bytes. */
    for (size_t length = 2; length <= 8; length *= 2) {
        for (unsigned cuts = 0; cuts < (1u << (length - 1)); cuts++) {
            reset();
            unsigned part = 0;
            for (size_t i = 0; i < length; i++) {
                parts[part]++;
                if (i + 1 < length && (cuts & (1u << i)))
                    part++;
            }
            assert(receive(length) == (int)length && calls == part + 1);
            assert(get_calls == (part ? 1u : 0u));
            assert(!memcmp(&current_timeout, &original, sizeof(original)));
        }
    }
    /* Initial full reads and failures retain their original fast path. */
    for (int n = 0; n >= -3; n--) {
        reset(); parts[0] = n;
        assert(receive(4) == n && calls == 1 && !get_calls && !set_calls);
        reset(); parts[0] = 1; parts[1] = n;
        assert(receive(4) == n && calls == 2 && get_calls == 1 && set_calls == 2);
        assert(!memcmp(&current_timeout, &original, sizeof(original)));
    }
    reset(); parts[0] = 1; parts[1] = -0x6900; /* TLS WANT_READ is also a failure. */
    assert(receive(4) == -0x6900 && calls == 2 && set_calls == 2);
    /* A split header has one total budget, not one new timeout per byte. */
    reset(); parts[0] = 1; parts[1] = 1; parts[2] = 2;
    elapsed[0] = 500000; elapsed[1] = 250000;
    assert(receive(4) == 4 && timeouts[0] == 1500000 && timeouts[1] == 1250000);
    assert(timeouts[2] == 2000000);
    reset(); parts[0] = 1; elapsed[0] = 2000000;
    assert(receive(4) == HTTPD_SOCK_ERR_TIMEOUT && calls == 1 && !set_calls);
    reset(); parts[0] = 1; parts[1] = 1; elapsed[1] = 2000000;
    assert(receive(4) == HTTPD_SOCK_ERR_TIMEOUT && calls == 2 && set_calls == 2);
    reset(); original = current_timeout = (struct timeval){.tv_sec = 1};
    parts[0] = 1; parts[1] = 1; elapsed[0] = 999999;
    assert(receive(2) == 2 && timeouts[0] == 1000 && timeouts[1] == 1000000);
    reset(); original = current_timeout = (struct timeval){0};
    parts[0] = 1; parts[1] = 1;
    assert(receive(2) == 2 && timeouts[0] == 2000000 && timeouts[1] == 0);
    /* Failure to enforce or restore the timeout must fail closed. */
    reset(); parts[0] = 1; fail_get = true;
    assert(receive(2) == HTTPD_SOCK_ERR_FAIL && calls == 1 && !set_calls);
    for (unsigned at = 1; at <= 2; at++) {
        reset(); parts[0] = 1; parts[1] = 1; fail_set = at;
        assert(receive(2) == HTTPD_SOCK_ERR_FAIL);
    }
    reset(); parts[0] = 3;
    assert(receive(2) == HTTPD_SOCK_ERR_FAIL && !get_calls);
    /* Ordinary HTTP, pending-only receives, other sizes and invalid requests
     * stay byte-for-byte pass-through, including their short positive result. */
    char buffer[16];
    reset(); client_type = HTTPD_WS_CLIENT_HTTP; parts[0] = 1;
    assert(__wrap_httpd_recv_with_opt(&request, buffer, 4, false) == 1 && calls == 1 && !get_calls);
    reset(); client_type = HTTPD_WS_CLIENT_INVALID; parts[0] = 1;
    assert(__wrap_httpd_recv_with_opt(&request, buffer, 4, false) == 1 && calls == 1 && !get_calls);
    reset(); parts[0] = 1;
    assert(__wrap_httpd_recv_with_opt(&request, buffer, 4, true) == 1 && calls == 1 && last_halt && !get_calls);
    const size_t sizes[] = {0, 1, 3, 5, 7, 9, 16};
    for (size_t i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++) {
        reset(); parts[0] = sizes[i] ? 1 : 0;
        assert(__wrap_httpd_recv_with_opt(&request, buffer, sizes[i], false) == parts[0]);
        assert(calls == 1 && !get_calls && !set_calls);
    }
    reset(); parts[0] = HTTPD_SOCK_ERR_INVALID;
    assert(__wrap_httpd_recv_with_opt(NULL, buffer, 4, false) == HTTPD_SOCK_ERR_INVALID && calls == 1);
    reset(); request.handle = NULL; parts[0] = HTTPD_SOCK_ERR_INVALID;
    assert(__wrap_httpd_recv_with_opt(&request, buffer, 4, false) == HTTPD_SOCK_ERR_INVALID && calls == 1);
    puts("PASS: exact split WebSocket header reads, total deadlines, failures and HTTP/pending pass-through");
}
