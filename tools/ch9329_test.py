#!/usr/bin/env python3
"""CH9329 protocol test harness. See docs/PROTOCOL.md.

Needs pyserial for anything touching hardware; --selftest does not.

    ./ch9329_test.py --selftest
    ./ch9329_test.py -p /dev/tty.usbserial-0001 --info
    ./ch9329_test.py -p /dev/tty.usbserial-0001 --type "hello world"
    ./ch9329_test.py -p /dev/tty.usbserial-0001 --mouse
    ./ch9329_test.py -p /dev/tty.usbserial-0001 --soak 2000

SPDX-License-Identifier: GPL-3.0-or-later
"""

import argparse
import sys
import time

HDR = (0x57, 0xAB)

CMD_GET_INFO = 0x01
CMD_KEYBOARD = 0x02
CMD_MOUSE_ABS = 0x04
CMD_MOUSE_REL = 0x05
CMD_RESET = 0x0F

# Not 32767 - see docs/PROTOCOL.md.
ABS_MAX = 4095

MOD_LCTRL, MOD_LSHIFT, MOD_LALT, MOD_LGUI = 0x01, 0x02, 0x04, 0x08


def checksum(data: bytes) -> int:
    """Sum of every byte, mod 256 - header included."""
    return sum(data) & 0xFF


def frame(cmd: int, payload: bytes = b"", addr: int = 0x00) -> bytes:
    body = bytes([HDR[0], HDR[1], addr, cmd, len(payload)]) + payload
    return body + bytes([checksum(body)])


def f_reset() -> bytes:
    return frame(CMD_RESET)


def f_get_info() -> bytes:
    return frame(CMD_GET_INFO)


def f_keyboard(modifier: int = 0, keys=()) -> bytes:
    """[modifier, reserved, keycode x6]"""
    k = list(keys)[:6]
    k += [0] * (6 - len(k))
    return frame(CMD_KEYBOARD, bytes([modifier, 0x00]) + bytes(k))


def f_mouse_abs(buttons: int = 0, x: int = 0, y: int = 0, wheel: int = 0) -> bytes:
    """[0x02, buttons, xLSB, xMSB, yLSB, yMSB, wheel]"""
    x = max(0, min(ABS_MAX, x))
    y = max(0, min(ABS_MAX, y))
    return frame(CMD_MOUSE_ABS, bytes([0x02, buttons,
                                       x & 0xFF, (x >> 8) & 0xFF,
                                       y & 0xFF, (y >> 8) & 0xFF,
                                       wheel & 0xFF]))


def f_mouse_rel(buttons: int = 0, dx: int = 0, dy: int = 0, wheel: int = 0) -> bytes:
    """[0x01, buttons, dx, dy, wheel]; the UI never emits 0x80 for dx/dy."""
    def enc(v):
        v = max(-127, min(127, v)) & 0xFF
        return 0x81 if v == 0x80 else v

    return frame(CMD_MOUSE_REL,
                 bytes([0x01, buttons, enc(dx), enc(dy), wheel & 0xFF]))


class ReplyError(Exception):
    pass


def parse_reply(buf: bytes, cmd: int):
    """Find the first valid reply frame for `cmd`. Returns (payload, rest)."""
    want_ok = cmd | 0x80
    want_err = cmd | 0xC0
    for i in range(len(buf) - 6):
        if buf[i] != HDR[0] or buf[i + 1] != HDR[1]:
            continue
        reply_byte, length = buf[i + 3], buf[i + 4]
        total = 5 + length + 1
        if i + total > len(buf):
            continue
        if checksum(buf[i:i + total - 1]) != buf[i + total - 1]:
            continue
        payload = buf[i + 5:i + 5 + length]
        if reply_byte == want_ok:
            return payload, buf[i + total:]
        if reply_byte == want_err:
            code = payload[0] if payload else 0xFF
            raise ReplyError(f"device returned error 0x{code:02X} for command 0x{cmd:02X}")
    return None, buf


