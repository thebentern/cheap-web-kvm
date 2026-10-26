#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu
cd "$(dirname "$0")/.."
TEST_BINARY=$(mktemp /tmp/cheap-kvm-media-test.XXXXXX)
trap 'rm -f "$TEST_BINARY"' EXIT
${CC:-cc} -std=c11 -Wall -Wextra -Werror -Ifirmware/test/stubs -Ifirmware/main firmware/test/media_test.c firmware/main/kvm_media.c firmware/main/media_protocol.c firmware/main/boot_repeat.c -o "$TEST_BINARY"
"$TEST_BINARY"
