#!/usr/bin/env python3
"""Measure CH9329 vendor echo at the firmware's configured UART baud.

The standard firmware and this tool default to 921600 baud.
Flash matching CONFIG_KVM_UART_BAUD values before testing other rates.
This does not change baud on a live board, write disks, or claim media support.
Needs pyserial. SPDX-License-Identifier: GPL-3.0-or-later
"""
import argparse
import json
import os
import time
from ch9329_test import frame


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('-p', '--port', required=True)
    ap.add_argument('--baud', type=int, default=921600,
                    help='must match firmware (default: 921600)')
    ap.add_argument('--seconds', type=float, default=5)
    args = ap.parse_args()
    import serial
    payload = os.urandom(64)
    request = frame(0x34, payload)
    expected = frame(0xb4, payload)
    with serial.Serial(args.port, args.baud, timeout=1) as port:
        time.sleep(0.2)
        port.reset_input_buffer()
        start = time.monotonic()
        count, maximum = 0, 0
        while time.monotonic() - start < args.seconds:
            tick = time.monotonic()
            port.write(request)
            response = port.read(len(expected))
            if response != expected:
                raise SystemExit('Echo mismatch/timeout: check firmware baud, bridge support and wiring; no performance result accepted')
            maximum = max(maximum, time.monotonic() - tick)
            count += 1
        elapsed = time.monotonic() - start
    print(json.dumps({'baud': args.baud, 'seconds': elapsed, 'verified_frames': count,
                      'payload_round_trip_bytes_per_second': count * len(payload) * 2 / elapsed,
                      'max_rtt_ms': maximum * 1000, 'media_transport': False}, indent=2))


if __name__ == '__main__':
    main()
