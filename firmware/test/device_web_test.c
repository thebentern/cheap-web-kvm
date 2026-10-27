/* SPDX-License-Identifier: GPL-3.0-or-later */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static size_t test_strlcpy(char *out, const char *in, size_t capacity)
{
    size_t size = strlen(in);
    if (capacity) { size_t n = size < capacity - 1 ? size : capacity - 1; memcpy(out, in, n); out[n] = 0; }
    return size;
}
#undef strlcpy
#define strlcpy test_strlcpy
#include "../main/device_web.c"

typedef struct { char name[64], value[1024]; const char *source; } header_t;
typedef struct {
    httpd_req_t req;
    header_t input[12], output[24];
    size_t input_count, output_count;
    const char *request_body;
    size_t received, recv_chunk;
    char body[12000], type[100], policy[640];
    size_t body_size, chunks[8], chunk_count;
    int status;
} request_t;
static int64_t now;
static unsigned entropy;
static bool certificate_ready = true;
static httpd_uri_t routes[8];
static size_t route_count;
static unsigned char asset_bytes[9001];
static kvm_web_asset_t fixture_asset = {"/_nuxt/app.js", "text/javascript", "gzip", "\"fixture\"", asset_bytes, sizeof(asset_bytes)};
static request_t request(bool secure)
{
    request_t r = {0};
    r.req.uri = "/";
    r.req.user_ctx = secure ? (void *)1 : NULL;
    r.status = 200;
    return r;
}
static void link_request(request_t *r) { r->req.test = r; r->req.sess_ctx = r->policy; }
static void input(request_t *r, const char *name, const char *value)
{
    assert(r->input_count < 12);
    header_t *h = &r->input[r->input_count++];
    assert(strlen(name) < sizeof(h->name) && strlen(value) < sizeof(h->value));
    strcpy(h->name, name); strcpy(h->value, value);
}
static const char *output(request_t *r, const char *name)
{
    for (size_t i = 0; i < r->output_count; i++)
        if (!strcmp(r->output[i].name, name)) return r->output[i].value;
    return NULL;
}
static request_t pairing(const char *body, bool secure, const char *origin)
{
    request_t r = request(secure);
    r.request_body = body;
    r.req.content_len = strlen(body);
    r.recv_chunk = 3;
    input(&r, "Host", "192.0.2.10");
    if (origin) input(&r, "Origin", origin);
    input(&r, "Content-Type", "application/json");
    return r;
}
int64_t esp_timer_get_time(void) { return now; }
void esp_fill_random(void *bytes, size_t length)
{
    /* Deterministic nonrepeating test entropy; production uses the ESP RNG. */
    unsigned char *out = bytes;
    unsigned seed = ++entropy;
    for (size_t i = 0; i < length; i++) out[i] = (unsigned char)(seed + i * 7);
}
const char *device_tls_hostname(void) { return "cheap-web-kvm-1234.local"; }
const char *device_tls_fingerprint(void) { return certificate_ready ? "abcdef0123456789" : NULL; }
const char *device_tls_trust_certificate(void) { return certificate_ready ? "PUBLIC-CA-PEM" : NULL; }
const kvm_web_asset_t *kvm_web_asset_find(const char *uri)
{
    return !strcmp(uri, fixture_asset.path) ? &fixture_asset : NULL;
}
esp_err_t httpd_req_get_hdr_value_str(httpd_req_t *req, const char *name, char *value, size_t length)
{
    request_t *r = req->test;
    for (size_t i = 0; i < r->input_count; i++) {
        header_t *h = &r->input[i];
        if (!strcmp(h->name, name)) {
            if (strlen(h->value) >= length) return ESP_FAIL;
            strcpy(value, h->value); return ESP_OK;
        }
    }
    return ESP_FAIL;
}
int httpd_req_recv(httpd_req_t *req, char *buffer, size_t length)
{
    request_t *r = req->test;
    if (!r->request_body || r->received >= req->content_len) return 0;
    if (r->recv_chunk && length > r->recv_chunk) length = r->recv_chunk;
    memcpy(buffer, r->request_body + r->received, length);
    r->received += length;
    return (int)length;
}
esp_err_t httpd_resp_set_hdr(httpd_req_t *req, const char *name, const char *value)
{
    request_t *r = req->test;
    assert(r->output_count < 24);
    header_t *h = &r->output[r->output_count++];
    assert(strlen(name) < sizeof(h->name) && strlen(value) < sizeof(h->value));
    strcpy(h->name, name); strcpy(h->value, value); h->source = value; return ESP_OK;
}
esp_err_t httpd_resp_set_type(httpd_req_t *req, const char *value)
{
    request_t *r = req->test;
    assert(strlen(value) < sizeof(r->type)); strcpy(r->type, value); return ESP_OK;
}
esp_err_t httpd_resp_set_status(httpd_req_t *req, const char *value)
{
    ((request_t *)req->test)->status = atoi(value); return ESP_OK;
}
esp_err_t httpd_resp_send(httpd_req_t *req, const char *value, int length)
{
    request_t *r = req->test;
    size_t n = length < 0 ? strlen(value) : (size_t)length;
    assert(n < sizeof(r->body));
    if (n) memcpy(r->body, value, n);
    r->body[n] = 0; r->body_size = n; return ESP_OK;
}
esp_err_t httpd_resp_sendstr(httpd_req_t *req, const char *value) { return httpd_resp_send(req, value, -1); }
esp_err_t httpd_resp_send_err(httpd_req_t *req, int code, const char *value)
{
    ((request_t *)req->test)->status = code; return httpd_resp_sendstr(req, value);
}
esp_err_t httpd_resp_send_chunk(httpd_req_t *req, const char *value, size_t length)
{
    request_t *r = req->test;
    assert(r->body_size + length < sizeof(r->body) && r->chunk_count < 8);
    if (length) memcpy(r->body + r->body_size, value, length);
    r->body_size += length; r->body[r->body_size] = 0;
    r->chunks[r->chunk_count++] = length; return ESP_OK;
}
esp_err_t httpd_register_uri_handler(httpd_handle_t server, const httpd_uri_t *uri)
{
    assert(server && route_count < 8); routes[route_count++] = *uri; return ESP_OK;
}