class Link:
    def __init__(self, port, baud=115200, timeout=0.3, verbose=False):
        import serial  # lazy so --selftest works without pyserial
        self.ser = serial.Serial(port, baud, timeout=0.02)
        self.timeout = timeout
        self.verbose = verbose
        self.stats = {"sent": 0, "acked": 0, "timeouts": 0, "errors": 0}

    def send(self, pkt: bytes, cmd: int, expect_reply=True):
        self.ser.reset_input_buffer()
        self.ser.write(pkt)
        self.stats["sent"] += 1
        if self.verbose:
            print(f"  -> {pkt.hex(' ')}")
        if not expect_reply:
            return None

        buf = b""
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            chunk = self.ser.read(64)
            if chunk:
                buf += chunk
                try:
                    payload, _ = parse_reply(buf, cmd)
                except ReplyError:
                    self.stats["errors"] += 1
                    raise
                if payload is not None:
                    self.stats["acked"] += 1
                    if self.verbose:
                        print(f"  <- ACK payload={payload.hex(' ') or '(empty)'}")
                    return payload
        self.stats["timeouts"] += 1
        raise TimeoutError(f"no reply to command 0x{cmd:02X} within {self.timeout}s "
                           f"(got {len(buf)} bytes: {buf.hex(' ')})")

    def close(self):
        self.ser.close()


_UNSHIFTED = {
    " ": 0x2C, "\n": 0x28, "\t": 0x2B, "-": 0x2D, "=": 0x2E, "[": 0x2F,
    "]": 0x30, "\\": 0x31, ";": 0x33, "'": 0x34, "`": 0x35, ",": 0x36,
    ".": 0x37, "/": 0x38, "0": 0x27,
}
_SHIFTED = {
    "!": 0x1E, "@": 0x1F, "#": 0x20, "$": 0x21, "%": 0x22, "^": 0x23,
    "&": 0x24, "*": 0x25, "(": 0x26, ")": 0x27, "_": 0x2D, "+": 0x2E,
    "{": 0x2F, "}": 0x30, "|": 0x31, ":": 0x33, '"': 0x34, "~": 0x35,
    "<": 0x36, ">": 0x37, "?": 0x38,
}


def char_to_hid(ch):
    """Return (modifier, keycode) or None if the character is unsupported."""
    if "a" <= ch <= "z":
        return 0, 0x04 + ord(ch) - ord("a")
    if "A" <= ch <= "Z":
        return MOD_LSHIFT, 0x04 + ord(ch) - ord("A")
    if "1" <= ch <= "9":
        return 0, 0x1E + ord(ch) - ord("1")
    if ch in _UNSHIFTED:
        return 0, _UNSHIFTED[ch]
    if ch in _SHIFTED:
        return MOD_LSHIFT, _SHIFTED[ch]
    return None


GOLDEN = [
    ("soft reset (0x0F)", f_reset(), "57 ab 00 0f 00 11"),
    ("keyboard: shift+A", f_keyboard(MOD_LSHIFT, [0x04]),
     "57 ab 00 02 08 02 00 04 00 00 00 00 00 12"),
    ("keyboard: all released", f_keyboard(),
     "57 ab 00 02 08 00 00 00 00 00 00 00 00 0c"),
    ("abs mouse: centre (2048,2048)", f_mouse_abs(0, 2048, 2048),
     "57 ab 00 04 07 02 00 00 08 00 08 00 1f"),
    ("rel mouse: dx=-1", f_mouse_rel(0, -1, 0, 0),
     "57 ab 00 05 05 01 00 ff 00 00 0c"),
]


def selftest():
    ok = True
    print("Frame builder golden vectors:\n")
    for desc, produced, expected in GOLDEN:
        got = produced.hex(" ")
        good = got == expected
        ok &= good
        print(f"  {'PASS' if good else 'FAIL'}  {desc}")
        if not good:
            print(f"        got      {got}")
            print(f"        expected {expected}")

    example = bytes.fromhex("57 ab 00 84 01 00 87")
    good = checksum(example[:-1]) == example[-1]
    ok &= good
    print(f"  {'PASS' if good else 'FAIL'}  UI's documented reply example checksums (57 AB 00 84 01 00 87)")

    payload, _ = parse_reply(example, CMD_MOUSE_ABS)
    good = payload == b"\x00"
    ok &= good
    print(f"  {'PASS' if good else 'FAIL'}  reply parser accepts that example")

    good = len(frame(CMD_KEYBOARD, b"\x00")) == 7
    ok &= good
    print(f"  {'PASS' if good else 'FAIL'}  one-byte-payload reply is 7 bytes (UI parser minimum)")

    print("\n" + ("SELFTEST PASSED" if ok else "SELFTEST FAILED"))
    return 0 if ok else 1


def do_info(link):
    print("Querying device info (0x01)...")
    payload = link.send(f_get_info(), CMD_GET_INFO)
    print(f"  firmware version : 0x{payload[0]:02X}")
    print(f"  USB enumerated   : {'yes' if len(payload) > 1 and payload[1] else 'no'}")
    print(f"  raw              : {payload.hex(' ')}")


