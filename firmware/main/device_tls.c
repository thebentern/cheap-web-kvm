/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "device_tls.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "nvs.h"
#include "mbedtls/ecp.h"
#include "mbedtls/oid.h"
#include "mbedtls/pk.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/sha256.h"
#include "mbedtls/x509_crt.h"
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>
#include <time.h>

#ifndef KVM_BUILD_TIME
#error "Define KVM_BUILD_TIME as the firmware build's Unix UTC timestamp"
#endif
#define DAY_SECONDS 86400LL
#define MIN_CLOCK_TIME 1704067200LL /* 2024-01-01 */
#define LEAF_LIFETIME (800LL * DAY_SECONDS)
#define MAX_LEAF_LIFETIME (825LL * DAY_SECONDS)
#define RENEW_BEFORE (30LL * DAY_SECONDS)

#define KEY_CAPACITY 384
#define CERT_CAPACITY 1536
#define HOST_CAPACITY 40
#define IDENTITY_VERSION 1
static const char *TAG = "device_tls";

typedef struct {
    uint32_t version;
    char hostname[HOST_CAPACITY];
    uint8_t client_ip[4], ap_ip[4];
    char ca_key[KEY_CAPACITY], server_key[KEY_CAPACITY];
    char ca_cert[CERT_CAPACITY], server_cert[CERT_CAPACITY];
} identity_t;
static identity_t identity;
static atomic_bool ready;
static char hostname[HOST_CAPACITY], fingerprint[65];
/* Only the serialized Wi-Fi certificate worker accesses these timestamps. */
static int64_t issued_not_before, issued_not_after;

