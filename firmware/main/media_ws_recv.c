/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "sdkconfig.h"
#if CONFIG_KVM_MEDIA_WIFI && CONFIG_HTTPD_WS_SUPPORT
#include "media_ws_recv.h"
#include "esp_timer.h"
#include "esp_tls_errors.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include <errno.h>
#include <stdatomic.h>
#include <stdint.h>
#include <string.h>

/* Same signature as IDF's esp_httpd_priv.h; the real receiver preserves TLS
 * overrides and HTTPD's pending bytes. Never receive directly from the fd. */
int __real_httpd_recv_with_opt(httpd_req_t *req, char *buffer, size_t length, bool halt_after_pending);

enum { FRAME_BUDGET_US = 10000000 };
static __thread struct {
    httpd_req_t *req;
    int fd;
    int64_t deadline;
    struct timeval original;
    int failure, failure_errno;
    bool receiving, changed_timeout, expired;
} frame;
static atomic_uint frame_timeouts;

static bool valid_timeout(const struct timeval *timeout)
{
    return timeout->tv_sec >= 0 && timeout->tv_usec >= 0 && timeout->tv_usec < 1000000;
}

static int frame_failure(int error)
{
    if (!frame.failure) {
        frame.failure = error < 0 ? error : HTTPD_SOCK_ERR_FAIL;
        frame.failure_errno = errno;
    }
    return frame.failure;
}

static int frame_expired(void)
{
    if (!frame.expired) {
        frame.expired = true;
        atomic_fetch_add(&frame_timeouts, 1);
    }
    errno = ETIMEDOUT;
    return frame_failure(HTTPD_SOCK_ERR_TIMEOUT);
}

static int restore_timeout(void)
{
    if (!frame.changed_timeout)
        return 0;
    if (setsockopt(frame.fd, SOL_SOCKET, SO_RCVTIMEO, &frame.original, sizeof(frame.original)) != 0)
        return frame_failure(HTTPD_SOCK_ERR_FAIL);
    frame.changed_timeout = false;
    return 0;
}

static int limit_timeout(void)
{
    if (frame.failure)
        return frame.failure;
    int64_t remaining = frame.deadline - esp_timer_get_time();
    if (remaining <= 0)
        return frame_expired();
    /* lwIP resolves timeouts in milliseconds; zero would mean unlimited. */
    remaining = ((remaining + 999) / 1000) * 1000;
    struct timeval timeout = {.tv_sec = remaining / 1000000,
                              .tv_usec = remaining % 1000000};
    if (setsockopt(frame.fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) != 0)
        return frame_failure(HTTPD_SOCK_ERR_FAIL);
    frame.changed_timeout = true;
    return 0;
}

int media_ws_recv_before_tls_recv(int fd)
{
    return frame.req && frame.receiving && frame.fd == fd ? limit_timeout() : 0;
}

int media_ws_recv_after_tls_recv(int fd)
{
    if (!frame.req || !frame.receiving || frame.fd != fd)
        return 0;
    if (frame.failure)
        return frame.failure;
    return esp_timer_get_time() >= frame.deadline ? frame_expired() : 0;
}

int media_ws_recv_begin(httpd_req_t *req)
{
    return media_ws_recv_begin_until(req, 0);
}

int media_ws_recv_begin_until(httpd_req_t *req, int64_t deadline)
{
    if (frame.req || !req || !req->handle)
        return HTTPD_SOCK_ERR_INVALID;
    int fd = httpd_req_to_sockfd(req);
    if (fd < 0 || httpd_ws_get_fd_info(req->handle, fd) != HTTPD_WS_CLIENT_WEBSOCKET)
        return HTTPD_SOCK_ERR_INVALID;
    int64_t started = esp_timer_get_time();
    if (deadline && deadline <= started) {
        atomic_fetch_add(&frame_timeouts, 1);
        errno = ETIMEDOUT;
        return HTTPD_SOCK_ERR_TIMEOUT;
    }
    struct timeval original;
    socklen_t option_length = sizeof(original);
    if (getsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &original, &option_length) != 0 ||
        option_length != sizeof(original) || !valid_timeout(&original))
        return HTTPD_SOCK_ERR_FAIL;
    frame.req = req;
    frame.fd = fd;
    frame.deadline = started + FRAME_BUDGET_US;
    if (deadline && deadline < frame.deadline)
        frame.deadline = deadline;
    frame.original = original;
    return 0;
}

int media_ws_recv_end(httpd_req_t *req)
{
    if (!frame.req || frame.req != req)
        return HTTPD_SOCK_ERR_INVALID;
    /* Retry restoration if an earlier restore failed, before forgetting scope. */
    (void)restore_timeout();
    if (!frame.failure && esp_timer_get_time() >= frame.deadline)
        (void)frame_expired();
    int result = frame.failure;
    int saved_errno = frame.failure_errno;
    memset(&frame, 0, sizeof(frame));
    if (result)
        errno = saved_errno;
    return result;
}

uint32_t media_ws_recv_frame_timeouts(void)
{
    return atomic_load(&frame_timeouts);
}

