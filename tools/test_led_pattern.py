#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Run deterministic LED animation tests on the host; no ESP-IDF or board needed."""

from pathlib import Path
import os
import shlex
import subprocess
import tempfile


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    compiler = shlex.split(os.environ.get("CC", "cc"))
    with tempfile.TemporaryDirectory(prefix="kvm-led-test-") as directory:
        executable = Path(directory) / "test-led-pattern"
        subprocess.run(
            compiler
            + [
                "-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic",
                "-I", str(root / "firmware/main"),
                str(root / "firmware/main/kvm_led_pattern.c"),
                str(root / "firmware/test/test_led_pattern.c"),
                "-o", str(executable),
            ],
            check=True,
        )
        subprocess.run([str(executable)], check=True)


if __name__ == "__main__":
    main()
