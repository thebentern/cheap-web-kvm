#!/usr/bin/env python3
"""Measure USB-UART media echo with concurrent CH9329 control replies.

Close the browser's serial connection before running this tool. --baud must match
CONFIG_KVM_UART_BAUD in the installed firmware (the normal default is 115200).
Needs pyserial. This never inserts media, writes disk sectors, changes baud, or
changes saved device settings. Results are a short transport test, not USB disk,
boot, sustained reliability, or production qualification.

SPDX-License-Identifier: GPL-3.0-or-later
"""
import argparse
from dataclasses import dataclass
import json
import math
import struct
import time
import zlib


MAX_IO = 8192
MEDIA_HEADER = 32
MAX_PACKET = MEDIA_HEADER + MAX_IO
MAX_WIRE = MAX_PACKET + 6
READ_CHUNK = 4096
REQUEST_TIMEOUT = 4.0
MAGIC = b'KVS1'
GET_INFO = b'\x57\xab\x00\x01\x00\x03'


class BenchmarkError(Exception):
    """A framing, integrity, device, or transport failure."""


@dataclass(frozen=True)
class Message:
    op: int
    flags: int
    session: int
    request_id: int
    offset: int
    length: int
    data: bytes


def media_frame(op, request_id, data=b'', session=0):
    if not 0 < request_id <= 0xffffffff or len(data) > MAX_IO:
        raise BenchmarkError('Invalid outgoing media packet')
    header = struct.pack('<4sBBHIIQI', b'KVM1', 1, op, 0, session,
                         request_id, 0, len(data))
    return header + struct.pack('<I', zlib.crc32(header + data)) + data


def envelope(packet=b''):
    if len(packet) > MAX_PACKET or (packet and len(packet) < MEDIA_HEADER):
        raise BenchmarkError('Invalid outgoing USB envelope size')
    return MAGIC + struct.pack('<H', len(packet)) + packet


def decode_media(packet):
    if not MEDIA_HEADER <= len(packet) <= MAX_PACKET:
        raise BenchmarkError('Invalid media packet size')
    magic, version, op, flags, session, request_id, offset, length, crc = \
        struct.unpack('<4sBBHIIQII', packet[:MEDIA_HEADER])
    if magic != b'KVM1' or version != 1:
        raise BenchmarkError('Unsupported media packet header')
    if zlib.crc32(packet[:28] + packet[32:]) != crc:
        raise BenchmarkError('Media CRC mismatch')
    if not request_id or length > MAX_IO:
        raise BenchmarkError('Invalid media request ID or length')
    # This benchmark expects only control replies, which have no sparse payload.
    if length != len(packet) - MEDIA_HEADER:
        raise BenchmarkError('Media reply length mismatch')
    return Message(op, flags, session, request_id, offset, length, packet[32:])


class PacketReader:
    """Bounded mux parser that retains partial reads and whole-frame boundaries."""

    def __init__(self, port):
        self.port = port
        self.buffer = bytearray()
        self.strict = False  # Ignore ROM startup noise before acquiring media.

    def reset(self):
        self.buffer.clear()

    def _extract(self):
        b = self.buffer
        while b:
            if b.startswith(MAGIC):
                if len(b) < 6:
                    return None
                size = int.from_bytes(b[4:6], 'little')
                if size and not MEDIA_HEADER <= size <= MAX_PACKET:
                    raise BenchmarkError('Invalid USB envelope size')
                if len(b) < 6 + size:
                    return None
                packet = bytes(b[6:6 + size])
                del b[:6 + size]
                return 'media', decode_media(packet) if packet else None
            if b.startswith(b'\x57\xab'):
                if len(b) < 5:
                    return None
                if b[2] != 0 or b[4] > 64:
                    raise BenchmarkError('Invalid CH9329 reply header')
                size = b[4] + 6
                if len(b) < size:
                    return None
                packet = bytes(b[:size])
                del b[:size]
                if sum(packet[:-1]) & 255 != packet[-1]:
                    raise BenchmarkError('CH9329 checksum mismatch')
                return 'hid', packet
            if any(magic.startswith(b) for magic in (MAGIC, b'\x57\xab')):
                return None
            if self.strict:
                raise BenchmarkError('Unexpected bytes in the USB serial stream')
            del b[0]
        return None

    def receive(self, deadline):
        while True:
            packet = self._extract()
            if packet is not None:
                return packet
            if time.monotonic() >= deadline:
                raise BenchmarkError(
                    'Reply timed out ({} buffered bytes); check baud and firmware'
                    .format(len(self.buffer)))
            # Reading a fixed 4096 bytes would add the serial read timeout to
            # short replies and distort RTT, especially at high baud rates.
            waiting = self.port.in_waiting
            chunk = self.port.read(min(READ_CHUNK, waiting) if waiting else 1)
            self.buffer.extend(chunk)
            if len(self.buffer) > MAX_WIRE + READ_CHUNK:
                raise BenchmarkError('USB receive buffer exceeded its bound')