static bool retry_receive(int error)
{
    if (error == HTTPD_SOCK_ERR_TIMEOUT)
        return true;
#ifdef ESP_TLS_ERR_SSL_WANT_READ
    if (error == ESP_TLS_ERR_SSL_WANT_READ || error == ESP_TLS_ERR_SSL_WANT_WRITE)
        return true;
#endif
    return false;
}

static int receive_frame(httpd_req_t *req, char *buffer, size_t length)
{
    if (frame.failure)
        return frame.failure;
    /* IDF needs complete 2/4/8-byte header fields. Its payload loop already
     * handles shorter positive returns, all under this same frame deadline. */
    bool exact = length == 2 || length == 4 || length == 8;
    size_t received = 0;
    do {
        int result = limit_timeout();
        if (result)
            return result;
        frame.receiving = true;
        /* IDF otherwise loses a pending prefix's byte count when its following
         * TLS read returns WANT_READ. Return that prefix separately first. */
        result = __real_httpd_recv_with_opt(req, buffer + received, length - received, true);
        frame.receiving = false;
        int receive_errno = errno;
        if (esp_timer_get_time() >= frame.deadline)
            (void)frame_expired();
        else if (!retry_receive(result) && (result <= 0 || (size_t)result > length - received))
            (void)frame_failure(result <= 0 ? result : HTTPD_SOCK_ERR_FAIL);
        /* Ordinary HTTP and pending-only reads must not inherit our timeout,
         * even if IDF makes one while a frame scope is active. */
        (void)restore_timeout();
        errno = receive_errno;
        if (frame.failure)
            return frame.failure;
        if (esp_timer_get_time() >= frame.deadline)
            return frame_expired(); /* Also reject a complete but late read. */
        if (retry_receive(result)) {
            /* A nonblocking TLS WANT result may make no progress. Yield a
             * tick so retries cannot monopolize this HTTP task/CPU; the same
             * deadline includes this delay. */
            vTaskDelay(1);
            continue;
        }
        received += (size_t)result;
        if (!exact)
            return (int)received;
    } while (received < length);
    return (int)received;
}

int __wrap_httpd_recv_with_opt(httpd_req_t *req, char *buffer, size_t length, bool halt_after_pending)
{
    if (frame.req && req == frame.req && !halt_after_pending && buffer && length &&
        httpd_req_to_sockfd(req) == frame.fd)
        return receive_frame(req, buffer, length);
    if (halt_after_pending || !req || !req->handle || !buffer ||
        (length != 2 && length != 4 && length != 8))
        return __real_httpd_recv_with_opt(req, buffer, length, halt_after_pending);
    int fd = httpd_req_to_sockfd(req);
    if (fd < 0 || httpd_ws_get_fd_info(req->handle, fd) != HTTPD_WS_CLIENT_WEBSOCKET)
        return __real_httpd_recv_with_opt(req, buffer, length, halt_after_pending);

    int64_t started = esp_timer_get_time();
    int result = __real_httpd_recv_with_opt(req, buffer, length, false);
    /* The normal complete read has no socket-option overhead. The existing
     * server receive timeout (1s HTTP / 2s HTTPS) bounds this first call. */
    if (result <= 0 || (size_t)result == length)
        return result;
    if ((size_t)result > length)
        return HTTPD_SOCK_ERR_FAIL;

    struct timeval original;
    socklen_t option_length = sizeof(original);
    if (getsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &original, &option_length) != 0 ||
        option_length != sizeof(original) || original.tv_sec < 0 ||
        original.tv_usec < 0 || original.tv_usec >= 1000000)
        return HTTPD_SOCK_ERR_FAIL;
    int64_t budget = 2000000;
    if (original.tv_sec < 2 && (original.tv_sec || original.tv_usec))
        budget = (int64_t)original.tv_sec * 1000000 + original.tv_usec;
    int64_t deadline = started + budget;
    size_t received = (size_t)result;
    bool changed_timeout = false;
    while (received < length) {
        int64_t remaining = deadline - esp_timer_get_time();
        if (remaining <= 0) {
            result = HTTPD_SOCK_ERR_TIMEOUT;
            break;
        }
        /* Round up to a millisecond so a sub-millisecond remainder never
         * becomes a zero (unlimited) lwIP socket timeout. */
        remaining = ((remaining + 999) / 1000) * 1000;
        struct timeval timeout = {.tv_sec = remaining / 1000000,
                                  .tv_usec = remaining % 1000000};
        if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) != 0) {
            result = HTTPD_SOCK_ERR_FAIL;
            break;
        }
        changed_timeout = true;
        result = __real_httpd_recv_with_opt(req, buffer + received, length - received, false);
        if (result <= 0)
            break; /* Never report a partially filled header as success. */
        if ((size_t)result > length - received) {
            result = HTTPD_SOCK_ERR_FAIL;
            break;
        }
        received += (size_t)result;
        if (received == length)
            result = (int)length;
    }
    if (changed_timeout && setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &original, sizeof(original)) != 0)
        return HTTPD_SOCK_ERR_FAIL;
    return result;
}
#endif