static bool leap(int year) { return !(year % 4) && (year % 100 || !(year % 400)); }
static int64_t utc_seconds(const mbedtls_x509_time *value)
{
    static const unsigned char days_in_month[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    if (value->year < 1970 || value->year > 9999 || value->mon < 1 || value->mon > 12 ||
        value->day < 1 || value->day > 31) return 0;
    int64_t days = 0;
    for (int year = 1970; year < value->year; year++) days += leap(year) ? 366 : 365;
    for (int month = 1; month < value->mon; month++)
        days += days_in_month[month - 1] + (month == 2 && leap(value->year));
    return (days + value->day - 1) * DAY_SECONDS + value->hour * 3600 + value->min * 60 + value->sec;
}
static int64_t current_time(int64_t persisted_not_before)
{
    int64_t actual = (int64_t)time(NULL);
    int64_t now = KVM_BUILD_TIME > MIN_CLOCK_TIME ? KVM_BUILD_TIME : MIN_CLOCK_TIME;
    if (actual >= MIN_CLOCK_TIME) {
        if (actual > now) now = actual;
    } else if (persisted_not_before + DAY_SECONDS > now) {
        // A board without an RTC must not replace a valid persisted leaf on
        // each offline reboot merely because its clock returned to 1970.
        now = persisted_not_before + DAY_SECONDS;
    }
    return now;
}
static bool renewal_due(int64_t before, int64_t after)
{
    int64_t now = current_time(before);
    return before <= 0 || after <= before || after - before > MAX_LEAF_LIFETIME ||
           after - now < RENEW_BEFORE || before > now + DAY_SECONDS;
}
bool device_tls_needs_renewal(void)
{
    return !ready || renewal_due(issued_not_before, issued_not_after);
}
static int validity_string(int64_t seconds, char output[16])
{
    time_t epoch = (time_t)seconds;
    struct tm utc;
    if (!gmtime_r(&epoch, &utc) || strftime(output, 16, "%Y%m%d%H%M%S", &utc) != 14)
        return MBEDTLS_ERR_X509_BAD_INPUT_DATA;
    return 0;
}

static int random_bytes(void *context, unsigned char *bytes, size_t length)
{
    (void)context;
    esp_fill_random(bytes, length);
    return 0;
}
static bool present(const uint8_t ip[4])
{
    return ip && (ip[0] || ip[1] || ip[2] || ip[3]);
}
const char *device_tls_hostname(void)
{
    if (!hostname[0]) {
        uint8_t mac[6];
        if (esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK)
            snprintf(hostname, sizeof(hostname), "cheap-web-kvm-%02x%02x.local", mac[4], mac[5]);
    }
    return hostname;
}
const char *device_tls_certificate(void) { return ready ? identity.server_cert : NULL; }
const char *device_tls_private_key(void) { return ready ? identity.server_key : NULL; }
const char *device_tls_trust_certificate(void) { return ready ? identity.ca_cert : NULL; }
const char *device_tls_fingerprint(void) { return ready ? fingerprint : NULL; }

static int generate_key(mbedtls_pk_context *key, char output[KEY_CAPACITY])
{
    int error = mbedtls_pk_setup(key, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY));
    if (!error)
        error = mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1, mbedtls_pk_ec(*key), random_bytes, NULL);
    if (!error)
        error = mbedtls_pk_write_key_pem(key, (unsigned char *)output, KEY_CAPACITY);
    return error;
}
static int parse_key(mbedtls_pk_context *key, const char value[KEY_CAPACITY])
{
    if (!memchr(value, 0, KEY_CAPACITY)) return MBEDTLS_ERR_PK_BAD_INPUT_DATA;
    return mbedtls_pk_parse_key(key, (const unsigned char *)value, strlen(value) + 1,
                                NULL, 0, random_bytes, NULL);
}
static int certificate(char output[CERT_CAPACITY], const char *subject,
                       const char *issuer, mbedtls_pk_context *subject_key,
                       mbedtls_pk_context *issuer_key, bool ca,
                       const char *dns, const uint8_t client[4], const uint8_t ap[4],
                       int64_t not_before, int64_t not_after)
{
    mbedtls_x509write_cert cert;
    mbedtls_x509write_crt_init(&cert);
    unsigned char serial[16];
    random_bytes(NULL, serial, sizeof(serial));
    serial[0] = (serial[0] & 0x7f) | 1;
    mbedtls_x509write_crt_set_version(&cert, MBEDTLS_X509_CRT_VERSION_3);
    mbedtls_x509write_crt_set_md_alg(&cert, MBEDTLS_MD_SHA256);
    mbedtls_x509write_crt_set_subject_key(&cert, subject_key);
    mbedtls_x509write_crt_set_issuer_key(&cert, issuer_key);
    int error = mbedtls_x509write_crt_set_serial_raw(&cert, serial, sizeof(serial));
    if (!error) error = mbedtls_x509write_crt_set_subject_name(&cert, subject);
    if (!error) error = mbedtls_x509write_crt_set_issuer_name(&cert, issuer);
    char before[16], after[16];
    if (!ca && !error) error = validity_string(not_before, before);
    if (!ca && !error) error = validity_string(not_after, after);
    /* The persistent private CA can be long lived. Server leaves stay below
     * Apple's 825-day limit even when that private CA is manually trusted. */
    if (!error) error = mbedtls_x509write_crt_set_validity(&cert,
        ca ? "20200101000000" : before, ca ? "20491231235959" : after);
    if (!error) error = mbedtls_x509write_crt_set_basic_constraints(&cert, ca, ca ? 0 : -1);
    if (!error) error = mbedtls_x509write_crt_set_key_usage(&cert, ca
        ? MBEDTLS_X509_KU_KEY_CERT_SIGN | MBEDTLS_X509_KU_CRL_SIGN
        : MBEDTLS_X509_KU_DIGITAL_SIGNATURE);
    if (!ca && !error) {
        mbedtls_asn1_sequence usage = {0};
        usage.buf.tag = MBEDTLS_ASN1_OID;
        usage.buf.p = (unsigned char *)MBEDTLS_OID_SERVER_AUTH;
        usage.buf.len = MBEDTLS_OID_SIZE(MBEDTLS_OID_SERVER_AUTH);
        error = mbedtls_x509write_crt_set_ext_key_usage(&cert, &usage);
    }
    mbedtls_x509_san_list names[3] = {0};
    if (!ca && !error) {
        names[0].node.type = MBEDTLS_X509_SAN_DNS_NAME;
        names[0].node.san.unstructured_name.p = (unsigned char *)dns;
        names[0].node.san.unstructured_name.len = strlen(dns);
        size_t count = 1;
        const uint8_t *addresses[] = {client, ap};
        for (size_t i = 0; i < 2; i++) {
            if (!present(addresses[i]) || (i && present(client) && !memcmp(client, ap, 4))) continue;
            names[count - 1].next = &names[count];
            names[count].node.type = MBEDTLS_X509_SAN_IP_ADDRESS;
            names[count].node.san.unstructured_name.p = (unsigned char *)addresses[i];
            names[count].node.san.unstructured_name.len = 4;
            count++;
        }
        error = mbedtls_x509write_crt_set_subject_alternative_name(&cert, names);
    }
    if (!error)
        error = mbedtls_x509write_crt_pem(&cert, (unsigned char *)output, CERT_CAPACITY,
                                         random_bytes, NULL);
    mbedtls_x509write_crt_free(&cert);
    mbedtls_platform_zeroize(serial, sizeof(serial));
    return error;
}
static int validate(identity_t *candidate, mbedtls_pk_context *ca_key,
                    mbedtls_pk_context *server_key, mbedtls_x509_crt *ca,
                    int64_t *not_before, int64_t *not_after)
{
    if (candidate->version != IDENTITY_VERSION ||
        memcmp(candidate->hostname, device_tls_hostname(), strlen(device_tls_hostname()) + 1) ||
        !memchr(candidate->ca_cert, 0, CERT_CAPACITY) ||
        !memchr(candidate->server_cert, 0, CERT_CAPACITY)) return MBEDTLS_ERR_X509_BAD_INPUT_DATA;
    int error = parse_key(ca_key, candidate->ca_key);
    if (!error) error = parse_key(server_key, candidate->server_key);
    if (!error) error = mbedtls_x509_crt_parse(ca, (const unsigned char *)candidate->ca_cert,
                                              strlen(candidate->ca_cert) + 1);
    if (!error && !ca->MBEDTLS_PRIVATE(ca_istrue)) error = MBEDTLS_ERR_X509_INVALID_EXTENSIONS;
    if (!error) error = mbedtls_pk_check_pair(&ca->pk, ca_key, random_bytes, NULL);
    mbedtls_x509_crt server;
    mbedtls_x509_crt_init(&server);
    if (!error) error = mbedtls_x509_crt_parse(&server,
        (const unsigned char *)candidate->server_cert, strlen(candidate->server_cert) + 1);
    if (!error) error = mbedtls_pk_check_pair(&server.pk, server_key, random_bytes, NULL);
    if (!error) {
        *not_before = utc_seconds(&server.valid_from);
        *not_after = utc_seconds(&server.valid_to);
    }
    if (!error) {
        uint32_t flags = 0;
        error = mbedtls_x509_crt_verify(&server, ca, NULL, candidate->hostname, &flags, NULL, NULL);
        /* The ESP may still have its power-on 1970 clock. Browsers enforce the
         * actual validity period; all other chain/identity failures remain fatal. */
        flags &= ~(MBEDTLS_X509_BADCERT_FUTURE | MBEDTLS_X509_BADCERT_EXPIRED);
        if (!flags && error == MBEDTLS_ERR_X509_CERT_VERIFY_FAILED) error = 0;
    }
    mbedtls_x509_crt_free(&server);
    return error;
}