def do_reset(link):
    print("Sending soft reset (0x0F)...")
    link.send(f_reset(), CMD_RESET)
    print("  acknowledged")


def do_type(link, text, delay):
    print(f"Typing {len(text)} characters...")
    skipped = 0
    for ch in text:
        mapped = char_to_hid(ch)
        if mapped is None:
            skipped += 1
            continue
        modifier, code = mapped
        link.send(f_keyboard(modifier, [code]), CMD_KEYBOARD)
        time.sleep(delay)
        link.send(f_keyboard(), CMD_KEYBOARD)
        time.sleep(delay)
    print(f"  sent, {skipped} unsupported characters skipped")


def do_mouse(link):
    print("Absolute mouse: tracing the screen edges...")
    corners = [(0, 0), (ABS_MAX, 0), (ABS_MAX, ABS_MAX), (0, ABS_MAX), (0, 0)]
    for x0, y0 in corners:
        link.send(f_mouse_abs(0, x0, y0), CMD_MOUSE_ABS)
        time.sleep(0.15)

    print("Absolute mouse: centring...")
    link.send(f_mouse_abs(0, ABS_MAX // 2, ABS_MAX // 2), CMD_MOUSE_ABS)
    time.sleep(0.2)

    print("Relative mouse: small square...")
    for dx, dy in ((20, 0), (0, 20), (-20, 0), (0, -20)):
        link.send(f_mouse_rel(0, dx, dy), CMD_MOUSE_REL)
        time.sleep(0.1)

    print("Scroll wheel (relative, as the UI sends it even in absolute mode)...")
    link.send(f_mouse_rel(0, 0, 0, 1), CMD_MOUSE_REL)
    time.sleep(0.1)
    link.send(f_mouse_rel(0, 0, 0, 0xFF), CMD_MOUSE_REL)
    print("  done")


def do_soak(link, count, delay):
    """Sustained typing; the M4 reliability check."""
    print(f"Soak: {count} keyboard reports at {delay * 1000:.0f}ms intervals...")
    started = time.monotonic()
    worst = 0.0
    for i in range(count):
        code = 0x04 + (i % 26)
        t0 = time.monotonic()
        link.send(f_keyboard(0, [code]), CMD_KEYBOARD)
        link.send(f_keyboard(), CMD_KEYBOARD)
        worst = max(worst, time.monotonic() - t0)
        time.sleep(delay)
        if (i + 1) % 100 == 0:
            print(f"  {i + 1}/{count}")
    elapsed = time.monotonic() - started
    s = link.stats
    print(f"\n  elapsed        : {elapsed:.1f}s ({2 * count / elapsed:.0f} reports/s)")
    print(f"  worst round-trip: {worst * 1000:.1f}ms")
    print(f"  sent/acked      : {s['sent']}/{s['acked']}")
    print(f"  timeouts/errors : {s['timeouts']}/{s['errors']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-p", "--port", help="serial port, e.g. /dev/tty.usbserial-0001")
    ap.add_argument("-b", "--baud", type=int, default=115200)
    ap.add_argument("-t", "--timeout", type=float, default=0.3,
                    help="reply timeout in seconds (the web UI uses 0.3)")
    ap.add_argument("-v", "--verbose", action="store_true", help="dump every frame")
    ap.add_argument("--selftest", action="store_true",
                    help="verify the frame builder against golden vectors, no hardware")
    ap.add_argument("--info", action="store_true", help="query device info")
    ap.add_argument("--reset", action="store_true", help="send a soft reset")
    ap.add_argument("--type", metavar="TEXT", help="type TEXT on the target")
    ap.add_argument("--mouse", action="store_true", help="exercise both mouse modes")
    ap.add_argument("--soak", type=int, metavar="N", help="send N keystrokes back to back")
    ap.add_argument("--delay", type=float, default=0.01,
                    help="delay between reports in seconds (default 0.01)")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if not args.port:
        ap.error("--port is required for anything except --selftest")

    if not any([args.info, args.reset, args.type, args.mouse, args.soak]):
        ap.error("pick at least one action: --info --reset --type --mouse --soak")

    link = Link(args.port, args.baud, args.timeout, args.verbose)
    try:
        if args.reset:
            do_reset(link)
        if args.info:
            do_info(link)
        if args.type:
            do_type(link, args.type, args.delay)
        if args.mouse:
            do_mouse(link)
        if args.soak:
            do_soak(link, args.soak, args.delay)
    except (TimeoutError, ReplyError) as exc:
        print(f"\nFAILED: {exc}", file=sys.stderr)
        return 1
    finally:
        link.close()

    print("\nOK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
