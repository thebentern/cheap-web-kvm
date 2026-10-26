// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import { indexedDB } from 'fake-indexeddb'
import { encode, decode, crc32, checkRange } from '../app/utils/media/protocol'
import {
  formatFat32,
  FatVolume,
  validateName,
  inspectBoot,
} from '../app/utils/media/fat'
import {
  PersistentDisk,
  fingerprint,
  type Disk,
  type Volume,
} from '../app/utils/media/disk'
class MemoryDisk implements Disk {
  data: Uint8Array
  constructor(readonly size = 64 * 1048576) {
    this.data = new Uint8Array(size)
  }
  async read(o: number, n: number) {
    checkRange(this.size, o, n)
    return this.data.slice(o, o + n)
  }
  async write(o: number, b: Uint8Array) {
    checkRange(this.size, o, b.length)
    this.data.set(b, o)
  }
}
describe('media framing', () => {
  it('matches the standard CRC and preserves 64-bit offsets', () => {
    expect(crc32([new TextEncoder().encode('123456789')])).toBe(0xcbf43926)
    const input = {
      op: 17,
      flags: 0,
      id: 0x12345678,
      session: 42,
      offset: 8 * 1073741824,
      length: 3,
      data: new Uint8Array([1, 2, 3]),
    }
    expect(decode(encode(input))).toEqual(input)
    const p = encode(input)
    p[32] ^= 1
    expect(() => decode(p)).toThrow(/integrity/)
    expect(() => decode(p.slice(0, 31))).toThrow(/truncated/)
  })
  it('rejects bounds, overflow, empty IDs and impossible transfer sizes', () => {
    for (const [o, n] of [
      [-1, 1],
      [1024, 1],
      [1023, 2],
      [0, 0],
      [Number.MAX_SAFE_INTEGER, 100],
    ])
      expect(() => checkRange(1024, o!, n!)).toThrow()
    expect(() =>
      encode({ op: 1, flags: 0, id: 0, session: 0, offset: 0, length: 0 }),
    ).toThrow()
  })
})
describe('FAT32 volume interoperability', () => {
  it('creates MBR FAT32, mirrored FATs, backup BPB, valid clusters and volume label', async () => {
    const d = new MemoryDisk()
    await formatFat32(d, 'KVM FILES')
    const v = new DataView(d.data.buffer),
      b = 2048 * 512
    expect(d.data[450]).toBe(12)
    expect(v.getUint32(454, true)).toBe(2048)
    expect(v.getUint16(b + 11, true)).toBe(512)
    expect(d.data[b + 13]).toBe(1)
    expect(d.data.slice(b, b + 512)).toEqual(
      d.data.slice(b + 6 * 512, b + 7 * 512),
    )
    const f = await FatVolume.open(d)
    expect(f.fat32).toBe(true)
    expect(f.clusters).toBeGreaterThanOrEqual(65525)
    expect(await f.list()).toEqual([])
    if (process.env.MEDIA_FAT_FIXTURE) {
      await f.add(f.root, 'Client file.txt', new Blob(['client-added file\n']))
      writeFileSync(process.env.MEDIA_FAT_FIXTURE, d.data.subarray(2048 * 512))
    }
  })
  it('adds nested long/unicode filenames, reopens, reads exact bytes and deletes safely', async () => {
    const d = new MemoryDisk()
    await formatFat32(d, 'TEST')
    let f = await FatVolume.open(d)
    await f.add(f.root, 'Pictures 🌍')
    const folder = (await f.list())[0]!,
      content = crypto.getRandomValues(new Uint8Array(16001))
    await f.add(
      folder.cluster,
      'Hello unicode résumé 🌱.bin',
      new Blob([content]),
    )
    await f.add(folder.cluster, 'empty file.txt', new Blob([]))
    f = await FatVolume.open(d)
    const list = await f.list(await f.find(['pictures 🌍']))
    expect(list.map((e) => e.name)).toEqual([
      'Hello unicode résumé 🌱.bin',
      'empty file.txt',
    ])
    expect(await f.readFile(list[0]!)).toEqual(content)
    expect(await f.readFile(list[0]!, 4093, 2000)).toEqual(
      content.slice(4093, 6093),
    )
    await expect(f.remove(folder)).rejects.toThrow(/contents/)
    await f.remove(list[0]!)
    await f.remove(list[1]!)
    await f.remove(folder)
    expect(await f.list()).toEqual([])
  })
  it('extends directories across clusters, preserves LFN slots and reuses deleted space', async () => {
    const d = new MemoryDisk()
    await formatFat32(d, 'SLOTS')
    let f = await FatVolume.open(d)
    for (let i = 0; i < 28; i++)
      await f.add(
        f.root,
        `Long directory entry number ${i}.txt`,
        new Blob([`${i}`]),
      )
    f = await FatVolume.open(d)
    const list = await f.list()
    expect(list).toHaveLength(28)
    for (let i = 0; i < list.length; i++)
      expect(new TextDecoder().decode(await f.readFile(list[i]!))).toBe(`${i}`)
    for (const entry of list.slice(0, 7)) await f.remove(entry)
    await f.add(f.root, 'replacement.txt', new Blob(['replacement']))
    expect(await (await FatVolume.open(d)).list()).toHaveLength(22)
  })
  it('detects a fallback loader without changing the image', async () => {
    const d = new MemoryDisk()
    await formatFat32(d, 'EFI')
    const f = await FatVolume.open(d)
    await f.add(f.root, 'EFI')
    const efi = (await f.list())[0]!
    await f.add(efi.cluster, 'BOOT')
    const boot = (await f.list(efi.cluster))[0]!
    await f.add(
      boot.cluster,
      'BOOTX64.EFI',
      new Blob(['fixture; not a real PE executable']),
    )
    const before = d.data.slice()
    expect((await inspectBoot(d)).found).toBe(true)
    expect(d.data.every((v, i) => v === before[i])).toBe(true)
  })
  it('rejects capacity, label, filename, oversized file, mirror damage and cyclic chains', async () => {
    await expect(
      formatFat32(new MemoryDisk(8 * 1048576), 'TEST'),
    ).rejects.toThrow(/capacity/)
    const d = new MemoryDisk()
    await expect(formatFat32(d, 'TOO-LONG-LABEL')).rejects.toThrow(/label/)
    for (const name of [
      'CON.txt',
      'bad:name',
      'file.',
      'file ',
      'x'.repeat(256),
      '../escape',
    ])
      expect(() => validateName(name)).toThrow()
    await formatFat32(d, 'BAD')
    const f = await FatVolume.open(d)
    await expect(
      f.add(f.root, 'huge', { size: 0x100000000 } as Blob),
    ).rejects.toThrow(/4 GiB/)
    d.data[(f.fatStart + f.fatSectors) * 512 + 10] ^= 1
    await expect(FatVolume.open(d)).rejects.toThrow(/copies differ/)
    // Match both FATs but create a root loop.
    for (let copy = 0; copy < 2; copy++)
      new DataView(d.data.buffer).setUint32(
        (f.fatStart + copy * f.fatSectors) * 512 + 8,
        2,
        true,
      )
    await expect((await FatVolume.open(d)).list()).rejects.toThrow(/chain/)
  })
})
// Fake IDB executes real async transactions. Web Lock stub models exclusivity.
const held = new Set<string>()
beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: indexedDB,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      locks: {
        async request(
          name: string,
          _options: unknown,
          fn: (lock: object | null) => Promise<void>,
        ) {
          if (held.has(name)) return fn(null)
          held.add(name)
          try {
            return await fn({})
          } finally {
            held.delete(name)
          }
        },
      },
    },
  })
})
describe('durable copy-on-write disk', () => {
  it('persists unaligned cross-page writes atomically across close/reopen and preserves source', async () => {
    const source = new File([new Uint8Array(131072).fill(7)], 'disk.img'),
      hash = await fingerprint(source)
    const meta: Volume = {
      id: crypto.randomUUID(),
      kind: 'boot',
      name: source.name,
      size: source.size,
      fingerprint: hash,
      created: '',
      revision: 0,
      exportedRevision: -1,
    }
    let d = await PersistentDisk.open(meta, source, true)
    const patch = new Uint8Array(8192).fill(42)
    await d.write(65530, patch)
    expect(d.meta.revision).toBe(1)
    await expect(PersistentDisk.open(meta, source)).rejects.toThrow(
      /another tab/,
    )
    await d.close()
    d = await PersistentDisk.open(meta, source)
    expect(await d.read(65530, 8192)).toEqual(patch)
    expect((await d.read(65529, 8194))[0]).toBe(7)
    expect(
      new Uint8Array(await source.arrayBuffer()).every((b) => b === 7),
    ).toBe(true)
    await d.setNeedsCheck(true)
    await d.close()
    d = await PersistentDisk.open(meta, source)
    expect(d.meta.needsCheck).toBe(true)
    await d.close()
    await expect(
      PersistentDisk.open({ ...meta, fingerprint: 'wrong' }, source),
    ).rejects.toThrow(/original/)
    await expect(fingerprint(new File(['xz'], 'disk.img.xz'))).rejects.toThrow(
      /sector-aligned/,
    )
  })
  it('keeps committed data and revision intact if storage commit aborts', async () => {
    const meta: Volume = {
      id: crypto.randomUUID(),
      kind: 'fat32',
      name: 'FAULT',
      size: 1048576,
      created: '',
      revision: 0,
      exportedRevision: -1,
    }
    const d = await PersistentDisk.open(meta, undefined, true)
    await d.write(0, new Uint8Array([1, 2, 3]))
    const original = (d as any).transaction.bind(d)
    ;(d as any).transaction = (stores: string[]) => {
      const tx = original(stores)
      queueMicrotask(() => tx.abort())
      return tx
    }
    await expect(d.write(0, new Uint8Array([9, 9, 9]))).rejects.toThrow()
    expect(await d.read(0, 3)).toEqual(new Uint8Array([1, 2, 3]))
    expect(d.meta.revision).toBe(1)
    await d.close()
    const reopened = await PersistentDisk.open(meta)
    expect(await reopened.read(0, 3)).toEqual(new Uint8Array([1, 2, 3]))
    await reopened.close()
  })
})

it('keeps valid FAT32 cluster counts across capacity transitions through 32 GiB', async () => {
  for (const mib of [64, 260, 261, 2048, 2049, 4096, 4097, 32768]) {
    const chunks: { at: number; data: Uint8Array }[] = []
    const disk: Disk = {
      size: mib * 1048576,
      async read(offset, length) {
        const out = new Uint8Array(length)
        for (const c of chunks) {
          const first = Math.max(offset, c.at),
            end = Math.min(offset + length, c.at + c.data.length)
          if (first < end)
            out.set(c.data.subarray(first - c.at, end - c.at), first - offset)
        }
        return out
      },
      async write(at, data) {
        chunks.push({ at, data: data.slice() })
      },
    }
    await formatFat32(disk, 'CAPACITY')
    const fat = await FatVolume.open(disk)
    expect(fat.clusters).toBeGreaterThanOrEqual(65525)
    expect(await fat.list()).toEqual([])
  }
})
