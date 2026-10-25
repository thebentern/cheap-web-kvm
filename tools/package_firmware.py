#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Package an ESP-IDF build for the browser flasher without touching a device."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
FLASH_SIZE = 8 * 1024 * 1024
SECTOR_SIZE = 4096
NVS_START = 0x9000
NVS_END = 0xF000
FACTORY_END = 0x110000
FLASH_SETTINGS = {"flash_size": "8MB", "flash_mode": "dio", "flash_freq": "80m"}
PARTS = (
    ("bootloader", 0, "bootloader/bootloader.bin", "bootloader.bin"),
    ("partition-table", 0x8000, "partition_table/partition-table.bin", "partition-table.bin"),
    ("app", 0x10000, "cheap-web-kvm.bin", "cheap-web-kvm.bin"),
)


def parse_offset(value: object) -> int:
    if not isinstance(value, str):
        raise ValueError("flash offsets must be hexadecimal or decimal strings")
    try:
        return int(value, 0)
    except ValueError as error:
        raise ValueError(f"invalid flash offset: {value!r}") from error


def validate_args(arguments: dict) -> None:
    settings = arguments.get("flash_settings", {})
    if not isinstance(settings, dict) or any(settings.get(key) != value for key, value in FLASH_SETTINGS.items()):
        raise ValueError("firmware must use 8MB flash, dio mode and 80m frequency")
    extra = arguments.get("extra_esptool_args", {})
    if not isinstance(extra, dict) or extra.get("chip") != "esp32s3":
        raise ValueError("firmware must target esp32s3")

    # IDF records the same settings twice. Refuse contradictory build metadata.
    write_args = arguments.get("write_flash_args")
    if not isinstance(write_args, list) or len(write_args) != 6:
        raise ValueError("unexpected write_flash_args")
    expected_args = {"--" + key: value for key, value in FLASH_SETTINGS.items()}
    if any(not isinstance(item, str) for item in write_args) or dict(zip(write_args[::2], write_args[1::2])) != expected_args:
        raise ValueError("write_flash_args do not match flash_settings")

    files = arguments.get("flash_files")
    if not isinstance(files, dict) or len(files) != len(PARTS):
        raise ValueError("expected exactly bootloader, partition table and application binaries")
    parsed = {parse_offset(offset): source for offset, source in files.items()}
    if parsed != {offset: source for _, offset, source, _ in PARTS}:
        raise ValueError("unexpected firmware paths or flash offsets")
    for name, offset, source, _ in PARTS:
        entry = arguments.get(name)
        if not isinstance(entry, dict) or parse_offset(entry.get("offset")) != offset or entry.get("file") != source:
            raise ValueError(f"inconsistent {name} flash metadata")
        if entry.get("encrypted") is not False and entry.get("encrypted") != "false":
            raise ValueError("encrypted firmware is not supported by the browser bundle")


def factory_end(partition_table: bytes) -> int:
    """Validate the actual partition layout, including the NVS preservation rule."""
    partitions = []
    checksum_found = False
    for index in range(0, len(partition_table), 32):
        entry = partition_table[index:index + 32]
        if len(entry) != 32:
            raise ValueError("truncated partition table")
        if entry[:2] == b"\xeb\xeb":
            if entry[:16] != b"\xeb\xeb" + b"\xff" * 14 or entry[16:] != hashlib.md5(partition_table[:index]).digest():
                raise ValueError("partition table checksum is invalid")
            if any(value != 0xFF for value in partition_table[index + 32:]):
                raise ValueError("unexpected data after partition table checksum")
            checksum_found = True
            break
        magic, kind, subtype, offset, size, label, flags = struct.unpack("<HBBII16sI", entry)
        if magic != 0x50AA:
            raise ValueError("invalid partition table entry")
        if offset < NVS_START or offset % SECTOR_SIZE or not size or size % SECTOR_SIZE or offset + size > FLASH_SIZE:
            raise ValueError("partition is outside the supported flash layout")
        partitions.append((kind, subtype, offset, size, label.rstrip(b"\0"), flags))
    if not checksum_found:
        raise ValueError("partition table is missing its checksum")
    ordered = sorted(partitions, key=lambda item: item[2])
    if any(left[2] + left[3] > right[2] for left, right in zip(ordered, ordered[1:])):
        raise ValueError("flash partitions overlap")
    nvs = [entry for entry in partitions if entry[0:2] == (1, 2)]
    if nvs != [(1, 2, NVS_START, NVS_END - NVS_START, b"nvs", 0)]:
        raise ValueError("NVS must remain unencrypted at 0x9000..0xf000 to preserve the PIN and pairings")
    apps = [entry for entry in partitions if entry[0] == 0]
    if len(apps) != 1 or apps[0][1:4] != (0, 0x10000, 0x100000) or apps[0][5] != 0:
        raise ValueError("expected one unencrypted 1MB factory application at 0x10000")
    return FACTORY_END


