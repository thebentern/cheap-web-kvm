#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Native certificate tests against the same mbedTLS source as the firmware.
# Requires an ESP-IDF checkout, CMake, a C compiler and OpenSSL; no board needed.
set -eu
cd "$(dirname "$0")/.."
: "${IDF_PATH:?Set IDF_PATH to the ESP-IDF checkout}"
TLS_TEST_DIR=$(mktemp -d /tmp/cheap-kvm-tls-test.XXXXXX)
trap 'rm -rf "$TLS_TEST_DIR"' EXIT
TLS_MBEDTLS_SOURCE="$IDF_PATH/components/mbedtls/mbedtls"
cmake -S "$TLS_MBEDTLS_SOURCE" -B "$TLS_TEST_DIR/mbedtls" \
    -DENABLE_TESTING=OFF -DENABLE_PROGRAMS=OFF -DMBEDTLS_FATAL_WARNINGS=OFF \
    > "$TLS_TEST_DIR/configure.log" 2>&1 || { cat "$TLS_TEST_DIR/configure.log"; exit 1; }
cmake --build "$TLS_TEST_DIR/mbedtls" --parallel 4 \
    > "$TLS_TEST_DIR/build.log" 2>&1 || { cat "$TLS_TEST_DIR/build.log"; exit 1; }
${CC:-cc} -std=c11 -Wall -Wextra -Werror \
    -Ifirmware/test/tls_stubs -Ifirmware/main -I"$TLS_MBEDTLS_SOURCE/include" \
    firmware/test/device_tls_test.c -L"$TLS_TEST_DIR/mbedtls/library" \
    -lmbedx509 -lmbedcrypto -o "$TLS_TEST_DIR/test"
"$TLS_TEST_DIR/test" "$TLS_TEST_DIR"
openssl verify -CAfile "$TLS_TEST_DIR/device-ca.pem" \
    -verify_hostname cheap-web-kvm-7da0.local "$TLS_TEST_DIR/server.pem"
openssl verify -CAfile "$TLS_TEST_DIR/device-ca.pem" \
    -verify_ip 192.168.2.219 "$TLS_TEST_DIR/server.pem"
openssl verify -CAfile "$TLS_TEST_DIR/device-ca.pem" \
    -verify_ip 192.168.4.1 "$TLS_TEST_DIR/server.pem"
if openssl verify -CAfile "$TLS_TEST_DIR/device-ca.pem" \
    -verify_ip 192.168.2.218 "$TLS_TEST_DIR/server.pem" > /dev/null 2>&1; then
    echo "A stale DHCP address incorrectly passed certificate verification" >&2
    exit 1
fi
openssl x509 -in "$TLS_TEST_DIR/device-ca.pem" -outform DER | \
    openssl dgst -sha256 -binary | od -An -v -tx1 | tr -d ' \n' > "$TLS_TEST_DIR/openssl-sha256.txt"
cmp "$TLS_TEST_DIR/fingerprint.txt" "$TLS_TEST_DIR/openssl-sha256.txt"
echo "OpenSSL independently verified the DNS/IP SANs, CA chain and fingerprint"
