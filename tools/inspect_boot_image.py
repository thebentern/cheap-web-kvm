#!/usr/bin/env python3
"""Read-only MBR/GPT and FAT16/32 x86_64 fallback-loader inspection.

Usage: tools/inspect_boot_image.py unpacked.img [--sha256]
Does not establish Secure Boot trust, execute code, install, or modify the image.
SPDX-License-Identifier: GPL-3.0-or-later
"""
import argparse
import hashlib
import json
import pathlib
import struct
import uuid
import zlib

ESP = uuid.UUID('c12a7328-f81f-11d2-ba4b-00a0c93ec93b')


def inspect(path):
    size = path.stat().st_size
    if path.suffix.lower() == '.xz' or size < 512 or size % 512:
        raise ValueError('Select an unpacked .img or hybrid ISO with 512-byte sectors')
    with path.open('rb') as f:
        def read(offset, count):
            if offset < 0 or count < 0 or offset + count > size:
                raise ValueError('Disk address exceeds image bounds')
            f.seek(offset)
            data = f.read(count)
            if len(data) != count:
                raise ValueError('Short image read')
            return data

        mbr = read(0, 512)
        if mbr[510:] != b'\x55\xaa':
            return {'size': size, 'layout': 'No MBR signature; optical-only or unsupported', 'partitions': [], 'fallback': []}
        parts = []
        if mbr[450] == 0xee:
            header = read(512, 512)
            if header[:8] != b'EFI PART':
                raise ValueError('Invalid GPT signature')
            length, crc = struct.unpack_from('<II', header, 12)
            if not 92 <= length <= 512:
                raise ValueError('Invalid GPT header length')
            check = bytearray(header[:length]); check[16:20] = b'\0' * 4
            if zlib.crc32(check) != crc:
                raise ValueError('GPT header CRC mismatch')
            table, count, width, table_crc = struct.unpack_from('<QIII', header, 72)
            if count > 4096 or not 128 <= width <= 4096 or count * width > 4 * 1048576:
                raise ValueError('Invalid GPT entry bounds')
            entries = read(table * 512, count * width)
            if zlib.crc32(entries) != table_crc:
                raise ValueError('GPT table CRC mismatch')
            layout = 'GPT (header and table CRC verified)'
            for i in range(count):
                entry = entries[i * width:(i + 1) * width]
                if entry[:16] == b'\0' * 16:
                    continue
                kind = uuid.UUID(bytes_le=entry[:16]); start, end = struct.unpack_from('<QQ', entry, 32)
                if end < start or (end + 1) * 512 > size:
                    raise ValueError('Partition outside image')
                parts.append({'start_lba': start, 'sectors': end - start + 1, 'type': str(kind), 'esp': kind == ESP})
        else:
            layout = 'MBR'
            for i in range(4):
                entry = mbr[446 + 16 * i:462 + 16 * i]
                if not entry[4]:
                    continue
                start, count = struct.unpack_from('<II', entry, 8)
                if not start or (start + count) * 512 > size:
                    raise ValueError('Partition outside image')
                parts.append({'start_lba': start, 'sectors': count, 'type': hex(entry[4]), 'esp': entry[4] == 0xef})

        def fallback(part):
            start = part['start_lba']
            b = read(start * 512, 512)
            bps, spc, reserved, copies, root_entries = struct.unpack_from('<HBHBH', b, 11)
            total = struct.unpack_from('<H', b, 19)[0] or struct.unpack_from('<I', b, 32)[0]
            fat_sectors = struct.unpack_from('<H', b, 22)[0] or struct.unpack_from('<I', b, 36)[0]
            if bps != 512 or not spc or spc & (spc - 1) or not reserved or copies not in (1, 2) or not fat_sectors:
                raise ValueError('Unsupported FAT BPB')
            root_sectors = (root_entries * 32 + 511) // 512
            data_lba = start + reserved + copies * fat_sectors + root_sectors
            clusters = (total - (data_lba - start)) // spc
            if clusters < 4085:
                raise ValueError('FAT12 ESP inspection unsupported')
            fat32 = clusters >= 65525
            fat = read((start + reserved) * 512, fat_sectors * 512)
            width = 4 if fat32 else 2
            root = struct.unpack_from('<I', b, 44)[0] if fat32 else 0

            def chain(first):
                seen = set(); c = first
                while 2 <= c < (0x0ffffff8 if fat32 else 0xfff8):
                    if c in seen or c >= clusters + 2:
                        raise ValueError('Invalid or cyclic FAT chain')
                    seen.add(c); yield c
                    c = int.from_bytes(fat[c * width:(c + 1) * width], 'little') & (0xfffffff if fat32 else 0xffff)

            def contents(cluster):
                if not fat32 and not cluster:
                    return read((start + reserved + copies * fat_sectors) * 512, root_entries * 32)
                out = bytearray()
                for c in chain(cluster):
                    out.extend(read((data_lba + (c - 2) * spc) * 512, spc * 512))
                    if len(out) > 16 * 1048576:
                        raise ValueError('Directory exceeds safety limit')
                return out

            entry = None; parent = root
            for component in (b'EFI        ', b'BOOT       ', b'BOOTX64 EFI'):
                entries = contents(parent); entry = None
                for offset in range(0, len(entries), 32):
                    e = entries[offset:offset + 32]
                    if e[0] == 0:
                        break
                    if e[0] == 0xe5 or e[11] == 15 or e[11] & 8:
                        continue
                    if e[:11].upper() == component:
                        entry = e; break
                if entry is None:
                    return {'partition_lba': start, 'fat': 32 if fat32 else 16, 'path': '\\EFI\\BOOT\\BOOTX64.EFI', 'exists': False}
                parent = struct.unpack_from('<H', entry, 26)[0] + ((struct.unpack_from('<H', entry, 20)[0] << 16) if fat32 else 0)
            if entry[11] & 16:
                raise ValueError('Fallback loader is a directory')
            count = struct.unpack_from('<I', entry, 28)[0]
            prefix = contents(parent)[:4096]
            machine = None
            certificate_size = None
            if prefix[:2] == b'MZ' and len(prefix) >= 64:
                pe = struct.unpack_from('<I', prefix, 60)[0]
                if pe + 6 <= len(prefix) and prefix[pe:pe + 4] == b'PE\0\0':
                    machine = hex(struct.unpack_from('<H', prefix, pe + 4)[0])
                    optional = pe + 24
                    if optional + 152 <= len(prefix) and prefix[optional:optional + 2] == b'\x0b\x02':
                        certificate_size = struct.unpack_from('<I', prefix, optional + 148)[0]
            return {'partition_lba': start, 'fat': 32 if fat32 else 16, 'path': '\\EFI\\BOOT\\BOOTX64.EFI', 'exists': True, 'file_size': count, 'pe_machine': machine, 'x86_64': machine == '0x8664', 'embedded_certificate_bytes': certificate_size}

        loaders = []
        for part in parts:
            if part['esp'] or part['type'] in ('0xb', '0xc', '0xe', '0x6'):
                try:
                    loaders.append(fallback(part))
                except ValueError as e:
                    loaders.append({'partition_lba': part['start_lba'], 'error': str(e)})
        return {'size': size, 'layout': layout, 'partitions': parts, 'fallback': loaders,
                'secure_boot': 'Signature and firmware trust not verified; no modifications performed',
                'hardware_boot': 'Not tested'}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('image', type=pathlib.Path)
    ap.add_argument('--sha256', action='store_true')
    a = ap.parse_args(); report = inspect(a.image)
    if a.sha256:
        with a.image.open('rb') as f:
            report['sha256'] = hashlib.file_digest(f, 'sha256').hexdigest()
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