def package_firmware(build_dir: Path, output_dir: Path, version: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{7,40}", version):
        raise ValueError("version must be a Git commit abbreviation")
    build_dir = build_dir.resolve(strict=True)
    arguments = json.loads((build_dir / "flasher_args.json").read_text())
    if not isinstance(arguments, dict):
        raise ValueError("flasher_args.json must contain an object")
    validate_args(arguments)

    # Read and validate every input before changing an existing published bundle.
    binaries = {}
    for _, offset, source, destination in PARTS:
        source_path = build_dir / source
        if not source_path.resolve(strict=True).is_relative_to(build_dir):
            raise ValueError(f"firmware path escapes build directory: {source}")
        if source_path.is_symlink() or not source_path.is_file():
            raise ValueError(f"firmware must be a regular file: {source}")
        size = source_path.stat().st_size
        boundary = 0x8000 if offset == 0 else NVS_START if offset == 0x8000 else FLASH_SIZE
        if size <= 0 or offset + (size + SECTOR_SIZE - 1) // SECTOR_SIZE * SECTOR_SIZE > boundary:
            raise ValueError(f"{source} crosses its flash region or is empty")
        binaries[destination] = source_path.read_bytes()

    app_end = factory_end(binaries["partition-table.bin"])
    if 0x10000 + (len(binaries["cheap-web-kvm.bin"]) + SECTOR_SIZE - 1) // SECTOR_SIZE * SECTOR_SIZE > app_end:
        raise ValueError("application binary exceeds its factory partition")

    manifest = {
        "schemaVersion": 1,
        "name": "$KVM",
        "version": version,
        "board": "ESP32-S3-DevKitC-1-N8R8",
        "chipFamily": "ESP32-S3",
        "flashSize": "8MB",
        "flashMode": "dio",
        "flashFreq": "80m",
        "parts": [
            {"path": destination, "offset": offset, "size": len(binaries[destination]),
             "sha256": hashlib.sha256(binaries[destination]).hexdigest()}
            for _, offset, _, destination in PARTS
        ],
    }
    output_dir = output_dir.resolve()
    if output_dir == build_dir or output_dir.is_relative_to(build_dir):
        raise ValueError("bundle output must be outside the firmware build directory")
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".kvm-firmware-", dir=output_dir.parent) as directory:
        staging = Path(directory)
        for destination, data in binaries.items():
            (staging / destination).write_bytes(data)
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        output_dir.mkdir(exist_ok=True)
        for destination in binaries:
            (staging / destination).replace(output_dir / destination)
        # A visible new manifest always has all three complete binaries beside it.
        (staging / "manifest.json").replace(output_dir / "manifest.json")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", type=Path, default=ROOT / "firmware/build")
    parser.add_argument("--output", type=Path, default=ROOT / "web/public/firmware")
    arguments = parser.parse_args()
    try:
        version = subprocess.check_output(["git", "rev-parse", "--short=12", "HEAD"], cwd=ROOT, text=True).strip()
        manifest = package_firmware(arguments.build_dir, arguments.output, version)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Cannot package firmware: {error}\n")
    print(f"Packaged {manifest['board']} firmware {manifest['version']} into {arguments.output}")


if __name__ == "__main__":
    main()