esp_err_t device_tls_prepare(const uint8_t client_ipv4[4], const uint8_t ap_ipv4[4])
{
    if (!device_tls_hostname()[0]) return ESP_FAIL;
    identity_t *candidate = calloc(1, sizeof(*candidate));
    if (!candidate) return ESP_ERR_NO_MEM;
    nvs_handle_t storage;
    esp_err_t status = nvs_open("device_tls", NVS_READWRITE, &storage);
    if (status != ESP_OK) goto finish;
    size_t size = sizeof(*candidate);
    status = nvs_get_blob(storage, "identity", candidate, &size);
    bool create = status == ESP_ERR_NVS_NOT_FOUND;
    bool changed = create;
    if (status == ESP_OK && size != sizeof(*candidate)) status = ESP_ERR_INVALID_STATE;
    if (!create && status != ESP_OK) goto close;
    mbedtls_pk_context ca_key, server_key;
    mbedtls_x509_crt ca;
    mbedtls_pk_init(&ca_key);
    mbedtls_pk_init(&server_key);
    mbedtls_x509_crt_init(&ca);
    int error = 0;
    int64_t leaf_before = 0, leaf_after = 0;
    char ca_subject[96], server_subject[80];
    snprintf(ca_subject, sizeof(ca_subject), "CN=%s device CA,O=cheap-web-kvm", hostname);
    snprintf(server_subject, sizeof(server_subject), "CN=%s,O=cheap-web-kvm", hostname);
    if (create) {
        candidate->version = IDENTITY_VERSION;
        snprintf(candidate->hostname, sizeof(candidate->hostname), "%s", hostname);
        error = generate_key(&ca_key, candidate->ca_key);
        if (!error) error = generate_key(&server_key, candidate->server_key);
        if (!error) error = certificate(candidate->ca_cert, ca_subject, ca_subject,
                                         &ca_key, &ca_key, true, NULL, NULL, NULL, 0, 0);
    } else {
        error = validate(candidate, &ca_key, &server_key, &ca, &leaf_before, &leaf_after);
        if (!error && ready &&
            (memcmp(identity.ca_key, candidate->ca_key, KEY_CAPACITY) ||
             memcmp(identity.server_key, candidate->server_key, KEY_CAPACITY) ||
             memcmp(identity.ca_cert, candidate->ca_cert, CERT_CAPACITY)))
            error = MBEDTLS_ERR_X509_BAD_INPUT_DATA;
    }
    uint8_t client[4] = {0}, ap[4] = {0};
    if (client_ipv4) memcpy(client, client_ipv4, 4);
    if (ap_ipv4) memcpy(ap, ap_ipv4, 4);
    if (!error && (create || renewal_due(leaf_before, leaf_after) ||
                   memcmp(client, candidate->client_ip, 4) || memcmp(ap, candidate->ap_ip, 4))) {
        memset(candidate->server_cert, 0, sizeof(candidate->server_cert));
        leaf_before = current_time(leaf_before) - DAY_SECONDS;
        leaf_after = leaf_before + LEAF_LIFETIME;
        error = certificate(candidate->server_cert, server_subject, ca_subject,
                              &server_key, &ca_key, false, hostname, client, ap, leaf_before, leaf_after);
        if (!error) {
            memcpy(candidate->client_ip, client, 4);
            memcpy(candidate->ap_ip, ap, 4);
            changed = true;
        }
    }
    if (!error && create)
        error = mbedtls_x509_crt_parse(&ca, (const unsigned char *)candidate->ca_cert,
                                        strlen(candidate->ca_cert) + 1);
    unsigned char digest[32];
    if (!error) error = mbedtls_sha256(ca.raw.p, ca.raw.len, digest, 0);
    if (error) {
        ESP_LOGE(TAG, "TLS identity validation/generation failed: -0x%x", (unsigned int)-error);
        status = ESP_ERR_INVALID_STATE;
    } else {
        status = changed ? nvs_set_blob(storage, "identity", candidate, sizeof(*candidate)) : ESP_OK;
        if (status == ESP_OK && changed) status = nvs_commit(storage);
        if (status == ESP_OK) {
            /* Trust-anchor bytes never change after publication. HTTP bootstrap
             * may safely continue serving them while HTTPS is stopped to renew
             * only its leaf for a new DHCP address. */
            if (!ready) memcpy(&identity, candidate, sizeof(identity));
            else {
                memcpy(identity.client_ip, candidate->client_ip, 4);
                memcpy(identity.ap_ip, candidate->ap_ip, 4);
                memcpy(identity.server_cert, candidate->server_cert, CERT_CAPACITY);
            }
            if (!ready)
                for (size_t i = 0; i < sizeof(digest); i++)
                    snprintf(fingerprint + i * 2, 3, "%02x", digest[i]);
            issued_not_before = leaf_before;
            issued_not_after = leaf_after;
            ready = true;
            ESP_LOGI(TAG, "Device CA SHA-256: %s", fingerprint);
        }
    }
    mbedtls_platform_zeroize(digest, sizeof(digest));
    mbedtls_x509_crt_free(&ca);
    mbedtls_pk_free(&server_key);
    mbedtls_pk_free(&ca_key);
close:
    nvs_close(storage);
finish:
    mbedtls_platform_zeroize(candidate, sizeof(*candidate));
    free(candidate);
    return status;
}
