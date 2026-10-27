/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "media_tls_guard.h"
#include "esp_tls.h"
#include "lwip/sockets.h"
#include "mbedtls/net_sockets.h"
#include "mbedtls/ssl.h"
#include <assert.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

int __wrap_esp_tls_server_session_create(esp_tls_cfg_server_t *, int, esp_tls_t *);
int __wrap_mbedtls_net_recv(void *, unsigned char *, size_t);
int __wrap_mbedtls_net_send(void *, const unsigned char *, size_t);
int64_t mock_time;
static enum { SUCCESS, WANT_READ, WANT_WRITE, PROGRESS, ERROR, CPU_EXPIRED,
              OTHER_FD, OTHER_THREAD, LAST_MICROSECOND, NESTED } mode;
static struct timeval original_receive, original_send, current_receive, current_send;
static unsigned get_calls, set_calls, recv_calls, send_calls, create_calls, fail_get, fail_set;
static int64_t get_time, first_receive_limit, first_send_limit;
static esp_tls_cfg_server_t config = {.certificate = "test certificate", .verify = 123};
static esp_tls_t tls = {.marker = 456};
static __thread bool other_thread;
static int64_t microseconds(const struct timeval *value)
{
    return (int64_t)value->tv_sec * 1000000 + value->tv_usec;
}
static void reset(void)
{
    mode = SUCCESS;
    mock_time = get_time = 0;
    get_calls = set_calls = recv_calls = send_calls = create_calls = fail_get = fail_set = 0;
    first_receive_limit = first_send_limit = 0;
    original_receive = current_receive = (struct timeval){.tv_sec = 2};
    original_send = current_send = (struct timeval){.tv_sec = 2};
}
int getsockopt(int fd, int level, int option, void *value, socklen_t *length)
{
    assert(fd == 42 && level == SOL_SOCKET && *length == sizeof(struct timeval));
    get_calls++;
    mock_time += get_time;
    if (get_calls == fail_get)
        return -1;
    assert(option == SO_RCVTIMEO || option == SO_SNDTIMEO);
    *(struct timeval *)value = option == SO_RCVTIMEO ? original_receive : original_send;
    return 0;
}
int setsockopt(int fd, int level, int option, const void *value, socklen_t length)
{
    assert(fd == 42 && level == SOL_SOCKET && length == sizeof(struct timeval));
    set_calls++;
    if (set_calls == fail_set)
        return -1;
    const struct timeval *timeout = value;
    if (option == SO_RCVTIMEO) {
        if (!first_receive_limit) first_receive_limit = microseconds(timeout);
        current_receive = *timeout;
    } else {
        assert(option == SO_SNDTIMEO);
        if (!first_send_limit) first_send_limit = microseconds(timeout);
        current_send = *timeout;
    }
    return 0;
}
int __real_mbedtls_net_recv(void *context, unsigned char *buffer, size_t length)
{
    (void)buffer;
    assert(context && length == 8);
    recv_calls++;
    if (other_thread || mode == OTHER_FD || mode == LAST_MICROSECOND)
        return 8;
    mock_time += mode == SUCCESS || mode == NESTED || mode == ERROR ? 100000 : 500000;
    if (mode == ERROR) return MBEDTLS_ERR_NET_RECV_FAILED;
    if (mode == WANT_READ) return MBEDTLS_ERR_SSL_WANT_READ;
    if (mode == PROGRESS) return 1;
    return 8;
}
int __real_mbedtls_net_send(void *context, const unsigned char *buffer, size_t length)
{
    (void)buffer;
    assert(context && length == 8);
    send_calls++;
    mock_time += mode == WANT_WRITE ? 500000 : 100000;
    return mode == WANT_WRITE ? MBEDTLS_ERR_SSL_WANT_WRITE : 8;
}
static void *unrelated_task(void *unused)
{
    (void)unused;
    other_thread = true;
    mbedtls_net_context context = {.fd = 42};
    unsigned char buffer[8];
    assert(__wrap_mbedtls_net_recv(&context, buffer, sizeof(buffer)) == 8);
    return NULL;
}
int __real_esp_tls_server_session_create(esp_tls_cfg_server_t *cfg, int fd, esp_tls_t *session)
{
    if (!cfg || !session || fd < 0)
        return -1;
    assert(cfg == &config && session == &tls && fd == 42);
    assert(cfg->verify == 123 && session->marker == 456);
    create_calls++;
    mbedtls_net_context context = {.fd = mode == OTHER_FD ? 99 : fd};
    unsigned char buffer[8] = {0};
    if (mode == CPU_EXPIRED) {
        mock_time += 2000001;
        return 0;
    }
    if (mode == OTHER_THREAD) {
        pthread_t thread;
        assert(pthread_create(&thread, NULL, unrelated_task, NULL) == 0);
        assert(pthread_join(thread, NULL) == 0);
        return 0;
    }
    if (mode == LAST_MICROSECOND)
        mock_time = 1999999;
    if (mode == NESTED)
        assert(__wrap_esp_tls_server_session_create(cfg, fd, session) == MBEDTLS_ERR_SSL_BAD_INPUT_DATA);
    unsigned progress = 0;
    for (unsigned attempts = 0; attempts < 16; attempts++) {
        int result = mode == WANT_WRITE ? __wrap_mbedtls_net_send(&context, buffer, sizeof(buffer))
                                       : __wrap_mbedtls_net_recv(&context, buffer, sizeof(buffer));
        if (result == MBEDTLS_ERR_SSL_WANT_READ || result == MBEDTLS_ERR_SSL_WANT_WRITE)
            continue; /* Same retry semantics as the actual SDK server function. */
        if (result < 0)
            return result;
        progress += (unsigned)result;
        if (progress < 8)
            continue;
        if (mode == SUCCESS || mode == NESTED) {
            result = __wrap_mbedtls_net_send(&context, buffer, sizeof(buffer));
            if (result < 0) return result;
        }
        return 0;
    }
    assert(!"handshake retry escaped its total deadline");
    return -1;
}
static int handshake(void)
{
    return __wrap_esp_tls_server_session_create(&config, 42, &tls);
}
static void restored(void)
{
    assert(microseconds(&current_receive) == microseconds(&original_receive));
    assert(microseconds(&current_send) == microseconds(&original_send));
}
int main(void)
{
    reset();
    uint32_t count = media_tls_guard_timeouts();
    assert(handshake() == 0 && create_calls == 1 && get_calls == 2 && set_calls == 4);
    assert(first_receive_limit == 2000000 && first_send_limit == 1900000);
    restored();
    assert(media_tls_guard_timeouts() == count);
    for (unsigned kind = 0; kind < 3; kind++) {
        reset(); mode = kind == 0 ? WANT_READ : kind == 1 ? WANT_WRITE : PROGRESS;
        count = media_tls_guard_timeouts();
        assert(handshake() == MBEDTLS_ERR_SSL_TIMEOUT);
        assert(recv_calls + send_calls == 4 && mock_time == 2000000);
        assert(media_tls_guard_timeouts() == count + 1);
        restored();
    }
    reset(); mode = CPU_EXPIRED; count = media_tls_guard_timeouts();
    assert(handshake() == MBEDTLS_ERR_SSL_TIMEOUT && !set_calls);
    assert(media_tls_guard_timeouts() == count + 1); restored();
    reset(); mode = ERROR; count = media_tls_guard_timeouts();
    assert(handshake() == MBEDTLS_ERR_NET_RECV_FAILED && set_calls == 2);
    assert(media_tls_guard_timeouts() == count); restored();
    /* Do not extend a shorter existing socket limit; zero originals remain
     * bounded during the handshake and are restored only when it exits. */
    reset(); original_receive = current_receive = (struct timeval){.tv_usec = 250000};
    original_send = current_send = (struct timeval){.tv_usec = 500000};
    assert(handshake() == 0 && first_receive_limit == 250000 && first_send_limit == 500000); restored();
    reset(); original_receive = current_receive = original_send = current_send = (struct timeval){0};
    assert(handshake() == 0 && first_receive_limit == 2000000 && first_send_limit == 1900000); restored();
    reset(); mode = LAST_MICROSECOND;
    assert(handshake() == 0 && first_receive_limit == 1000); restored();
    /* Outside the guard, a different socket or a different task does no
     * getsockopt/setsockopt and has no handshake deadline applied to its I/O. */
    reset(); mbedtls_net_context context = {.fd = 42}; unsigned char buffer[8];
    assert(__wrap_mbedtls_net_recv(&context, buffer, sizeof(buffer)) == 8);
    assert(__wrap_mbedtls_net_send(&context, buffer, sizeof(buffer)) == 8);
    assert(!get_calls && !set_calls);
    reset(); mode = OTHER_FD;
    assert(handshake() == 0 && get_calls == 2 && !set_calls); restored();
    reset(); mode = OTHER_THREAD;
    assert(handshake() == 0 && recv_calls == 1 && get_calls == 2 && !set_calls); restored();
    reset(); mode = NESTED;
    assert(handshake() == 0 && create_calls == 1); restored();
    for (unsigned failure = 1; failure <= 2; failure++) {
        reset(); fail_get = failure;
        assert(handshake() < 0 && !create_calls && !set_calls); restored();
    }
    for (unsigned failure = 1; failure <= 4; failure++) {
        reset(); fail_set = failure;
        assert(handshake() < 0); /* Includes failures while restoring either timeout. */
    }
    reset(); get_time = 1000000; count = media_tls_guard_timeouts();
    assert(handshake() == MBEDTLS_ERR_SSL_TIMEOUT && !create_calls && !set_calls);
    assert(media_tls_guard_timeouts() == count + 1); restored();
    reset();
    assert(__wrap_esp_tls_server_session_create(NULL, 42, &tls) == -1 && !get_calls);
    assert(config.verify == 123 && tls.marker == 456);
    puts("PASS: total TLS handshake deadline, WANT/progress loops, scoped BIO callbacks, timeout restoration and task/socket isolation");
}
