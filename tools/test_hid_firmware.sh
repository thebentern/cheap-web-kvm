#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu
cd "$(dirname "$0")/.."
TEST_BINARY=$(mktemp /tmp/cheap-kvm-hid-test.XXXXXX)
trap 'rm -f "$TEST_BINARY"' EXIT
${CC:-cc} -std=c11 -Wall -Wextra -Werror -Ifirmware/test/hid_stubs -Ifirmware/main \
    firmware/test/hid_test.c firmware/main/boot_repeat.c -o "$TEST_BINARY"
"$TEST_BINARY"
