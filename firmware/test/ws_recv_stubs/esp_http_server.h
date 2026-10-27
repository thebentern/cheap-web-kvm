#pragma once
#include <stdbool.h>
#include <stddef.h>
typedef void *httpd_handle_t;
typedef struct { httpd_handle_t handle; int fd; } httpd_req_t;
typedef enum { HTTPD_WS_CLIENT_INVALID, HTTPD_WS_CLIENT_HTTP, HTTPD_WS_CLIENT_WEBSOCKET } httpd_ws_client_info_t;
#define HTTPD_SOCK_ERR_FAIL -1
#define HTTPD_SOCK_ERR_INVALID -2
#define HTTPD_SOCK_ERR_TIMEOUT -3
int httpd_req_to_sockfd(httpd_req_t *req);
httpd_ws_client_info_t httpd_ws_get_fd_info(httpd_handle_t handle, int fd);
