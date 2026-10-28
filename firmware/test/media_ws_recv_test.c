/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "media_ws_recv.h"
#include "esp_tls_errors.h"
#include "esp_tls.h"
#include "lwip/sockets.h"
#include "mbedtls/net_sockets.h"
#include "mbedtls/ssl.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int64_t mock_time;
static httpd_req_t request, other_request;
static httpd_ws_client_info_t client_type;
static int parts[64];
static int64_t elapsed[64];
static unsigned calls, get_calls, set_calls, fail_set;
static unsigned yields, bio_calls;
static bool fail_get, last_halt;
static bool tls_records, task_probe;
static size_t source_at, wanted[64], pending_bytes, bio_chunk;
static int64_t yield_us, bio_gap_us;
static int64_t timeouts[256];
static struct timeval original, current_timeout;
static uint8_t source[32816];
static void reset(void)
{
    request = (httpd_req_t){.handle = &request, .fd = 42};
    other_request = (httpd_req_t){.handle = &other_request, .fd = 43};
    client_type = HTTPD_WS_CLIENT_WEBSOCKET;
    memset(parts, 0, sizeof(parts));
    memset(elapsed, 0, sizeof(elapsed));
    memset(wanted, 0, sizeof(wanted));
    mock_time = calls = get_calls = set_calls = fail_set = source_at = 0;
    pending_bytes = yields = bio_calls = 0;
    tls_records = false;
    task_probe = false;
    yield_us = 1000;
    bio_gap_us = 0;
    bio_chunk = 1;
    fail_get = last_halt = false;
    original = current_timeout = (struct timeval){.tv_sec = 2};
    for (size_t i = 0; i < sizeof(source); i++)
        source[i] = (uint8_t)(i * 17 + (i / 251));
    errno = 0;
}
void vTaskDelay(unsigned ticks)
{
    assert(ticks == 1);
    yields++;
    mock_time += yield_us;
}
int __wrap_mbedtls_net_recv(void *context, unsigned char *buffer, size_t length);
static void *probe_other_task(void *unused)
{
    (void)unused;
    assert(media_ws_recv_before_tls_recv(42) == 0 && media_ws_recv_after_tls_recv(42) == 0);
    return NULL;
}
int __real_mbedtls_net_recv(void *context, unsigned char *buffer, size_t length)
{
    assert(context && ((mbedtls_net_context *)context)->fd == 42);
    bio_calls++;
    if (task_probe) {
        task_probe = false;
        unsigned before = set_calls;
        pthread_t thread;
        assert(pthread_create(&thread, NULL, probe_other_task, NULL) == 0);
        assert(pthread_join(thread, NULL) == 0);
        assert(set_calls == before);
    }
    int64_t limit = (int64_t)current_timeout.tv_sec * 1000000 + current_timeout.tv_usec;
    if (limit && bio_gap_us >= limit) {
        mock_time += limit;
        errno = EAGAIN;
        return MBEDTLS_ERR_SSL_WANT_READ;
    }
    mock_time += bio_gap_us;
    size_t n = bio_chunk < length ? bio_chunk : length;
    assert(source_at + n <= sizeof(source));
    memcpy(buffer, source + source_at, n);
    source_at += n;
    return (int)n;
}
int __real_mbedtls_net_send(void *context, const unsigned char *buffer, size_t length)
{
    (void)context; (void)buffer;
    return (int)length;
}
int __real_esp_tls_server_session_create(esp_tls_cfg_server_t *config, int fd, esp_tls_t *tls)
{
    (void)config; (void)fd; (void)tls;
    return 0;
}
int httpd_req_to_sockfd(httpd_req_t *req) { return req->fd; }
httpd_ws_client_info_t httpd_ws_get_fd_info(httpd_handle_t handle, int fd)
{
    assert((handle == &request && fd == request.fd) ||
           (handle == &other_request && fd == other_request.fd));
    return client_type;
}
int __real_httpd_recv_with_opt(httpd_req_t *req, char *buffer, size_t length, bool halt)
{
    assert(req == &request || req == &other_request || !req);
    assert(calls < 64);
    wanted[calls] = length;
    last_halt = halt;
    int n = parts[calls];
    mock_time += elapsed[calls++];
    if (tls_records) {
        unsigned before = set_calls;
        assert(media_ws_recv_before_tls_recv(43) == 0 && media_ws_recv_after_tls_recv(43) == 0);
        assert(set_calls == before);
        /* Model one SSL read fetching a record in several BIO reads. */
        mbedtls_net_context context = {.fd = req->fd};
        size_t got = 0;
        while (got < length) {
            int result = __wrap_mbedtls_net_recv(&context, (unsigned char *)buffer + got, length - got);
            if (result <= 0)
                return result;
            got += (size_t)result;
        }
        return (int)got;
    }
    size_t prefix = pending_bytes < length ? pending_bytes : length;
    if (prefix) {
        assert(source_at + prefix <= sizeof(source));
        memcpy(buffer, source + source_at, prefix);
        source_at += prefix;
        pending_bytes -= prefix;
        if (halt || prefix == length)
            return (int)prefix;
        /* Match IDF's real pending-prefix behavior, including its raw TLS
         * WANT case which discards the prefix count for a non-halting read. */
        buffer += prefix;
        length -= prefix;
    }
    if (n < 0)
        errno = n == HTTPD_SOCK_ERR_TIMEOUT || n == ESP_TLS_ERR_SSL_WANT_READ ? EAGAIN : EIO;
    if (n > 0 && (size_t)n <= length && buffer) {
        assert(source_at + (size_t)n <= sizeof(source));
        memcpy(buffer, source + source_at, (size_t)n);
        source_at += (size_t)n;
    }
    return n < 0 ? n == HTTPD_SOCK_ERR_TIMEOUT && prefix ? (int)prefix : n : n + (int)prefix;
}
int getsockopt(int fd, int level, int option, void *value, socklen_t *length)
{
    assert(fd == 42 && level == SOL_SOCKET && option == SO_RCVTIMEO);
    assert(*length == sizeof(original));
    get_calls++;
    if (fail_get)
        return -1;
    memcpy(value, &current_timeout, sizeof(current_timeout));
    return 0;
}
int setsockopt(int fd, int level, int option, const void *value, socklen_t length)
{
    assert(fd == 42 && level == SOL_SOCKET && option == SO_RCVTIMEO);
    assert(length == sizeof(current_timeout) && set_calls < 256);
    const struct timeval *timeout = value;
    timeouts[set_calls++] = (int64_t)timeout->tv_sec * 1000000 + timeout->tv_usec;
    if (set_calls == fail_set)
    {
        errno = EINVAL;
        return -1;
    }
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
static bool original_timeout(void)
{
    return !memcmp(&current_timeout, &original, sizeof(original));
}
static void scoped_tests(void)
{
    uint8_t buffer[32816];
    /* One scope spans the SDK's extended-length and mask reads, then the
     * entire 32KiB payload across TLS records. A 2.5s Wi-Fi gap is valid. */
    reset();
    parts[0] = 1; parts[1] = 1; parts[2] = 2; parts[3] = 2;
    parts[4] = 16384; parts[5] = 16416;
    elapsed[0] = 100000; elapsed[2] = 100000;
    elapsed[4] = 2500000; elapsed[5] = 2500000;
    assert(media_ws_recv_begin(&request) == 0 && get_calls == 1 && !set_calls);
    assert(__wrap_httpd_recv_with_opt(&request, (char *)buffer, 2, false) == 2);
    assert(original_timeout());
    assert(__wrap_httpd_recv_with_opt(&request, (char *)buffer + 2, 4, false) == 4);
    assert(original_timeout());
    assert(__wrap_httpd_recv_with_opt(&request, (char *)buffer + 6, 32800, false) == 16384);
    assert(original_timeout());
    assert(__wrap_httpd_recv_with_opt(&request, (char *)buffer + 16390, 16416, false) == 16416);
    assert(original_timeout() && !memcmp(buffer, source, 32806));
    assert(timeouts[0] == 10000000 && timeouts[2] == 9900000);
    assert(timeouts[8] == 9800000 && timeouts[10] == 7300000);
    assert(media_ws_recv_end(&request) == 0 && calls == 6 && get_calls == 1);

    /* The HTTPS receiver returns raw TLS WANT codes. Early retryable timeout
     * results do not create a new deadline or discard earlier header bytes. */
    reset();
    parts[0] = 1; parts[1] = ESP_TLS_ERR_SSL_WANT_READ;
    parts[2] = ESP_TLS_ERR_SSL_WANT_WRITE; parts[3] = HTTPD_SOCK_ERR_TIMEOUT;
    parts[4] = 3;
    elapsed[1] = 2500000; elapsed[2] = 100000; elapsed[3] = 100000;
    assert(media_ws_recv_begin(&request) == 0);
    assert(__wrap_httpd_recv_with_opt(&request, (char *)buffer, 4, false) == 4);
    assert(!memcmp(buffer, source, 4) && wanted[4] == 3 && calls == 5);
    assert(timeouts[8] == 7297000 && original_timeout() && yields == 3);
    assert(media_ws_recv_end(&request) == 0);

    /* Count the pending prefix before a later raw TLS WANT; it must neither
     * disappear nor be copied a second time when the receiver retries. */
    reset(); pending_bytes = 1;
    parts[0] = ESP_TLS_ERR_SSL_WANT_READ; /* Not reached while prefix is pending. */
    parts[1] = ESP_TLS_ERR_SSL_WANT_READ; parts[2] = 3;
    assert(media_ws_recv_begin(&request) == 0 && receive(4) == 4);
    assert(last_halt && calls == 3 && source_at == 4 && yields == 1 && original_timeout());
    assert(media_ws_recv_end(&request) == 0);
    /* Immediate nonblocking WANT results yield, but never renew the budget. */
    reset(); yield_us = 1000000;
    for (unsigned i = 0; i < 10; i++) parts[i] = ESP_TLS_ERR_SSL_WANT_READ;
    assert(media_ws_recv_begin(&request) == 0);
    assert(receive(4) == HTTPD_SOCK_ERR_TIMEOUT && calls == 10 && yields == 10);
    assert(mock_time == 10000000 && media_ws_recv_end(&request) == HTTPD_SOCK_ERR_TIMEOUT);

    /* A single TLS read can fetch multiple progressing BIO fragments. The
     * real shared BIO wrapper re-clamps every wait, stopping at 10s rather
     * than allowing another full timeout for each fragment. */
    reset(); tls_records = task_probe = true; bio_gap_us = 1000000;
    assert(media_ws_recv_begin(&request) == 0 && receive(8) == 8);
    assert(bio_calls == 8 && calls == 1 && mock_time == 8000000 && original_timeout());
    assert(timeouts[1] == 10000000 && timeouts[8] == 3000000);
    assert(media_ws_recv_end(&request) == 0);
    reset(); tls_records = true; bio_gap_us = 1500000;
    assert(media_ws_recv_begin(&request) == 0);
    assert(receive(8) == HTTPD_SOCK_ERR_TIMEOUT);
    assert(bio_calls == 7 && calls == 1 && mock_time == 10000000 && original_timeout());
    assert(timeouts[7] == 1000000 && !yields);
    assert(media_ws_recv_end(&request) == HTTPD_SOCK_ERR_TIMEOUT);
    for (unsigned at = 2; at <= 3; at++) {
        reset(); tls_records = true; fail_set = at;
        assert(media_ws_recv_begin(&request) == 0 && receive(8) == HTTPD_SOCK_ERR_FAIL);
        assert(original_timeout() && media_ws_recv_end(&request) == HTTPD_SOCK_ERR_FAIL);
    }
    reset(); tls_records = true; fail_set = 10; /* After eight BIO fragments. */
    assert(media_ws_recv_begin(&request) == 0 && receive(8) == HTTPD_SOCK_ERR_FAIL);
    assert(media_ws_recv_end(&request) == HTTPD_SOCK_ERR_FAIL && original_timeout() && set_calls == 11);
    reset(); tls_records = true; bio_chunk = 8;
    assert(media_ws_recv_begin(&request) == 0);
    assert(media_ws_recv_before_tls_recv(42) == 0 && media_ws_recv_after_tls_recv(42) == 0);
    assert(!set_calls); /* Scope exists, but no scoped receive is active. */
    assert(__wrap_httpd_recv_with_opt(&request, (char *)buffer, 8, true) == 8);
    assert(bio_calls == 1 && !set_calls && original_timeout());
    assert(media_ws_recv_end(&request) == 0);

    /* Progress never renews the total budget, even across separate payload
     * calls. A positive complete return at the deadline is still too late. */
    uint32_t expired = media_ws_recv_frame_timeouts();
    reset(); parts[0] = 10; parts[1] = 10;
    elapsed[0] = 6000000; elapsed[1] = 4000000;
    assert(media_ws_recv_begin(&request) == 0);
    assert(__wrap_httpd_recv_with_opt(&request, (char *)buffer, 20, false) == 10);
    assert(__wrap_httpd_recv_with_opt(&request, (char *)buffer + 10, 10, false) == HTTPD_SOCK_ERR_TIMEOUT);
    assert(timeouts[2] == 4000000 && original_timeout() && calls == 2);
    assert(__wrap_httpd_recv_with_opt(&request, (char *)buffer, 20, false) == HTTPD_SOCK_ERR_TIMEOUT);
    assert(calls == 2 && media_ws_recv_frame_timeouts() == expired + 1);
    assert(media_ws_recv_end(&request) == HTTPD_SOCK_ERR_TIMEOUT && errno == ETIMEDOUT);
    assert(media_ws_recv_frame_timeouts() == expired + 1);
    reset(); parts[0] = 1; parts[1] = 1; elapsed[0] = 9999000; elapsed[1] = 1000;
    assert(media_ws_recv_begin(&request) == 0);
    assert(receive(2) == HTTPD_SOCK_ERR_TIMEOUT && original_timeout());
    assert(timeouts[2] == 1000 && media_ws_recv_end(&request) == HTTPD_SOCK_ERR_TIMEOUT);
    reset();
    assert(media_ws_recv_begin(&request) == 0);
    mock_time = 10000000;
    assert(receive(2) == HTTPD_SOCK_ERR_TIMEOUT && !calls && !set_calls);
    assert(media_ws_recv_end(&request) == HTTPD_SOCK_ERR_TIMEOUT && original_timeout());
    reset(); parts[0] = 4;
    assert(media_ws_recv_begin(&request) == 0 && receive(4) == 4);
    mock_time = 10000000; /* End checks elapsed time too. */
    assert(media_ws_recv_end(&request) == HTTPD_SOCK_ERR_TIMEOUT);

    /* Continuation frames inherit the original message deadline rather than
     * buying another ten seconds after every completed fragment. */
    reset(); parts[0] = parts[1] = 4;
    elapsed[0] = 1500000; elapsed[1] = 500000;
    assert(media_ws_recv_begin_until(&request, 2000000) == 0);
    assert(receive(4) == 4 && media_ws_recv_end(&request) == 0);
    assert(media_ws_recv_begin_until(&request, 2000000) == 0);
    assert(receive(4) == HTTPD_SOCK_ERR_TIMEOUT && original_timeout());
    assert(media_ws_recv_end(&request) == HTTPD_SOCK_ERR_TIMEOUT);
    uint32_t fragment_timeouts = media_ws_recv_frame_timeouts();
    assert(media_ws_recv_begin_until(&request, 2000000) == HTTPD_SOCK_ERR_TIMEOUT);
    assert(media_ws_recv_frame_timeouts() == fragment_timeouts + 1);

    /* Fatal errors and EOF fail immediately, preserving the first cause and
     * restoring the original timeout before end and after every call. */
    const int errors[] = {0, HTTPD_SOCK_ERR_FAIL, HTTPD_SOCK_ERR_INVALID, -0x7200};
    for (size_t i = 0; i < sizeof(errors) / sizeof(errors[0]); i++) {
        reset(); parts[0] = 1; parts[1] = errors[i];
        int expected = errors[i] ? errors[i] : HTTPD_SOCK_ERR_FAIL;
        assert(media_ws_recv_begin(&request) == 0);
        assert(receive(4) == expected && calls == 2 && original_timeout());
        assert(receive(4) == expected && calls == 2);
        assert(media_ws_recv_end(&request) == expected);
    }
    reset(); parts[0] = -0x7200; fail_set = 2;
    assert(media_ws_recv_begin(&request) == 0 && receive(4) == -0x7200);
    assert(media_ws_recv_end(&request) == -0x7200 && errno == EIO && original_timeout());
    reset(); parts[0] = HTTPD_SOCK_ERR_TIMEOUT; elapsed[0] = 10000000;
    assert(media_ws_recv_begin(&request) == 0);
    assert(receive(4) == HTTPD_SOCK_ERR_TIMEOUT && original_timeout());
    assert(media_ws_recv_end(&request) == HTTPD_SOCK_ERR_TIMEOUT);
    reset(); parts[0] = 3;
    assert(media_ws_recv_begin(&request) == 0);
    assert(receive(2) == HTTPD_SOCK_ERR_FAIL && original_timeout());
    assert(media_ws_recv_end(&request) == HTTPD_SOCK_ERR_FAIL);

    /* A broken socket option is fatal. End retries a failed restoration. */
    reset(); fail_get = true;
    assert(media_ws_recv_begin(&request) == HTTPD_SOCK_ERR_FAIL && !calls && !set_calls);
    assert(media_ws_recv_end(&request) == HTTPD_SOCK_ERR_INVALID);
    for (unsigned at = 1; at <= 2; at++) {
        reset(); parts[0] = 4; fail_set = at;
        assert(media_ws_recv_begin(&request) == 0);
        assert(receive(4) == HTTPD_SOCK_ERR_FAIL);
        assert(media_ws_recv_end(&request) == HTTPD_SOCK_ERR_FAIL);
        assert(original_timeout() && calls == (at == 1 ? 0u : 1u));
        assert(set_calls == (at == 1 ? 1u : 3u));
    }
    reset(); original = current_timeout = (struct timeval){0}; parts[0] = 4;
    assert(media_ws_recv_begin(&request) == 0 && receive(4) == 4);
    assert(timeouts[0] == 10000000 && timeouts[1] == 0 && original_timeout());
    assert(media_ws_recv_end(&request) == 0);

    /* Explicit scoping never changes HTTP/pending-only/other request reads.
     * A nested or mismatched end cannot replace or clear the real scope. */
    reset(); client_type = HTTPD_WS_CLIENT_HTTP;
    assert(media_ws_recv_begin(&request) == HTTPD_SOCK_ERR_INVALID && !get_calls);
    reset();
    assert(media_ws_recv_begin(NULL) == HTTPD_SOCK_ERR_INVALID);
    assert(media_ws_recv_begin(&request) == 0);
    assert(media_ws_recv_begin(&other_request) == HTTPD_SOCK_ERR_INVALID);
    assert(media_ws_recv_end(&other_request) == HTTPD_SOCK_ERR_INVALID);
    parts[0] = 1;
    assert(__wrap_httpd_recv_with_opt(&request, (char *)buffer, 4, true) == 1);
    assert(last_halt && calls == 1 && !set_calls && original_timeout());
    parts[1] = 1;
    assert(__wrap_httpd_recv_with_opt(&other_request, (char *)buffer, 9, false) == 1);
    assert(calls == 2 && get_calls == 1 && !set_calls && original_timeout());
    request.fd = 44; parts[2] = 1;
    assert(__wrap_httpd_recv_with_opt(&request, (char *)buffer, 9, false) == 1);
    assert(calls == 3 && get_calls == 1 && !set_calls);
    request.fd = 42;
    assert(media_ws_recv_end(&request) == 0);
    assert(media_ws_recv_end(&request) == HTTPD_SOCK_ERR_INVALID);
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
    scoped_tests();
    puts("PASS: exact split WebSocket headers, 10s total frame budget, delayed payloads, failures, restoration and HTTP/pending pass-through");
}