static void authentication(void)
{
    device_web_reset_sessions("0123456789abcdefghijklmn");
    request_t r = request(false); link_request(&r);
    input(&r, "X-KVM-Token", "0123456789abcdefghijklmn");
    assert(device_web_authorized(&r.req, false));
    r = request(false); link_request(&r); input(&r, "X-KVM-Token", "0123456789abcdefghijklmx");
    assert(!device_web_authorized(&r.req, false));
    r = request(false); link_request(&r); input(&r, "X-KVM-Token", "0123456789abcdefghijklmn-extra");
    assert(!device_web_authorized(&r.req, false));

    r = pairing("{\"token\":\"0123456789abcdefghijklmn\"}", false, "http://192.0.2.10"); link_request(&r);
    assert(pair(&r.req) == ESP_OK && r.status == 403 && !output(&r, "Set-Cookie"));
    r = pairing("{\"token\":\"0123456789abcdefghijklmn\"}", true, "https://evil.test"); link_request(&r);
    assert(pair(&r.req) == ESP_OK && r.status == 403 && !output(&r, "Set-Cookie"));
    r = pairing("{\"token\":\"wrong\"}", true, "https://192.0.2.10"); link_request(&r);
    assert(pair(&r.req) == ESP_OK && r.status == 401 && !output(&r, "Set-Cookie"));
    r = pairing("{\"token\":\"0123456789abcdefghijklmn\"}", true, "https://192.0.2.10"); link_request(&r);
    assert(pair(&r.req) == ESP_OK && r.status == 204);
    const char *set_cookie = output(&r, "Set-Cookie");
    assert(set_cookie && strstr(set_cookie, "; Secure; HttpOnly; SameSite=Strict;"));
    assert(strstr(set_cookie, "Max-Age=28800") && !strstr(set_cookie, access_token));
    char cookie[180]; snprintf(cookie, sizeof(cookie), "%.*s", 76, set_cookie);
    r = request(true); link_request(&r);
    input(&r, "Host", "192.0.2.10"); input(&r, "Origin", "https://192.0.2.10"); input(&r, "Cookie", cookie);
    assert(device_web_authorized(&r.req, true) && !device_web_authorized(&r.req, false));
    assert(session_valid(&r.req));
    r.input[1].value[0] = 'x'; assert(!device_web_authorized(&r.req, true)); r.input[1].value[0] = 'h';
    snprintf(r.input[0].value, sizeof(r.input[0].value), "192.0.2.10:443");
    assert(!device_web_authorized(&r.req, true));
    snprintf(r.input[1].value, sizeof(r.input[1].value), "https://192.0.2.10:443");
    assert(device_web_authorized(&r.req, true));
    snprintf(r.input[2].value, sizeof(r.input[2].value), "other=ok; %s; trailing=ok", cookie);
    assert(session_valid(&r.req));
    snprintf(r.input[2].value, sizeof(r.input[2].value), "x%s", cookie); assert(!session_valid(&r.req));
    snprintf(r.input[2].value, sizeof(r.input[2].value), "%s0", cookie); assert(!session_valid(&r.req));
    strcpy(r.input[2].value, cookie);
    now = SESSION_AGE_US; assert(!session_valid(&r.req));
    now = SESSION_AGE_US - 1; assert(session_valid(&r.req));
    device_web_reset_sessions("0123456789abcdefghijklmn"); assert(!session_valid(&r.req));
}
static void invalid_requests(void)
{
    device_web_reset_sessions("0123456789abcdefghijklmn");
    const char *bodies[] = {"", "not json", "[]", "{\"token\":42}", "{\"token\":\"0123456789abcdefghijklmn\"}garbage", "{\"token\":\"0123456789abcdefghijklmn\\u0000trailing\"}"};
    for (size_t i = 0; i < sizeof(bodies)/sizeof(bodies[0]); i++) {
        request_t r = pairing(bodies[i], true, "https://192.0.2.10"); link_request(&r);
        assert(pair(&r.req) == ESP_OK && (r.status == 400 || r.status == 401));
        assert(!output(&r, "Set-Cookie"));
    }
    device_web_reset_sessions("0123456789abcdefghijklmn");
    for (unsigned attempt = 0; attempt < 6; attempt++) {
        request_t wrong = pairing("{\"token\":\"wrong\"}", true, "https://192.0.2.10"); link_request(&wrong);
        assert(pair(&wrong.req) == ESP_OK && wrong.status == 401);
    }
    request_t r = pairing("{\"token\":\"wrong\"}", true, "https://192.0.2.10"); link_request(&r);
    assert(pair(&r.req) == ESP_OK && r.status == 429 && output(&r, "Retry-After"));
    now += 60000001;
    r = pairing("{\"token\":\"0123456789abcdefghijklmn\"}", true, "https://192.0.2.10"); link_request(&r);
    assert(pair(&r.req) == ESP_OK && r.status == 204);
}
static void content(void)
{
    request_t r = request(false); link_request(&r);
    assert(certificate(&r.req) == ESP_OK && r.status == 200 && !strcmp(r.body, "PUBLIC-CA-PEM"));
    assert(output(&r, "Content-Disposition") && !strcmp(output(&r, "Cache-Control"), "no-store"));
    certificate_ready = false; r = request(false); link_request(&r);
    assert(certificate(&r.req) == ESP_OK && r.status == 503); certificate_ready = true;
    r = request(false); link_request(&r); input(&r, "Host", "192.0.2.10:80");
    assert(bootstrap(&r.req) == ESP_OK && strstr(r.body, "https://192.0.2.10/"));
    assert(!strstr(r.body, access_token) && strstr(r.body, "abcdef0123456789"));
    r = request(false); link_request(&r); input(&r, "Host", "evil\"><script>");
    assert(bootstrap(&r.req) == ESP_OK && r.status == 400);
    r = request(true); link_request(&r); r.req.uri = "/missing.js";
    assert(asset(&r.req) == ESP_OK && r.status == 404);
    r = request(true); link_request(&r); r.req.uri = fixture_asset.path;
    assert(asset(&r.req) == ESP_OK && r.status == 406);
    r = request(true); link_request(&r); r.req.uri = fixture_asset.path; input(&r, "Accept-Encoding", "br, gzip"); input(&r, "Host", "192.0.2.10");
    assert(asset(&r.req) == ESP_OK && r.status == 200 && r.body_size == sizeof(asset_bytes));
    assert(r.chunk_count == 4 && r.chunks[0] == 4096 && r.chunks[1] == 4096 && r.chunks[2] == 809 && r.chunks[3] == 0);
    assert(!memcmp(r.body, asset_bytes, sizeof(asset_bytes)));
    assert(!strcmp(output(&r, "Content-Encoding"), "gzip"));
    assert(!strcmp(output(&r, "Vary"), "Accept-Encoding"));
    assert(strstr(output(&r, "Cache-Control"), "immutable"));
    assert(strstr(output(&r, "Content-Security-Policy"), "'wasm-unsafe-eval'"));
    assert(strstr(output(&r, "Content-Security-Policy"), "wss://192.0.2.10"));
    assert(strstr(output(&r, "Content-Security-Policy"), "frame-ancestors 'none'"));
    assert(!strcmp(output(&r, "X-Content-Type-Options"), "nosniff"));
    assert(!strcmp(r.type, "text/javascript") && !strcmp(output(&r, "ETag"), "\"fixture\""));
    const struct { const char *header; int status; } encodings[] = {
        {"notgzip", 406}, {"gzip;q=0", 406}, {"gzip;q=0, *;q=1", 406},
        {"GZIP; q=0.5", 200}, {"br, *;q=1", 200}, {"gzip;q=2", 406},
        {"*;q=0, gzip", 200}, {"notgzip, gzip; q=0.25", 200},
    };
    for (size_t i = 0; i < sizeof(encodings)/sizeof(encodings[0]); i++) {
        r = request(true); link_request(&r); r.req.uri = fixture_asset.path;
        input(&r, "Accept-Encoding", encodings[i].header);
        assert(asset(&r.req) == ESP_OK && r.status == encodings[i].status);
    }
    r = request(true); link_request(&r); r.req.sess_ctx = NULL;
    input(&r, "Host", "192.0.2.10");
    headers(&r.req);
    assert(r.req.sess_ctx && r.req.free_ctx);
    for (size_t i = 0; i < r.output_count; i++)
        if (!strcmp(r.output[i].name, "Content-Security-Policy")) {
            assert(r.output[i].source == r.req.sess_ctx);
            assert(!strcmp(r.output[i].source, r.output[i].value));
        }
    r.req.free_ctx(r.req.sess_ctx); r.req.sess_ctx = NULL;
    r = request(true); link_request(&r); r.req.uri = "/flash?from=device";
    assert(asset(&r.req) == ESP_OK && r.status == 302 && output(&r, "Location"));
    r = request(false); link_request(&r);
    assert(info(&r.req) == ESP_OK && strstr(r.body, "\"authenticated\":false"));
    assert(!strstr(r.body, access_token) && !strcmp(r.type, "application/json"));
    route_count = 0; assert(device_web_register((void *)1, true) == ESP_OK && route_count == 4);
    assert(routes[0].handler == info && routes[0].user_ctx);
    assert(routes[2].handler == pair && routes[2].method == HTTP_POST && routes[2].user_ctx);
    assert(routes[3].handler == asset);
    route_count = 0; assert(device_web_register((void *)1, false) == ESP_OK && route_count == 4);
    assert(routes[3].handler == bootstrap && !routes[2].user_ctx);
}
int main(void)
{
    for (size_t i = 0; i < sizeof(asset_bytes); i++) asset_bytes[i] = (unsigned char)(i % 251);
    authentication(); invalid_requests(); content();
    puts("device web pairing, cookie/origin auth, certificates and asset headers passed");
}
