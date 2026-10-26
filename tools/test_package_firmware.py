#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Exercise bundle validation and publishing without ESP-IDF or hardware."""

import copy
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock

from package_firmware import package_firmware


def partition_table(entries=None):
    if entries is None:
        entries = [
            (1, 2, 0x9000, 0x6000, b"nvs", 0),
            (1, 1, 0xF000, 0x1000, b"phy_init", 0),
            (0, 0, 0x10000, 0x100000, b"factory", 0),
        ]
    data = b"".join(struct.pack("<HBBII16sI", 0x50AA, *entry) for entry in entries)
    data += b"\xeb\xeb" + b"\xff" * 14 + hashlib.md5(data).digest()
    return data.ljust(3072, b"\xff")


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="kvm-package-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.build = self.root / "build"
        self.output = self.root / "public/firmware"
        (self.build / "bootloader").mkdir(parents=True)
        (self.build / "partition_table").mkdir()
        (self.build / "bootloader/bootloader.bin").write_bytes(b"bootloader")
        (self.build / "partition_table/partition-table.bin").write_bytes(partition_table())
        (self.build / "cheap-web-kvm.bin").write_bytes(b"application")
        self.arguments = {
            "write_flash_args": ["--flash_mode", "dio", "--flash_size", "8MB", "--flash_freq", "80m"],
            "flash_settings": {"flash_mode": "dio", "flash_size": "8MB", "flash_freq": "80m"},
            "flash_files": {"0x0": "bootloader/bootloader.bin", "0x8000": "partition_table/partition-table.bin", "0x10000": "cheap-web-kvm.bin"},
            "bootloader": {"offset": "0x0", "file": "bootloader/bootloader.bin", "encrypted": "false"},
            "partition-table": {"offset": "0x8000", "file": "partition_table/partition-table.bin", "encrypted": "false"},
            "app": {"offset": "0x10000", "file": "cheap-web-kvm.bin", "encrypted": "false"},
            "extra_esptool_args": {"chip": "esp32s3"},
        }
        self.write_args()

    def write_args(self, arguments=None):
        (self.build / "flasher_args.json").write_text(json.dumps(self.arguments if arguments is None else arguments))

    def package(self):
        return package_firmware(self.build, self.output, "123456789abc")

    def test_bundle_contract_contents_and_hashes(self):
        manifest = self.package()
        self.assertEqual(manifest, json.loads((self.output / "manifest.json").read_text()))
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertEqual(manifest["version"], "123456789abc")
        self.assertEqual(manifest["board"], "ESP32-S3-DevKitC-1-N8R8")
        self.assertEqual(manifest["chipFamily"], "ESP32-S3")
        self.assertEqual((manifest["flashSize"], manifest["flashMode"], manifest["flashFreq"]), ("8MB", "dio", "80m"))
        self.assertEqual([part["offset"] for part in manifest["parts"]], [0, 0x8000, 0x10000])
        self.assertEqual({path.name for path in self.output.iterdir()}, {"bootloader.bin", "partition-table.bin", "cheap-web-kvm.bin", "manifest.json"})
        for part in manifest["parts"]:
            data = (self.output / part["path"]).read_bytes()
            self.assertEqual(len(data), part["size"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), part["sha256"])
            erased_end = part["offset"] + (part["size"] + 4095) // 4096 * 4096
            self.assertFalse(part["offset"] < 0xF000 and erased_end > 0x9000, "write would erase NVS")

    def test_rejects_wrong_flash_configuration(self):
        for key, value in [("flash_size", "16MB"), ("flash_mode", "qio"), ("flash_freq", "40m")]:
            with self.subTest(setting=key):
                changed = copy.deepcopy(self.arguments)
                changed["flash_settings"][key] = value
                self.write_args(changed)
                with self.assertRaisesRegex(ValueError, "8MB flash"):
                    self.package()

    def test_rejects_wrong_chip(self):
        self.arguments["extra_esptool_args"]["chip"] = "esp32"
        self.write_args()
        with self.assertRaisesRegex(ValueError, "esp32s3"):
            self.package()

    def test_rejects_contradictory_flash_arguments(self):
        self.arguments["write_flash_args"][3] = "4MB"
        self.write_args()
        with self.assertRaisesRegex(ValueError, "do not match"):
            self.package()

    def test_rejects_extra_or_missing_segments(self):
        for mode in ["extra", "missing"]:
            with self.subTest(mode=mode):
                changed = copy.deepcopy(self.arguments)
                if mode == "extra":
                    changed["flash_files"]["0x9000"] = "nvs.bin"
                else:
                    del changed["flash_files"]["0x8000"]
                self.write_args(changed)
                with self.assertRaisesRegex(ValueError, "exactly"):
                    self.package()

    def test_rejects_changed_offsets_and_paths(self):
        for field, value in [("offset", "0x9000"), ("file", "../outside.bin"), ("file", "/tmp/outside.bin")]:
            with self.subTest(field=field, value=value):
                changed = copy.deepcopy(self.arguments)
                changed["app"][field] = value
                if field == "offset":
                    changed["flash_files"][value] = changed["flash_files"].pop("0x10000")
                else:
                    changed["flash_files"]["0x10000"] = value
                self.write_args(changed)
                with self.assertRaisesRegex(ValueError, "paths or flash offsets"):
                    self.package()

    def test_rejects_inconsistent_segment_metadata_and_encryption(self):
        for field, value in [("offset", "0x20000"), ("file", "wrong.bin"), ("encrypted", "true"), ("encrypted", 0)]:
            with self.subTest(field=field, value=value):
                changed = copy.deepcopy(self.arguments)
                changed["app"][field] = value
                self.write_args(changed)
                with self.assertRaises(ValueError):
                    self.package()

    def test_rejects_source_symlink_outside_build(self):
        outside = self.root / "outside.bin"
        outside.write_bytes(b"outside")
        app = self.build / "cheap-web-kvm.bin"
        app.unlink()
        app.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "escapes build"):
            self.package()

    def test_rejects_symlink_directory_escape(self):
        outside = self.root / "external-bootloader"
        outside.mkdir()
        (outside / "bootloader.bin").write_bytes(b"outside")
        (self.build / "bootloader/bootloader.bin").unlink()
        (self.build / "bootloader").rmdir()
        (self.build / "bootloader").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "escapes build"):
            self.package()

    def test_binary_bounds_include_erase_sector_rounding(self):
        cases = [("bootloader/bootloader.bin", 0x8001), ("partition_table/partition-table.bin", 0x1001), ("cheap-web-kvm.bin", 0x100001)]
        for source, size in cases:
            with self.subTest(source=source):
                path = self.build / source
                original = path.read_bytes()
                path.write_bytes(b"\0" * size)
                with self.assertRaises(ValueError):
                    self.package()
                path.write_bytes(original)

    def test_accepts_binaries_exactly_at_region_boundaries(self):
        (self.build / "bootloader/bootloader.bin").write_bytes(b"\0" * 0x8000)
        (self.build / "partition_table/partition-table.bin").write_bytes(partition_table().ljust(4096, b"\xff"))
        (self.build / "cheap-web-kvm.bin").write_bytes(b"\0" * 0x100000)
        manifest = self.package()
        self.assertEqual([part["size"] for part in manifest["parts"]], [0x8000, 0x1000, 0x100000])

    def test_onboard_ui_slot_accepts_larger_app_and_enforces_its_exact_boundary(self):
        entries = [
            (1, 2, 0x9000, 0x6000, b"nvs", 0),
            (1, 1, 0xF000, 0x1000, b"phy_init", 0),
            (0, 0, 0x10000, 0x3F0000, b"factory", 0),
        ]
        (self.build / "partition_table/partition-table.bin").write_bytes(partition_table(entries))
        app = self.build / "cheap-web-kvm.bin"
        for size in (0x100001, 0x3F0000):
            app.write_bytes(b"\0" * size)
            manifest = self.package()
            self.assertEqual(manifest["parts"][2]["size"], size)
            self.assertLessEqual(0x10000 + (size + 4095) // 4096 * 4096, 0x400000)
        app.write_bytes(b"\0" * 0x3F0001)
        with self.assertRaisesRegex(ValueError, "factory partition"):
            self.package()

    def test_requires_exact_phy_and_factory_names_without_extra_partitions(self):
        standard = [
            (1, 2, 0x9000, 0x6000, b"nvs", 0),
            (1, 1, 0xF000, 0x1000, b"phy_init", 0),
            (0, 0, 0x10000, 0x3F0000, b"factory", 0),
        ]
        layouts = [
            [standard[0], standard[2]],
            [standard[0], (1, 1, 0x400000, 0x1000, b"phy_init", 0), standard[2]],
            [standard[0], standard[1], (0, 0, 0x10000, 0x3F0000, b"other", 0)],
            standard + [(1, 0x82, 0x400000, 0x1000, b"extra", 0)],
        ]
        for entries in layouts:
            with self.subTest(entries=entries):
                (self.build / "partition_table/partition-table.bin").write_bytes(partition_table(entries))
                with self.assertRaises(ValueError):
                    self.package()

    def test_rejects_empty_or_missing_binaries(self):
        app = self.build / "cheap-web-kvm.bin"
        app.write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "empty"):
            self.package()
        app.unlink()
        with self.assertRaises(OSError):
            self.package()

    def test_partition_table_must_retain_nvs_and_factory_layout(self):
        for entries in [
            [(1, 2, 0x9000, 0x5000, b"nvs", 0), (0, 0, 0x10000, 0x100000, b"factory", 0)],
            [(1, 2, 0xA000, 0x5000, b"nvs", 0), (0, 0, 0x10000, 0x100000, b"factory", 0)],
            [(1, 2, 0x9000, 0x6000, b"nvs", 1), (0, 0, 0x10000, 0x100000, b"factory", 0)],
            [(1, 2, 0x9000, 0x6000, b"nvs", 0), (0, 0, 0x10000, 0x200000, b"factory", 0)],
            [(1, 2, 0x9000, 0x6000, b"nvs", 0), (0, 0, 0x10000, 0x100000, b"factory", 0), (1, 1, 0xA000, 0x1000, b"overlap", 0)],
        ]:
            with self.subTest(entries=entries):
                (self.build / "partition_table/partition-table.bin").write_bytes(partition_table(entries))
                with self.assertRaises(ValueError):
                    self.package()

    def test_rejects_bad_partition_checksum(self):
        data = bytearray(partition_table())
        data[12] ^= 1
        (self.build / "partition_table/partition-table.bin").write_bytes(data)
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.package()

    def test_invalid_input_leaves_existing_bundle_untouched(self):
        self.package()
        before = {path.name: path.read_bytes() for path in self.output.iterdir()}
        (self.build / "partition_table/partition-table.bin").write_bytes(b"broken")
        with self.assertRaises(ValueError):
            self.package()
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.output.iterdir()})

    def test_manifest_is_published_after_complete_binaries(self):
        replaced = []
        original = Path.replace

        def replace(path, target):
            target = Path(target)
            if target.name == "manifest.json":
                manifest = json.loads(path.read_text())
                for part in manifest["parts"]:
                    self.assertEqual(hashlib.sha256((self.output / part["path"]).read_bytes()).hexdigest(), part["sha256"])
            replaced.append(target.name)
            return original(path, target)

        with mock.patch.object(Path, "replace", replace):
            self.package()
        self.assertEqual(replaced[-1], "manifest.json")


if __name__ == "__main__":
    unittest.main()