class Benchmark:
    def __init__(self, port):
        self.port = port
        self.reader = PacketReader(port)
        self.session = 0
        self.request_id = 0
        self.owned = False

    def write(self, data):
        if self.port.write(data) != len(data):
            raise BenchmarkError('Short serial write')

    def request(self, op, data=b'', concurrent_hid=False):
        self.request_id += 1
        started = time.monotonic()
        self.write(envelope(media_frame(op, self.request_id, data, self.session)))
        hid_started = time.monotonic()
        if concurrent_hid:
            self.write(GET_INFO)
        reply = None
        hid_reply = None
        media_rtt = hid_rtt = 0.0
        deadline = started + REQUEST_TIMEOUT
        while reply is None or (concurrent_hid and hid_reply is None):
            kind, packet = self.reader.receive(deadline)
            received = time.monotonic()
            if kind == 'hid':
                if not concurrent_hid or hid_reply is not None:
                    raise BenchmarkError('Unexpected or duplicate CH9329 reply')
                if packet[3] != 0x81 or packet[4] != 8:
                    raise BenchmarkError('GET_INFO failed or returned an invalid payload')
                hid_reply = packet
                hid_rtt = received - hid_started
                continue
            if packet is None and op == 1 and not self.owned:
                continue  # A stale release ACK from a prior session is harmless.
            if packet is None:
                raise BenchmarkError('Unexpected media release acknowledgment')
            if (reply is not None or packet.op != op | 0x80 or
                    packet.request_id != self.request_id or packet.offset != 0):
                raise BenchmarkError('Unexpected media opcode, request ID, or offset')
            if self.session and packet.session != self.session:
                raise BenchmarkError('Media session mismatch')
            if packet.flags:
                if op == 1 and packet.flags == 2:
                    raise BenchmarkError('Media is busy; close other clients and eject first')
                raise BenchmarkError('Device rejected media command (status {})'
                                     .format(packet.flags))
            if op == 1:
                if not packet.session:
                    raise BenchmarkError('HELLO returned an invalid session')
                # Mark ownership before capability checks so malformed successful
                # HELLO replies still get a best-effort release in cleanup.
                self.session = packet.session
                self.owned = True
                self.reader.strict = True
            reply = packet
            media_rtt = received - started
        return reply, hid_reply, media_rtt, hid_rtt

    def hello(self):
        reply, _, _, _ = self.request(1)
        if reply.data != b'\x01\x01\x00\x02\x00\x20\x01\x01':
            raise BenchmarkError('Firmware does not advertise compatible USB media')

    def heartbeat(self):
        reply, _, _, _ = self.request(5)
        if reply.length != 1:
            raise BenchmarkError('Heartbeat returned an invalid payload')

    def release(self, resynchronize=False):
        if not self.owned:
            return
        # After a failed request, discard its incomplete host-side bytes and
        # resynchronize while waiting for the release ACK. Complete prior replies
        # may precede ACK; none is accepted as a successful benchmark operation.
        if resynchronize:
            self.reader.reset()
            self.reader.strict = False
        self.write(envelope())
        deadline = time.monotonic() + REQUEST_TIMEOUT
        while True:
            kind, packet = self.reader.receive(deadline)
            if kind == 'media' and packet is None:
                self.owned = False
                return


