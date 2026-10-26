#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Download a board's public trust certificate and verify its fingerprint over USB.
Does not install trust, change credentials, insert media, or write board settings.
Close the browser's serial connection first. Requires pyserial.
"""
import argparse
import hashlib
from pathlib import Path
import ssl
import time
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener
from ch9329_test import frame


def fingerprint(port):
    output = bytearray()
    while len(output) < 64:
        offset = len(output)
        port.write(frame(0x35, bytes([1, 0x80, offset])))
        deadline = time.monotonic() + 3
        data = bytearray()
        while time.monotonic() < deadline:
            data.extend(port.read(128))
            while len(data) >= 6:
                if data[:2] != b'\x57\xab':
                    del data[0]
                    continue
                length = data[4] + 6
                if len(data) < length:
                    break
                reply = bytes(data[:length]); del data[:length]
                if sum(reply[:-1]) & 255 != reply[-1] or reply[3] != 0xb5:
                    continue
                payload = reply[5:-1]
                if len(payload) <= 4 or payload[:4] != bytes([1, 0x80, 64, offset]):
                    raise ValueError('Certificate identity is not ready or firmware does not support it')
                output.extend(payload[4:])
                break
            if len(output) > offset:
                break
        else:
            raise ValueError('USB certificate fingerprint request timed out')
    value = output.decode('ascii')
    if len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
        raise ValueError('Invalid USB certificate fingerprint')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('-p', '--port', required=True)
    parser.add_argument('--baud', type=int, default=921600)
    parser.add_argument('--device', required=True, help='Board HTTP address, e.g. http://192.168.2.218')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    address = urlsplit(args.device)
    if address.scheme != 'http' or not address.netloc or address.username or address.path not in ('', '/') or address.query or address.fragment:
        parser.error('--device must be an http://host[:port] board address')
    import serial
    with serial.Serial(args.port, args.baud, timeout=.1) as port:
        port.reset_input_buffer()
        expected = fingerprint(port)
    opener = build_opener(ProxyHandler({}))
    with opener.open(args.device.rstrip('/') + '/device/ca.crt', timeout=5) as response:
        pem = response.read(8193)
    if len(pem) > 8192:
        raise SystemExit('Certificate response is too large')
    actual = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem.decode('ascii'))).hexdigest()
    if actual != expected:
        raise SystemExit('Certificate does not match the USB identity. Nothing saved.')
    with args.output.open('xb') as out:
        out.write(pem)
    print(f'Verified board certificate saved to {args.output}')
    print(f'SHA-256: {actual}')
    print('Trust installation is a separate, manual step on each client device.')


if __name__ == '__main__':
    main()
