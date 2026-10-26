#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu
cd "$(dirname "$0")/.."
: "${IDF_PATH:?Set IDF_PATH to the ESP-IDF checkout}"
WEB_TEST_BINARY=$(mktemp /tmp/cheap-kvm-web-test.XXXXXX)
trap 'rm -f "$WEB_TEST_BINARY"' EXIT
${CC:-cc} -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror \
    -Ifirmware/test/web_stubs -Ifirmware/test/tls_stubs -Ifirmware/main \
    -I"$IDF_PATH/components/json/cJSON" firmware/test/device_web_test.c \
    "$IDF_PATH/components/json/cJSON/cJSON.c" -lm -o "$WEB_TEST_BINARY"
"$WEB_TEST_BINARY"