def measure(port, seconds, report):
    benchmark = Benchmark(port)
    failure = None
    try:
        # Opening a programming bridge can reset the board. Keep boot time out of
        # the measured interval, and do not send configuration or reset commands.
        time.sleep(3)
        port.reset_input_buffer()
        benchmark.hello()
        benchmark.heartbeat()
        pattern = b'KVS1\x57\xab\x00\x81\x00\x03' + bytes(range(256))
        payload = (pattern * (MAX_IO // len(pattern) + 1))[:MAX_IO]
        started = time.monotonic()
        while time.monotonic() - started < seconds:
            reply, _, media_rtt, hid_rtt = benchmark.request(
                4, payload, concurrent_hid=True)
            if reply.data != payload:
                raise BenchmarkError('Echo payload mismatch')
            report['verified_echo_round_trips'] += 1
            report['hid_info_replies'] += 1
            report['worst_media_rtt_ms'] = max(
                report['worst_media_rtt_ms'], media_rtt * 1000)
            report['worst_hid_rtt_ms'] = max(
                report['worst_hid_rtt_ms'], hid_rtt * 1000)
            benchmark.heartbeat()
            report['duration_seconds'] = time.monotonic() - started
        report['aggregate_payload_bytes_per_second'] = (
            report['verified_echo_round_trips'] * MAX_IO * 2 /
            report['duration_seconds'])
    except (Exception, KeyboardInterrupt) as error:
        failure = str(error) or 'Interrupted'
    finally:
        if benchmark.owned:
            try:
                benchmark.release(resynchronize=failure is not None)
                report['release_acknowledged'] = True
            except (Exception, KeyboardInterrupt) as error:
                report['release_error'] = str(error) or 'Interrupted during release'
                failure = failure or 'Media release failed'
    report['accepted'] = failure is None
    if failure is not None:
        report['error'] = failure


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('-p', '--port', required=True)
    parser.add_argument('--baud', type=int, default=115200,
                        choices=(115200, 460800, 921600, 2000000))
    parser.add_argument('--seconds', type=float, default=30)
    args = parser.parse_args()
    if not math.isfinite(args.seconds) or args.seconds <= 0:
        parser.error('--seconds must be a finite positive number')
    report = {
        'baud': args.baud,
        'requested_seconds': args.seconds,
        'duration_seconds': 0.0,
        'payload_bytes_each_way': MAX_IO,
        'verified_echo_round_trips': 0,
        'hid_info_replies': 0,
        'aggregate_payload_bytes_per_second': 0.0,
        'worst_media_rtt_ms': 0.0,
        'worst_hid_rtt_ms': 0.0,
        'release_acknowledged': False,
        'accepted': False,
    }
    port = None
    try:
        import serial
        port = serial.Serial()
        port.port = args.port
        port.baudrate = args.baud
        port.timeout = 0.05
        port.write_timeout = REQUEST_TIMEOUT
        port.rts = False
        port.dtr = False
        port.open()
        measure(port, args.seconds, report)
    except (Exception, KeyboardInterrupt) as error:
        report['error'] = str(error) or 'Interrupted'
    finally:
        if port is not None:
            try:
                port.close()
            except Exception as error:
                report['close_error'] = str(error)
                report['accepted'] = False
    for key in ('duration_seconds', 'aggregate_payload_bytes_per_second',
                'worst_media_rtt_ms', 'worst_hid_rtt_ms'):
        report[key] = round(report[key], 3)
    print(json.dumps(report, indent=2))
    return 0 if report['accepted'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
