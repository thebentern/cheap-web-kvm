/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "sdkconfig.h"
#if CONFIG_KVM_DEVICE_WEB
#include "device_web.h"
#include "device_tls.h"
#include "kvm_web_assets.h"
#include "cJSON.h"
#include "esp_random.h"
#include "esp_timer.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#define SESSION_COUNT 4
#define SESSION_AGE_US (8LL * 60 * 60 * 1000000)
static char access_token[81];
static struct { char id[65]; int64_t expires; } sessions[SESSION_COUNT];
static unsigned next_session, failed_attempts;
static int64_t attempt_window;
static const char *CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' %s; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
static bool valid_host(const char *host)
{
    if (!host[0]) return false;
    for (const char *p = host; *p; p++)
        if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
              (*p >= '0' && *p <= '9') || *p == '.' || *p == '-' || *p == ':' || *p == '[' || *p == ']')) return false;
    return true;
}

static bool equal(const char *a, const char *b)
{
    size_t n = strlen(a), m = strlen(b);
    unsigned diff = n ^ m;
    for (size_t i = 0; i < n; i++) diff |= (unsigned char)a[i] ^ (i < m ? (unsigned char)b[i] : 0);
    return diff == 0;
}
static bool origin_valid(httpd_req_t *req)
{
    char host[128], origin[144], expected[144];
    if (httpd_req_get_hdr_value_str(req, "Host", host, sizeof(host)) != ESP_OK ||
        httpd_req_get_hdr_value_str(req, "Origin", origin, sizeof(origin)) != ESP_OK)
        return false;
    snprintf(expected, sizeof(expected), "https://%s", host);
    return !strcmp(expected, origin);
}
static bool session_valid(httpd_req_t *req)
{
    char cookie[512];
    if (httpd_req_get_hdr_value_str(req, "Cookie", cookie, sizeof(cookie)) != ESP_OK) return false;
    const char *at = cookie;
    while (*at) {
        while (*at == ' ' || *at == ';') at++;
        const char *end = strchr(at, ';');
        size_t n = end ? (size_t)(end - at) : strlen(at);
        if (n == 12 + 64 && !strncmp(at, "kvm_session=", 12)) {
            char id[65]; memcpy(id, at + 12, 64); id[64] = 0;
            for (unsigned i = 0; i < SESSION_COUNT; i++)
                if (sessions[i].expires > esp_timer_get_time() && equal(id, sessions[i].id)) return true;
        }
        if (!end) break;
        at = end + 1;
    }
    return false;
}
void device_web_reset_sessions(const char *token)
{
    strlcpy(access_token, token, sizeof(access_token));
    memset(sessions, 0, sizeof(sessions));
    next_session = failed_attempts = 0;
    attempt_window = esp_timer_get_time();
}
bool device_web_authorized(httpd_req_t *req, bool secure)
{
    char token[96];
    if (httpd_req_get_hdr_value_str(req, "X-KVM-Token", token, sizeof(token)) == ESP_OK &&
        access_token[0] && equal(token, access_token)) return true;
    return secure && origin_valid(req) && session_valid(req);
}
static void headers(httpd_req_t *req)
{
    char host[128], websocket[144] = {0};
    if (httpd_req_get_hdr_value_str(req, "Host", host, sizeof(host)) == ESP_OK && valid_host(host))
        snprintf(websocket, sizeof(websocket), "wss://%s", host);
    // HTTPD retains header pointers until send; keep this request's policy alive.
    if (!req->sess_ctx) { req->sess_ctx = calloc(1, 640); req->free_ctx = free; }
    char *policy = req->sess_ctx;
    if (policy) snprintf(policy, 640, CSP, websocket);
    httpd_resp_set_hdr(req, "X-Content-Type-Options", "nosniff");
    httpd_resp_set_hdr(req, "Referrer-Policy", "no-referrer");
    httpd_resp_set_hdr(req, "Content-Security-Policy", policy ? policy : "default-src 'self'; object-src 'none'; frame-ancestors 'none'");
    // Free scarce TLS sessions after ordinary resources; /media stays open.
    httpd_resp_set_hdr(req, "Connection", "close");
}
static esp_err_t info(httpd_req_t *req)
{
    char body[256];
    bool secure = req->user_ctx != NULL;
    snprintf(body, sizeof(body), "{\"device\":true,\"authenticated\":%s,\"httpsPort\":443,\"hostname\":\"%s\",\"certificateFingerprint\":\"%s\"}",
             secure && session_valid(req) ? "true" : "false", device_tls_hostname() ? device_tls_hostname() : "", device_tls_fingerprint() ? device_tls_fingerprint() : "");
    headers(req);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_sendstr(req, body);
}
static esp_err_t certificate(httpd_req_t *req)
{
    const char *pem = device_tls_trust_certificate();
    if (!pem || !pem[0]) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_sendstr(req, "Certificate is preparing. Retry in a few seconds.");
    }
    headers(req);
    httpd_resp_set_type(req, "application/x-x509-ca-cert");
    httpd_resp_set_hdr(req, "Content-Disposition", "attachment; filename=cheap-web-kvm-ca.crt");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_sendstr(req, pem);
}
static esp_err_t pair(httpd_req_t *req)
{
    headers(req);
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    if (!req->user_ctx || !origin_valid(req))
        return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Open the board's HTTPS page to pair.");
    int64_t now = esp_timer_get_time();
    if (now - attempt_window > 60000000) { failed_attempts = 0; attempt_window = now; }
    if (failed_attempts >= 6) {
        httpd_resp_set_status(req, "429 Too Many Requests");
        httpd_resp_set_hdr(req, "Retry-After", "60");
        return httpd_resp_sendstr(req, "Wait a minute before trying again.");
    }
    if (req->content_len <= 0 || req->content_len > 256)
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid pairing request.");
    char body[257]; size_t n = 0;
    while (n < req->content_len) {
        int got = httpd_req_recv(req, body + n, req->content_len - n);
        if (got <= 0) return ESP_FAIL;
        n += got;
    }
    body[n] = 0;
    bool nul = memchr(body, 0, n) != NULL;
    for (size_t at = 0; at + 5 < n; at++) {
        if (body[at] != '\\') continue;
        if (body[at + 1] == '\\') { at++; continue; }
        if (!memcmp(body + at, "\\u0000", 6)) nul = true;
    }
    const char *end = NULL;
    cJSON *json = nul ? NULL : cJSON_ParseWithLengthOpts(body, n + 1, &end, true);
    if (end != body + n) { cJSON_Delete(json); json = NULL; }
    cJSON *token = json ? cJSON_GetObjectItemCaseSensitive(json, "token") : NULL;
    bool valid = cJSON_IsString(token) && strlen(token->valuestring) >= 16 &&
                 strlen(token->valuestring) <= 80 && equal(token->valuestring, access_token);
    cJSON_Delete(json);
    if (!valid) { failed_attempts++; return httpd_resp_send_err(req, HTTPD_401_UNAUTHORIZED, "Access token did not match."); }
    failed_attempts = 0;
    unsigned slot = next_session++ % SESSION_COUNT;
    static const char hex[] = "0123456789abcdef";
    uint8_t random[32]; esp_fill_random(random, sizeof(random));
    for (unsigned i = 0; i < sizeof(random); i++) {
        sessions[slot].id[2*i] = hex[random[i] >> 4];
        sessions[slot].id[2*i+1] = hex[random[i] & 15];
    }
    sessions[slot].id[64] = 0;
    sessions[slot].expires = now + SESSION_AGE_US;
    char cookie[180];
    snprintf(cookie, sizeof(cookie), "kvm_session=%s; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800", sessions[slot].id);
    httpd_resp_set_hdr(req, "Set-Cookie", cookie);
    httpd_resp_set_status(req, "204 No Content");
    return httpd_resp_send(req, NULL, 0);
}
static esp_err_t bootstrap(httpd_req_t *req)
{
    char host[128] = {0};
    if (httpd_req_get_hdr_value_str(req, "Host", host, sizeof(host)) != ESP_OK)
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing Host");
    /* Only use a syntactically bounded hostname/IP in generated HTML. */
    if (!valid_host(host)) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid Host");
    char *port = strrchr(host, ':'); if (port && !strchr(host, ']')) *port = 0;
    char body[2200];
    snprintf(body, sizeof(body),
        "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>$KVM setup</title>"
        "<style>body{background:#211c18;color:#f3eee7;font:17px system-ui;max-width:44rem;margin:8vh auto;padding:1.5rem}a{color:#e99557}code{overflow-wrap:anywhere}li{margin:1rem 0}</style>"
        "<h1>$KVM on this board</h1><p>The console is hosted on the ESP32. Its browser storage and device features use HTTPS.</p>"
        "<ol><li><a href='/device/ca.crt'>Download this board's trust certificate</a>. Verify the SHA-256 fingerprint against the value read over USB or paired Bluetooth before trusting it.</li>"
        "<li>Install the certificate as a trusted certificate authority on this computer or tablet. On macOS use Keychain Access, open the certificate, and set SSL trust to Always Trust. On Windows import into Trusted Root Certification Authorities. On iOS install the profile, then enable trust in Certificate Trust Settings.</li>"
        "<li><a href='https://%s/'>Open the HTTPS console</a>, choose Wi-Fi and enter the board's access token. Find it in Settings → Wi-Fi → Advanced through USB or Bluetooth.</li></ol>"
        "<p>Certificate authority SHA-256:<br><code>%s</code></p><p>Keep this certificate's trust limited to devices you control. The board keeps its identity across restarts.</p></html>", host, device_tls_fingerprint() ? device_tls_fingerprint() : "Preparing certificate; reload in a few seconds.");
    headers(req);
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_sendstr(req, body);
}
static esp_err_t asset(httpd_req_t *req)
{
    if (!strncmp(req->uri, "/flash", 6) && (req->uri[6] == 0 || req->uri[6] == '/' || req->uri[6] == '?')) {
        httpd_resp_set_status(req, "302 Found");
        httpd_resp_set_hdr(req, "Location", "https://thebentern.github.io/cheap-web-kvm/flash");
        return httpd_resp_send(req, NULL, 0);
    }
    const kvm_web_asset_t *a = kvm_web_asset_find(req->uri);
    if (!a) return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "Asset is not included on this board.");
    if (a->encoding) {
        char accept[256];
        bool supported = false, explicit = false, wildcard = false;
        if (httpd_req_get_hdr_value_str(req, "Accept-Encoding", accept, sizeof(accept)) == ESP_OK) {
            char *save, *item = strtok_r(accept, ",", &save);
            while (item) {
                while (*item == ' ' || *item == '\t') item++;
                char *param = strchr(item, ';');
                if (param) *param++ = 0;
                char *tail = item + strlen(item);
                while (tail > item && (tail[-1] == ' ' || tail[-1] == '\t')) *--tail = 0;
                double quality = 1;
                if (param) {
                    while (*param == ' ' || *param == '\t') param++;
                    if (!strncasecmp(param, "q=", 2)) {
                        char *end; quality = strtod(param + 2, &end);
                        while (*end == ' ' || *end == '\t') end++;
                        if (end == param + 2 || *end || quality < 0 || quality > 1) quality = 0;
                    }
                }
                if (!strcasecmp(item, "gzip")) { explicit = true; supported = quality > 0; }
                if (!strcmp(item, "*")) wildcard = quality > 0;
                item = strtok_r(NULL, ",", &save);
            }
        }
        if (!(explicit ? supported : wildcard)) {
            httpd_resp_set_status(req, "406 Not Acceptable");
            return httpd_resp_sendstr(req, "This console requires gzip support.");
        }
        httpd_resp_set_hdr(req, "Content-Encoding", a->encoding);
        httpd_resp_set_hdr(req, "Vary", "Accept-Encoding");
    }
    headers(req);
    httpd_resp_set_type(req, a->content_type);
    httpd_resp_set_hdr(req, "ETag", a->etag);
    httpd_resp_set_hdr(req, "Cache-Control", !strncmp(a->path, "/_nuxt/", 7) ? "public, max-age=31536000, immutable" : "no-cache");
    // A flash-backed asset is sent in bounded pieces, never copied wholesale.
    for (size_t at = 0; at < a->size; at += 4096) {
        size_t n = a->size - at; if (n > 4096) n = 4096;
        esp_err_t err = httpd_resp_send_chunk(req, (const char *)a->data + at, n);
        if (err != ESP_OK) return err;
    }
    return httpd_resp_send_chunk(req, NULL, 0);
}
esp_err_t device_web_register(httpd_handle_t server, bool secure)
{
    const httpd_uri_t routes[] = {
        {.uri="/device/info", .method=HTTP_GET, .handler=info, .user_ctx=secure ? (void *)1 : NULL},
        {.uri="/device/ca.crt", .method=HTTP_GET, .handler=certificate},
        {.uri="/device/session", .method=HTTP_POST, .handler=pair, .user_ctx=secure ? (void *)1 : NULL},
        {.uri="/*", .method=HTTP_GET, .handler=secure ? asset : bootstrap},
    };
    for (unsigned i = 0; i < sizeof(routes)/sizeof(routes[0]); i++) {
        esp_err_t err = httpd_register_uri_handler(server, &routes[i]);
        if (err != ESP_OK) return err;
    }
    return ESP_OK;
}
#endif
