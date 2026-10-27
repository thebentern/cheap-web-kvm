/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "sdkconfig.h"
#if CONFIG_KVM_MEDIA_WIFI && CONFIG_HTTPD_WS_SUPPORT
#include "media_ws_recv.h"
#include "esp_timer.h"
#include "lwip/sockets.h"
#include <stdint.h>

/* Same signature as IDF's esp_httpd_priv.h; the real receiver preserves TLS
 * overrides and HTTPD's pending bytes. Never receive directly from the fd. */
int __real_httpd_recv_with_opt(httpd_req_t *req, char *buffer, size_t length, bool halt_after_pending);

int __wrap_httpd_recv_with_opt(httpd_req_t *req, char *buffer, size_t length, bool halt_after_pending)
{
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
