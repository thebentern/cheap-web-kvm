/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "media_tls_guard.h"
#include "sdkconfig.h"
#if CONFIG_KVM_DEVICE_WEB
#include "esp_timer.h"
#include "esp_tls.h"
#include "lwip/sockets.h"
#include "mbedtls/net_sockets.h"
#include "mbedtls/ssl.h"
#include <stdbool.h>
#include <stdatomic.h>

#define HANDSHAKE_BUDGET_US 2000000
typedef struct {
    bool active, expired, recv_changed, send_changed;
    int fd;
    int64_t deadline;
    struct timeval recv_original, send_original;
} handshake_guard_t;
/* ESP-IDF initializes __thread storage for every FreeRTOS task. Concurrent
 * clients/tasks cannot inherit another HTTP server task's handshake policy. */
static __thread handshake_guard_t guard;
static atomic_uint handshake_timeouts;

int __real_esp_tls_server_session_create(esp_tls_cfg_server_t *cfg, int fd, esp_tls_t *tls);
int __real_mbedtls_net_recv(void *context, unsigned char *buffer, size_t length);
int __real_mbedtls_net_send(void *context, const unsigned char *buffer, size_t length);

uint32_t media_tls_guard_timeouts(void) { return atomic_load(&handshake_timeouts); }

static bool expired(void)
{
    if (guard.expired || esp_timer_get_time() >= guard.deadline) {
        guard.expired = true;
        return true;
    }
    return false;
}
static bool valid_timeout(const struct timeval *timeout)
{
    return timeout->tv_sec >= 0 && timeout->tv_usec >= 0 && timeout->tv_usec < 1000000;
}
static int limit_timeout(bool receive)
{
    if (expired())
        return MBEDTLS_ERR_SSL_TIMEOUT;
    int64_t remaining = guard.deadline - esp_timer_get_time();
    if (remaining <= 0) {
        guard.expired = true;
        return MBEDTLS_ERR_SSL_TIMEOUT;
    }
    const struct timeval *original = receive ? &guard.recv_original : &guard.send_original;
    /* A zero socket timeout means unlimited; otherwise retain a shorter
     * original limit. The total handshake budget never restarts on progress. */
    if (original->tv_sec < 2 && (original->tv_sec || original->tv_usec)) {
        int64_t original_us = (int64_t)original->tv_sec * 1000000 + original->tv_usec;
        if (original_us < remaining)
            remaining = original_us;
    }
    /* lwIP has millisecond resolution. Never round a positive remainder down
     * to zero, which would accidentally select an unlimited receive/send. */
    remaining = ((remaining + 999) / 1000) * 1000;
    struct timeval timeout = {.tv_sec = remaining / 1000000,
                              .tv_usec = remaining % 1000000};
    if (setsockopt(guard.fd, SOL_SOCKET, receive ? SO_RCVTIMEO : SO_SNDTIMEO,
                   &timeout, sizeof(timeout)) != 0)
        return receive ? MBEDTLS_ERR_NET_RECV_FAILED : MBEDTLS_ERR_NET_SEND_FAILED;
    if (receive)
        guard.recv_changed = true;
    else
        guard.send_changed = true;
    return 0;
}
static bool guarded_context(void *context)
{
    return guard.active && context && ((mbedtls_net_context *)context)->fd == guard.fd;
}
int __wrap_mbedtls_net_recv(void *context, unsigned char *buffer, size_t length)
{
    if (!guarded_context(context))
        return __real_mbedtls_net_recv(context, buffer, length);
    int result = limit_timeout(true);
    if (result != 0)
        return result;
    result = __real_mbedtls_net_recv(context, buffer, length);
    return expired() ? MBEDTLS_ERR_SSL_TIMEOUT : result;
}
int __wrap_mbedtls_net_send(void *context, const unsigned char *buffer, size_t length)
{
    if (!guarded_context(context))
        return __real_mbedtls_net_send(context, buffer, length);
    int result = limit_timeout(false);
    if (result != 0)
        return result;
    result = __real_mbedtls_net_send(context, buffer, length);
    return expired() ? MBEDTLS_ERR_SSL_TIMEOUT : result;
}
int __wrap_esp_tls_server_session_create(esp_tls_cfg_server_t *cfg, int fd, esp_tls_t *tls)
{
    if (!cfg || !tls || fd < 0)
        return __real_esp_tls_server_session_create(cfg, fd, tls);
    if (guard.active)
        return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    int64_t started = esp_timer_get_time();
    struct timeval receive, send;
    socklen_t size = sizeof(receive);
    if (getsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &receive, &size) != 0 ||
        size != sizeof(receive) || !valid_timeout(&receive))
        return MBEDTLS_ERR_NET_RECV_FAILED;
    size = sizeof(send);
    if (getsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &send, &size) != 0 ||
        size != sizeof(send) || !valid_timeout(&send))
        return MBEDTLS_ERR_NET_SEND_FAILED;
    guard = (handshake_guard_t){.active = true, .fd = fd,
        .deadline = started + HANDSHAKE_BUDGET_US, .recv_original = receive, .send_original = send};
    /* Keep all SDK certificate/configuration/verification handling unchanged.
     * Its WANT_READ/WANT_WRITE loop terminates when our BIO returns TIMEOUT. */
    int result = expired() ? MBEDTLS_ERR_SSL_TIMEOUT : __real_esp_tls_server_session_create(cfg, fd, tls);
    bool timed_out = expired() || result == MBEDTLS_ERR_SSL_TIMEOUT;
    guard.active = false;
    if (guard.recv_changed &&
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &receive, sizeof(receive)) != 0)
        result = MBEDTLS_ERR_NET_RECV_FAILED;
    if (guard.send_changed &&
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &send, sizeof(send)) != 0)
        result = MBEDTLS_ERR_NET_SEND_FAILED;
    guard = (handshake_guard_t){0};
    if (timed_out) {
        atomic_fetch_add(&handshake_timeouts, 1);
        return MBEDTLS_ERR_SSL_TIMEOUT;
    }
    return result;
}
#else
uint32_t media_tls_guard_timeouts(void) { return 0; }
#endif
