#pragma once
#include <stddef.h>
#include <stdbool.h>
#include "esp_err.h"
typedef void *httpd_handle_t;
typedef struct {
    const char *uri;
    size_t content_len;
    void *user_ctx;
    void *test;
    void *sess_ctx;
    void (*free_ctx)(void *);
} httpd_req_t;
typedef struct {
    const char *uri;
    int method;
    esp_err_t (*handler)(httpd_req_t *);
    void *user_ctx;
} httpd_uri_t;
#define HTTP_GET 1
#define HTTP_POST 2
#define HTTPD_400_BAD_REQUEST 400
#define HTTPD_401_UNAUTHORIZED 401
#define HTTPD_403_FORBIDDEN 403
#define HTTPD_404_NOT_FOUND 404
esp_err_t httpd_req_get_hdr_value_str(httpd_req_t *req, const char *name, char *value, size_t length);
int httpd_req_recv(httpd_req_t *req, char *buffer, size_t length);
esp_err_t httpd_resp_set_hdr(httpd_req_t *req, const char *name, const char *value);
esp_err_t httpd_resp_set_type(httpd_req_t *req, const char *value);
esp_err_t httpd_resp_set_status(httpd_req_t *req, const char *value);
esp_err_t httpd_resp_sendstr(httpd_req_t *req, const char *value);
esp_err_t httpd_resp_send_err(httpd_req_t *req, int code, const char *value);
esp_err_t httpd_resp_send(httpd_req_t *req, const char *value, int length);
esp_err_t httpd_resp_send_chunk(httpd_req_t *req, const char *value, size_t length);
esp_err_t httpd_register_uri_handler(httpd_handle_t server, const httpd_uri_t *uri);
