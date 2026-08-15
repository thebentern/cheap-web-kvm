#!/usr/bin/env python3
"""Validate the USB descriptors in the compiled firmware ELF.

SPDX-License-Identifier: GPL-3.0-or-later
"""
import argparse
import pathlib
import re
import subprocess
import sys

DEFAULT_ELF = pathlib.Path(__file__).resolve().parent.parent / "firmware/build/cheap-web-kvm.elf"
OBJDUMP = "xtensa-esp32s3-elf-objdump"
NM = "xtensa-esp32s3-elf-nm"
ELF = str(DEFAULT_ELF)


def symbols():
    out = subprocess.check_output([NM, "-S", ELF], text=True)
    syms = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 4:
            addr, size, _t, name = parts
            syms[name] = (int(addr, 16), int(size, 16))
    return syms


def memory_image():
    """Address -> byte, over all loadable data sections."""
    out = subprocess.check_output([OBJDUMP, "-s", ELF], text=True)
    mem = {}
    for line in out.splitlines():
        m = re.match(r"^\s+([0-9a-f]{8})\s((?:[0-9a-f]{2,8}\s){1,4})", line)
        if not m:
            continue
        addr = int(m.group(1), 16)
        blob = m.group(2).replace(" ", "")
        for i in range(0, len(blob), 2):
            mem[addr + i // 2] = int(blob[i:i + 2], 16)
    return mem


def grab(mem, addr, size):
    return bytes(mem[addr + i] for i in range(size))


ITEM_TAGS = {
    # Main items (type 0) use tags 8..12, not 0..4.
    (0, 8): "Input", (0, 9): "Output", (0, 11): "Feature",
    (0, 10): "Collection", (0, 12): "Collection End",
    (1, 0): "Usage Page", (1, 1): "Logical Min", (1, 2): "Logical Max",
    (1, 3): "Physical Min", (1, 4): "Physical Max", (1, 5): "Unit Exp",
    (1, 6): "Unit", (1, 7): "Report Size", (1, 8): "Report ID",
    (1, 9): "Report Count", (1, 10): "Push", (1, 11): "Pop",
    (2, 0): "Usage", (2, 1): "Usage Min", (2, 2): "Usage Max",
}
SIZE_MAP = {0: 0, 1: 1, 2: 2, 3: 4}


def parse_hid(desc):
    """Decode report-descriptor items."""
    items, i = [], 0
    while i < len(desc):
        b = desc[i]
        size = SIZE_MAP[b & 0x03]
        typ = (b >> 2) & 0x03
        tag = (b >> 4) & 0x0F
        val = int.from_bytes(desc[i + 1:i + 1 + size], "little") if size else 0
        name = ITEM_TAGS.get((typ, tag), f"tag{typ}:{tag}")
        items.append((name, val, size))
        i += 1 + size
    if i != len(desc):
        raise ValueError(f"descriptor overruns by {i - len(desc)} bytes")
    return items


def report_sizes(items):
    """Return {report_id: {'Input': bits, 'Output': bits}}."""
    sizes, rid, rsize, rcount = {}, 0, 0, 0
    for name, val, _ in items:
        if name == "Report ID":
            rid = val
        elif name == "Report Size":
            rsize = val
        elif name == "Report Count":
            rcount = val
        elif name in ("Input", "Output", "Feature"):
            sizes.setdefault(rid, {}).setdefault(name, 0)
            sizes[rid][name] += rsize * rcount
    return sizes


def main():
    global ELF
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("elf", nargs="?", default=str(DEFAULT_ELF),
                    help="firmware ELF (default: firmware/build/cheap-web-kvm.elf)")
    ELF = ap.parse_args().elf
    if not pathlib.Path(ELF).is_file():
        print(f"ELF not found: {ELF}\nBuild it first: cd firmware && idf.py build", file=sys.stderr)
        return 2

    syms, mem = symbols(), memory_image()
    ok = True

    def check(cond, msg):
        nonlocal ok
        print(("  PASS  " if cond else "  FAIL  ") + msg)
        if not cond:
            ok = False

    addr, size = syms["s_device_desc"]
    dev = grab(mem, addr, size)
    print(f"\ns_device_desc ({size} bytes): {dev.hex(' ')}")
    check(dev[0] == 18 and dev[1] == 0x01, "bLength=18, bDescriptorType=DEVICE")
    check(dev[4] == 0x00, f"bDeviceClass=0x{dev[4]:02x} (per-interface)")
    vid = int.from_bytes(dev[8:10], "little")
    pid = int.from_bytes(dev[10:12], "little")
    check(True, f"idVendor=0x{vid:04x} idProduct=0x{pid:04x}")

    addr, size = syms["s_fs_config_desc"]
    cfg = grab(mem, addr, size)
    print(f"\ns_fs_config_desc ({size} bytes): {cfg.hex(' ')}")
    total = int.from_bytes(cfg[2:4], "little")
    check(total == size, f"wTotalLength={total} matches actual array length {size}")
    check(cfg[4] == 2, f"bNumInterfaces={cfg[4]}")
    check(bool(cfg[7] & 0x20),
          f"bmAttributes=0x{cfg[7]:02x} advertises Remote Wakeup (can wake a sleeping target)")

    i, itfs = 0, []
    while i < len(cfg):
        blen, btype = cfg[i], cfg[i + 1]
        if btype == 0x04:  # INTERFACE
            itfs.append((cfg[i + 2], cfg[i + 5], cfg[i + 6], cfg[i + 7]))
        i += blen
    for num, cls, sub, proto in itfs:
        print(f"    interface {num}: class=0x{cls:02x} subclass=0x{sub:02x} protocol=0x{proto:02x}")
    check(itfs[0] == (0, 0x03, 0x01, 0x01),
          "interface 0 is HID, Boot subclass (1), Keyboard protocol (1)")
    check(itfs[1][1] == 0x03 and itfs[1][2] == 0x00,
          "interface 1 is HID, non-boot")

    addr, size = syms["s_kbd_report_desc"]
    kbd = grab(mem, addr, size)
    print(f"\ns_kbd_report_desc ({size} bytes)")
    kitems = parse_hid(kbd)
    check(not any(n == "Report ID" for n, _, _ in kitems),
          "keyboard has NO report ID (boot-protocol compatible)")
    ksz = report_sizes(kitems)
    check(ksz[0]["Input"] == 64, f"keyboard input report = {ksz[0]['Input']} bits (want 64 = 8 bytes)")
    check(ksz[0].get("Output") == 8, f"keyboard output/LED report = {ksz[0].get('Output')} bits (want 8)")

    addr, size = syms["s_mouse_report_desc"]
    mouse = grab(mem, addr, size)
    print(f"\ns_mouse_report_desc ({size} bytes)")
    mitems = parse_hid(mouse)
    rids = [v for n, v, _ in mitems if n == "Report ID"]
    check(rids == [1, 2], f"report IDs present = {rids} (want [1, 2])")
    msz = report_sizes(mitems)
    check(msz[1]["Input"] == 48, f"absolute report = {msz[1]['Input']} bits (want 48 = 6 bytes)")
    check(msz[2]["Input"] == 32, f"relative report = {msz[2]['Input']} bits (want 32 = 4 bytes)")

    logmax = [v for n, v, s in mitems if n == "Logical Max" and s == 2]
    check(4095 in logmax, f"absolute axes declare LOGICAL_MAX 4095 (found 2-byte maxima: {logmax})")

    print("\n" + ("ALL DESCRIPTOR CHECKS PASSED" if ok else "SOME CHECKS FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
