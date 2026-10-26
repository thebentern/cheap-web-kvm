/* SPDX-License-Identifier: GPL-3.0-or-later */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
/* Include the implementation to model a power cycle without a test-only API
 * in production firmware. NVS and the hardware entropy/MAC APIs are stubbed. */
#include "../main/device_tls.c"

static unsigned char stored[sizeof(identity_t)], staged[sizeof(identity_t)];
static size_t stored_size, staged_size;
static unsigned commits;
static bool fail_commit;
static uint8_t test_mac[6] = {0x58, 0xe6, 0xc5, 0x45, 0x7d, 0xa0};
void esp_fill_random(void *bytes, size_t length)
{
    static FILE *random_source;
    if (!random_source) random_source = fopen("/dev/urandom", "rb");
    assert(random_source && fread(bytes, 1, length, random_source) == length);
}
esp_err_t esp_read_mac(uint8_t *mac, int kind)
{
    assert(kind == ESP_MAC_WIFI_STA);
    memcpy(mac, test_mac, 6);
    return ESP_OK;
}
esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *handle)
{
    assert(!strcmp(name, "device_tls") && mode == NVS_READWRITE);
    *handle = 1;
    staged_size = 0;
    return ESP_OK;
}
esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *value, size_t *length)
{
    assert(handle == 1 && !strcmp(key, "identity"));
    if (!stored_size) return ESP_ERR_NVS_NOT_FOUND;
    if (*length < stored_size) return ESP_ERR_NVS_INVALID_LENGTH;
    memcpy(value, stored, stored_size);
    *length = stored_size;
    return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t handle, const char *key, const void *value, size_t length)
{
    assert(handle == 1 && !strcmp(key, "identity") && length == sizeof(identity_t));
    memcpy(staged, value, length);
    staged_size = length;
    return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t handle)
{
    assert(handle == 1 && staged_size == sizeof(identity_t));
    if (fail_commit) return ESP_FAIL;
    memcpy(stored, staged, staged_size);
    stored_size = staged_size;
    commits++;
    return ESP_OK;
}
void nvs_close(nvs_handle_t handle)
{
    assert(handle == 1);
    memset(staged, 0, sizeof(staged));
    staged_size = 0;
}
static void reboot(void)
{
    ready = false;
    memset(&identity, 0, sizeof(identity));
    memset(hostname, 0, sizeof(hostname));
    memset(fingerprint, 0, sizeof(fingerprint));
}
static void public_file(const char *directory, const char *name, const char *value)
{
    char path[1024];
    assert(snprintf(path, sizeof(path), "%s/%s", directory, name) < (int)sizeof(path));
    FILE *file = fopen(path, "w");
    assert(file && fputs(value, file) >= 0 && fclose(file) == 0);
}
int main(int argc, char **argv)
{
    assert(argc == 2);
    const uint8_t ap[] = {192, 168, 4, 1}, client[] = {192, 168, 2, 218};
    const uint8_t changed_client[] = {192, 168, 2, 219};
    assert(!device_tls_certificate() && !device_tls_private_key());
    assert(device_tls_prepare(client, ap) == ESP_OK);
    assert(!strcmp(device_tls_hostname(), "cheap-web-kvm-7da0.local"));
    assert(commits == 1 && stored_size == sizeof(identity_t));
    assert(strlen(device_tls_fingerprint()) == 64);
    assert(strstr(device_tls_certificate(), "BEGIN CERTIFICATE"));
    assert(strstr(device_tls_trust_certificate(), "BEGIN CERTIFICATE"));
    assert(strcmp(device_tls_trust_certificate(), device_tls_certificate()));
    identity_t initial = identity;
    char original_fingerprint[65];
    memcpy(original_fingerprint, device_tls_fingerprint(), sizeof(original_fingerprint));
    reboot();
    assert(device_tls_prepare(client, ap) == ESP_OK);
    assert(commits == 1 && !strcmp(device_tls_fingerprint(), original_fingerprint));
    assert(!strcmp(device_tls_certificate(), initial.server_cert));

    fail_commit = true;
    assert(device_tls_prepare(changed_client, ap) == ESP_FAIL);
    assert(!strcmp(device_tls_certificate(), initial.server_cert));
    assert(!memcmp(stored, &initial, sizeof(initial)));
    fail_commit = false;
    assert(device_tls_prepare(changed_client, ap) == ESP_OK);
    assert(commits == 2);
    assert(!strcmp(device_tls_fingerprint(), original_fingerprint));
    assert(!strcmp(device_tls_private_key(), initial.server_key));
    assert(!strcmp(device_tls_trust_certificate(), initial.ca_cert));
    assert(strcmp(device_tls_certificate(), initial.server_cert));
    public_file(argv[1], "device-ca.pem", device_tls_trust_certificate());
    public_file(argv[1], "server.pem", device_tls_certificate());
    public_file(argv[1], "fingerprint.txt", device_tls_fingerprint());

    identity_t valid = identity;
    reboot();
    ((identity_t *)stored)->version = 0;
    assert(device_tls_prepare(changed_client, ap) == ESP_ERR_INVALID_STATE);
    assert(commits == 2 && !device_tls_certificate() && !device_tls_trust_certificate());
    assert(((identity_t *)stored)->version == 0);
    memcpy(stored, &valid, sizeof(valid));
    ((identity_t *)stored)->server_key[50] ^= 1;
    assert(device_tls_prepare(changed_client, ap) == ESP_ERR_INVALID_STATE);
    assert(commits == 2 && !device_tls_certificate());

    stored_size = 0;
    fail_commit = true;
    reboot();
    assert(device_tls_prepare(client, ap) == ESP_FAIL);
    assert(!device_tls_certificate() && !device_tls_trust_certificate() && !stored_size);
    fail_commit = false;
    assert(device_tls_prepare(client, ap) == ESP_OK);
    assert(strcmp(device_tls_fingerprint(), original_fingerprint));
    assert(commits == 3);
    puts("device TLS identity, persistence, DHCP renewal and failure tests passed");
}
