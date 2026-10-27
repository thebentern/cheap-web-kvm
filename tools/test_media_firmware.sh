#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu
cd "$(dirname "$0")/.."
TEST_BINARY=$(mktemp /tmp/cheap-kvm-media-test.XXXXXX)
trap 'rm -f "$TEST_BINARY"' EXIT
${CC:-cc} -std=c11 -Wall -Wextra -Werror -Ifirmware/test/stubs -Ifirmware/main firmware/test/media_test.c firmware/main/kvm_media.c firmware/main/media_protocol.c firmware/main/media_buffers.c firmware/main/boot_repeat.c -o "$TEST_BINARY"
"$TEST_BINARY"
"$TEST_BINARY" --fallback

${CC:-cc} -std=c11 -Wall -Wextra -Werror -Ifirmware/main firmware/test/wifi_settings_test.c firmware/main/wifi_settings.c -o "$TEST_BINARY"
"$TEST_BINARY"

${CC:-cc} -std=c11 -Wall -Wextra -Werror -Ifirmware/main firmware/test/media_serial_test.c firmware/main/media_serial.c -o "$TEST_BINARY"
"$TEST_BINARY"

${CC:-cc} -std=c11 -Wall -Wextra -Werror -Ifirmware/main firmware/test/media_ws_test.c firmware/main/media_ws.c -o "$TEST_BINARY"
"$TEST_BINARY"

${CC:-cc} -std=c11 -Wall -Wextra -Werror -Ifirmware/test/ws_recv_stubs -Ifirmware/test/stubs -Ifirmware/main firmware/test/media_ws_recv_test.c firmware/main/media_ws_recv.c -o "$TEST_BINARY"
"$TEST_BINARY"

${CC:-cc} -std=c11 -Wall -Wextra -Werror -pthread -Ifirmware/test/tls_guard_stubs -Ifirmware/test/ws_recv_stubs -Ifirmware/test/stubs -Ifirmware/main firmware/test/media_tls_guard_test.c firmware/main/media_tls_guard.c -o "$TEST_BINARY"
"$TEST_BINARY"

./tools/test_hid_firmware.sh
