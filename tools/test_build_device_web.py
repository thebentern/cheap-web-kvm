#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests for the ESP32's immutable static asset pack (stdlib only)."""

import gzip
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

from build_device_web import build_device_web


class DeviceWebTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.input = self.root / 'public'
        self.output = self.root / 'generated'
        self.input.mkdir()
        (self.input / '_nuxt').mkdir()
        (self.input / '_nuxt/app.js').write_text('const greeting = "hello";\n' * 300)
        (self.input / 'index.html').write_text('<html><script src="/_nuxt/app.js"></script></html>')
        (self.input / 'docs').mkdir()
        (self.input / 'docs/index.html').write_text('<html>docs</html>')
        (self.input / 'docs/_payload.json').write_text('{"page":"docs"}')
        (self.input / 'icon.png').write_bytes(b'\x89PNG\r\n\x1a\n')
        for name in ('vendor', 'firmware'):
            (self.input / name).mkdir()
            (self.input / name / 'large.bin').write_bytes(b'x' * 2000000)

    def payload(self):
        source = (self.output / 'kvm_web_assets.c').read_text()
        array = source.split('static const unsigned char web_payload[] = {', 1)[1].split('};', 1)[0]
        return bytes(int(value, 16) for value in re.findall('0x([0-9a-f]{2})', array))

    def test_exact_bytes_compression_routes_and_exclusions(self):
        manifest = build_device_web(self.input, self.output)
        entries = {entry['path']: entry for entry in manifest['assets']}
        self.assertEqual(set(entries), {
            '/', '/index.html', '/_nuxt/app.js', '/docs', '/docs/',
            '/docs/index.html', '/docs/_payload.json', '/icon.png',
        })
        self.assertEqual(entries['/']['offset'], entries['/index.html']['offset'])
        self.assertEqual(entries['/docs']['offset'], entries['/docs/index.html']['offset'])
        self.assertEqual(entries['/_nuxt/app.js']['content_type'], 'text/javascript; charset=utf-8')
        self.assertEqual(entries['/docs/_payload.json']['content_type'], 'application/json')
        self.assertEqual(entries['/icon.png']['encoding'], None)
        self.assertEqual(entries['/_nuxt/app.js']['encoding'], 'gzip')
        payload = self.payload()
        for entry in entries.values():
            packed = payload[entry['offset']:entry['offset'] + entry['size']]
            raw = gzip.decompress(packed) if entry['encoding'] else packed
            path = entry['path']
            source = self.input / (path.strip('/') or 'index.html')
            if source.is_dir():
                source /= 'index.html'
            self.assertEqual(raw, source.read_bytes())
            self.assertEqual(len(raw), entry['raw_size'])
        self.assertEqual(len(payload), manifest['stored_bytes'])
        self.assertLess(manifest['stored_bytes'], 1000)

    def test_output_is_deterministic_without_mtime_or_platform_gzip_metadata(self):
        build_device_web(self.input, self.output)
        before = {p.name: p.read_bytes() for p in self.output.iterdir()}
        build_device_web(self.input, self.output)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.output.iterdir()})
        entry = next(e for e in json.loads(before['manifest.json'])['assets'] if e['encoding'])
        compressed = self.payload()[entry['offset']:entry['offset'] + entry['size']]
        self.assertEqual(compressed[4:8], b'\0' * 4)
        self.assertEqual(compressed[9], 255)

    def test_budget_and_validation_fail_before_replacing_a_good_pack(self):
        manifest = build_device_web(self.input, self.output)
        before = (self.output / 'manifest.json').read_bytes()
        with self.assertRaisesRegex(ValueError, 'flash budget'):
            build_device_web(self.input, self.output, manifest['stored_bytes'] - 1)
        self.assertEqual((self.output / 'manifest.json').read_bytes(), before)
        with self.assertRaisesRegex(ValueError, 'positive'):
            build_device_web(self.input, self.output, 0)
        (self.input / 'index.html').write_text('<script src="/cheap-web-kvm/_nuxt/app.js"></script>')
        with self.assertRaisesRegex(ValueError, 'NUXT_APP_BASE_URL=/'):
            build_device_web(self.input, self.output)
        self.assertEqual((self.output / 'manifest.json').read_bytes(), before)

    def test_rejects_missing_entrypoint_output_overlap_unsafe_names_and_symlinks(self):
        with self.assertRaisesRegex(ValueError, 'outside'):
            build_device_web(self.input, self.input / 'generated')
        (self.input / 'bad?file.js').write_text('bad')
        with self.assertRaisesRegex(ValueError, 'unsafe URL'):
            build_device_web(self.input, self.output)
        (self.input / 'bad?file.js').unlink()
        outside = self.root / 'secret.js'
        outside.write_text('private')
        (self.input / '_nuxt/secret.js').symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            build_device_web(self.input, self.output)
        (self.input / '_nuxt/secret.js').unlink()
        (self.input / 'index.html').unlink()
        with self.assertRaisesRegex(ValueError, 'missing index.html'):
            build_device_web(self.input, self.output)

    @unittest.skipUnless(shutil.which('cc'), 'C compiler unavailable')
    def test_generated_lookup_compiles_and_returns_only_exact_known_paths(self):
        build_device_web(self.input, self.output)
        test = self.root / 'lookup.c'
        test.write_text(r'''
#include <assert.h>
#include <string.h>
#include "kvm_web_assets.h"
int main(void) {
    const kvm_web_asset_t *asset = kvm_web_asset_find("/_nuxt/app.js?cache=123");
    assert(asset && asset->size && !strcmp(asset->encoding, "gzip"));
    assert(!strcmp(asset->content_type, "text/javascript; charset=utf-8"));
    assert(kvm_web_asset_find("/")->data == kvm_web_asset_find("/index.html")->data);
    assert(kvm_web_asset_find("/docs")->data == kvm_web_asset_find("/docs/")->data);
    assert(!kvm_web_asset_find(NULL));
    assert(!kvm_web_asset_find(""));
    assert(!kvm_web_asset_find("/unknown"));
    assert(!kvm_web_asset_find("/_nuxt/missing.js"));
    assert(!kvm_web_asset_find("/docs/../index.html"));
    assert(!kvm_web_asset_find("/%2e%2e/index.html"));
    assert(!kvm_web_asset_find("/vendor/large.bin"));
    assert(!kvm_web_asset_find("/firmware/large.bin"));
    assert(!kvm_web_asset_find("/docs\\index.html"));
    return 0;
}
''')
        binary = self.root / 'lookup'
        subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', str(self.output),
                        str(self.output / 'kvm_web_assets.c'), str(test), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    unittest.main()
