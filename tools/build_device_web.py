#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Pack a root-based static UI into bounded, flash-resident ESP32 C assets.

Build the Nuxt UI with NUXT_APP_BASE_URL=/ first. Large optional OCR resources
and flashable firmware are excluded: neither belongs in an 8 MiB device image.
"""

import argparse
import gzip
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit

DEFAULT_MAX_BYTES = 1024 * 1024
EXCLUDED = frozenset({'vendor', 'firmware'})
MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/vnd.microsoft.icon',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
}
SAFE_PATH = re.compile(r'/[A-Za-z0-9_./-]+\Z')


def packed(data: bytes, content_type: str) -> tuple[bytes, str | None]:
    compressible = content_type.startswith('text/') or content_type in {
        'application/json', 'application/wasm', 'image/svg+xml',
    }
    if not compressible:
        return data, None
    compressed = bytearray(gzip.compress(data, compresslevel=9, mtime=0))
    compressed[9] = 255  # gzip OS field: identical output across Python/platforms.
    return (bytes(compressed), 'gzip') if len(compressed) + 32 < len(data) else (data, None)


class ResourceLinks(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.paths: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        field = 'src' if tag == 'script' else 'href' if tag == 'link' else None
        if field:
            value = dict(attrs).get(field)
            if value and value.startswith('/') and not value.startswith('//'):
                self.paths.append(urlsplit(value).path)


def build_device_web(input_dir: Path, output_dir: Path, max_bytes: int = DEFAULT_MAX_BYTES) -> dict:
    if max_bytes <= 0:
        raise ValueError('asset byte budget must be positive')
    root = input_dir.resolve(strict=True)
    if not root.is_dir():
        raise ValueError('UI input must be a static build directory')
    if not (root / 'index.html').is_file():
        raise ValueError('UI input is missing index.html; generate the web app first')
    output = output_dir.resolve()
    if output == root or output.is_relative_to(root):
        raise ValueError('generated C assets must be outside the input UI directory')

    files: dict[str, Path] = {}
    for source in sorted(root.rglob('*')):
        relative = source.relative_to(root)
        if relative.parts[0] in EXCLUDED or any(part.startswith('.') for part in relative.parts):
            continue
        if source.is_symlink():
            raise ValueError(f'UI asset cannot be a symlink: {relative}')
        if source.is_dir():
            continue
        if not source.is_file():
            raise ValueError(f'UI asset must be a regular file: {relative}')
        path = '/' + relative.as_posix()
        if not SAFE_PATH.fullmatch(path) or any(part in ('.', '..') for part in relative.parts):
            raise ValueError(f'UI asset has an unsafe URL path: {relative}')
        files[path] = source

    # Catch a normal GitHub Pages build accidentally packaged into the device.
    # Every absolute script/stylesheet/icon URL must resolve at the device root.
    for path, source in files.items():
        if source.suffix == '.html':
            links = ResourceLinks()
            links.feed(source.read_text(encoding='utf-8'))
            for resource in links.paths:
                if resource not in files:
                    raise ValueError(f'{path} references missing root asset {resource}; rebuild with NUXT_APP_BASE_URL=/')

    entries: dict[str, dict] = {}
    payload = bytearray()
    for path, source in files.items():
        raw = source.read_bytes()
        content_type = MIME_TYPES.get(source.suffix.lower(), 'application/octet-stream')
        data, encoding = packed(raw, content_type)
        entry = {
            'path': path,
            'content_type': content_type,
            'encoding': encoding,
            'etag': '"' + hashlib.sha256(data).hexdigest() + '"',
            'offset': len(payload),
            'size': len(data),
            'raw_size': len(raw),
        }
        entries[path] = entry
        payload.extend(data)
        if len(payload) > max_bytes:
            raise ValueError(f'compressed UI exceeds its {max_bytes}-byte flash budget')
        if path.endswith('/index.html'):
            route = path[:-len('index.html')]
            for alias in ({route, route.rstrip('/')} - {''}):
                if alias in files:
                    raise ValueError(f'UI route conflicts with an asset: {alias}')
                entries[alias] = {**entry, 'path': alias}

    if not payload:
        raise ValueError('UI assets are empty')
    ordered = [entries[path] for path in sorted(entries)]
    manifest = {
        'schemaVersion': 1,
        'stored_bytes': len(payload),
        'max_bytes': max_bytes,
        'excluded_directories': sorted(EXCLUDED),
        'assets': ordered,
    }
    header = '''// Generated by tools/build_device_web.py. Do not edit.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <stddef.h>

typedef struct {
    const char *path;
    const char *content_type;
    const char *encoding;
    const char *etag;
    const unsigned char *data;
    size_t size;
} kvm_web_asset_t;

extern const kvm_web_asset_t kvm_web_assets[];
extern const size_t kvm_web_assets_count;
const kvm_web_asset_t *kvm_web_asset_find(const char *uri);
'''
    lines = [
        '// Generated by tools/build_device_web.py. Do not edit.',
        '// SPDX-License-Identifier: GPL-3.0-or-later',
        '#include "kvm_web_assets.h"',
        '#include <string.h>',
        '',
        '// Const data remains mapped from flash; it is never copied to RAM.',
        'static const unsigned char web_payload[] = {',
    ]
    for index in range(0, len(payload), 20):
        lines.append('    ' + ','.join(f'0x{value:02x}' for value in payload[index:index + 20]) + ',')
    lines.extend(['};', '', 'const kvm_web_asset_t kvm_web_assets[] = {'])
    for entry in ordered:
        fields = [json.dumps(entry[key]) for key in ('path', 'content_type')]
        fields.append(json.dumps(entry['encoding']) if entry['encoding'] else 'NULL')
        fields.extend([json.dumps(entry['etag']), f"web_payload + {entry['offset']}", str(entry['size'])])
        lines.append('    {' + ', '.join(fields) + '},')
    lines.extend([
        '};',
        'const size_t kvm_web_assets_count = sizeof(kvm_web_assets) / sizeof(kvm_web_assets[0]);',
        '',
        'const kvm_web_asset_t *kvm_web_asset_find(const char *uri)',
        '{',
        '    if (!uri || uri[0] != \'/\') return NULL;',
        '    size_t length = strcspn(uri, "?#");',
        '    if (memchr(uri, \'\\\\\', length) || memchr(uri, \'%\', length)) return NULL;',
        '    for (size_t i = 0; i < kvm_web_assets_count; ++i) {',
        '        const kvm_web_asset_t *asset = &kvm_web_assets[i];',
        '        if (strlen(asset->path) == length && !memcmp(uri, asset->path, length)) return asset;',
        '    }',
        '    return NULL;',
        '}',
        '',
    ])
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.device-web-', dir=output.parent) as directory:
        staging = Path(directory)
        for name, text in (
            ('kvm_web_assets.h', header),
            ('kvm_web_assets.c', '\n'.join(lines)),
            ('manifest.json', json.dumps(manifest, indent=2) + '\n'),
        ):
            (staging / name).write_text(text, encoding='utf-8')
        for source in staging.iterdir():
            source.replace(output / source.name)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--max-bytes', type=int, default=DEFAULT_MAX_BYTES)
    args = parser.parse_args()
    try:
        manifest = build_device_web(args.input, args.output, args.max_bytes)
    except (OSError, ValueError) as error:
        parser.exit(1, f'Cannot package device UI: {error}\n')
    print(f"Device UI: {manifest['stored_bytes']} flash bytes, {len(manifest['assets'])} routes (budget {args.max_bytes})")


if __name__ == '__main__':
    main()
