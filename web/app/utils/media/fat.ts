// SPDX-License-Identifier: GPL-3.0-or-later
// FAT32 with MBR, mirrored FATs, backup BPB/FSInfo and VFAT UTF-16 names.
// Reads FAT16 ESPs too. Filesystem mutation is exclusive and FAT32 only.
import type { Disk } from './disk'
const SECTOR = 512,
  EOC = 0x0fffffff
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
const ascii = (b: Uint8Array) => String.fromCharCode(...b)
function word(b: Uint8Array, at: number, n: number) {
  return n === 2 ? dv(b).getUint16(at, true) : dv(b).getUint32(at, true)
}
function put(b: Uint8Array, at: number, value: number, n = 4) {
  if (n === 2) dv(b).setUint16(at, value, true)
  else dv(b).setUint32(at, value, true)
}
export function validateName(name: string) {
  if (
    !name ||
    name.length > 255 ||
    /[\x00-\x1f"*\/:<>?\\|]/.test(name) ||
    /[. ]$/.test(name) ||
    name === '.' ||
    name === '..' ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(name)
  )
    throw new Error(
      'Use a FAT filename of 1–255 UTF-16 units, without reserved names, trailing dots/spaces, or " * / : < > ? \\ | characters.',
    )
}
export interface Entry {
  name: string
  directory: boolean
  size: number
  cluster: number
  offset: number
  slots: number[]
  short: Uint8Array
}
export interface Partition {
  start: number
  sectors: number
  type: string
}
export async function partitions(
  disk: Disk,
): Promise<{ layout: string; partitions: Partition[] }> {
  const mbr = await disk.read(0, 512)
  if (mbr[510] !== 0x55 || mbr[511] !== 0xaa)
    return {
      layout: 'No MBR signature (optical-only ISO or unsupported image)',
      partitions: [],
    }
  if (mbr[450] === 0xee) {
    const g = await disk.read(512, 512)
    if (ascii(g.subarray(0, 8)) !== 'EFI PART')
      throw new Error('Invalid GPT header')
    const table = Number(dv(g).getBigUint64(72, true)),
      count = word(g, 80, 4),
      size = word(g, 84, 4)
    if (
      !Number.isSafeInteger(table) ||
      count > 4096 ||
      size < 128 ||
      size > 4096 ||
      count * size > 4 * 1024 * 1024
    )
      throw new Error('Unsupported GPT table bounds')
    const entries = await disk.read(table * 512, count * size),
      out: Partition[] = []
    for (let i = 0; i < count; i++) {
      const p = entries.subarray(i * size, (i + 1) * size)
      if (!p.subarray(0, 16).some(Boolean)) continue
      const start = Number(dv(p).getBigUint64(32, true)),
        end = Number(dv(p).getBigUint64(40, true))
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        end < start ||
        (end + 1) * 512 > disk.size
      )
        throw new Error('GPT partition exceeds image')
      const esp =
        ascii(p.subarray(0, 16)) ===
        ascii(
          new Uint8Array([
            0x28, 0x73, 0x2a, 0xc1, 0x1f, 0xf8, 0xd2, 0x11, 0xba, 0x4b, 0, 0xa0,
            0xc9, 0x3e, 0xc9, 0x3b,
          ]),
        )
      out.push({
        start,
        sectors: end - start + 1,
        type: esp ? 'EFI System Partition' : 'GPT data',
      })
    }
    return { layout: 'GPT', partitions: out }
  }
  const out: Partition[] = []
  for (let i = 0; i < 4; i++) {
    const p = mbr.subarray(446 + i * 16, 462 + i * 16),
      type = p[4]!
    if (!type) continue
    const start = word(p, 8, 4),
      sectors = word(p, 12, 4)
    if (!start || (start + sectors) * 512 > disk.size)
      throw new Error('MBR partition exceeds image')
    out.push({
      start,
      sectors,
      type:
        type === 0xef ? 'EFI System Partition' : `MBR 0x${type.toString(16)}`,
    })
  }
  return {
    layout: out.length ? 'MBR' : 'Unpartitioned / superfloppy',
    partitions: out,
  }
}
export function validateFat32(size: number, label: string) {
  if (
    !Number.isInteger(size / 1048576) ||
    size < 64 * 1048576 ||
    size > 32 * 1073741824
  )
    throw new Error('Choose a whole MiB capacity from 64 MiB to 32 GiB.')
  label = label.toUpperCase()
  if (!/^[A-Z0-9 _-]{1,11}$/.test(label) || !label.trim())
    throw new Error(
      'Volume label: 1–11 ASCII letters, digits, spaces, underscores or hyphens.',
    )
}
export async function formatFat32(disk: Disk, label: string) {
  validateFat32(disk.size, label)
  label = label.toUpperCase()
  const total = disk.size / 512,
    start = 2048,
    sectors = total - start,
    spc =
      disk.size <= 260 * 1048576
        ? 1
        : disk.size <= 2 * 1073741824
          ? 8
          : disk.size <= 4 * 1073741824
            ? 32
            : 64
  let fatSectors = 1
  for (;;) {
    const next = Math.ceil(
      ((Math.floor((sectors - 32 - 2 * fatSectors) / spc) + 2) * 4) / 512,
    )
    if (next <= fatSectors) break
    fatSectors = next
  }
  const count = Math.floor((sectors - 32 - 2 * fatSectors) / spc)
  if (count < 65525 || count >= 0x0ffffff5)
    throw new Error('Capacity does not produce a FAT32 cluster count')
  const mbr = new Uint8Array(512)
  mbr.set([0, 0xfe, 0xff, 0xff, 0x0c, 0xfe, 0xff, 0xff], 446)
  put(mbr, 454, start)
  put(mbr, 458, sectors)
  mbr[510] = 0x55
  mbr[511] = 0xaa
  await disk.write(0, mbr)
  const b = new Uint8Array(512)
  b.set([0xeb, 0x58, 0x90])
  b.set(new TextEncoder().encode('KVMFAT32'), 3)
  put(b, 11, 512, 2)
  b[13] = spc
  put(b, 14, 32, 2)
  b[16] = 2
  b[21] = 0xf8
  put(b, 24, 63, 2)
  put(b, 26, 255, 2)
  put(b, 28, start)
  put(b, 32, sectors)
  put(b, 36, fatSectors)
  put(b, 44, 2)
  put(b, 48, 1, 2)
  put(b, 50, 6, 2)
  b[64] = 0x80
  b[66] = 0x29
  put(b, 67, 0x4b564d31)
  b.set(new TextEncoder().encode(label.padEnd(11)), 71)
  b.set(new TextEncoder().encode('FAT32   '), 82)
  b[510] = 0x55
  b[511] = 0xaa
  await disk.write(start * 512, b)
  await disk.write((start + 6) * 512, b)
  const info = new Uint8Array(512)
  put(info, 0, 0x41615252)
  put(info, 484, 0x61417272)
  put(info, 488, count - 1)
  put(info, 492, 3)
  put(info, 508, 0xaa550000)
  await disk.write((start + 1) * 512, info)
  await disk.write((start + 7) * 512, info)
  const fat = new Uint8Array(512)
  put(fat, 0, 0x0ffffff8)
  put(fat, 4, EOC)
  put(fat, 8, EOC)
  await disk.write((start + 32) * 512, fat)
  await disk.write((start + 32 + fatSectors) * 512, fat)
  const root = new Uint8Array(spc * 512)
  root.set(new TextEncoder().encode(label.padEnd(11)))
  root[11] = 8
  await disk.write((start + 32 + 2 * fatSectors) * 512, root)
}
const LFN_POS = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30]
function checksum(short: Uint8Array) {
  let n = 0
  for (const c of short) n = (((n & 1) << 7) + (n >> 1) + c) & 255
  return n
}
export class FatVolume {
  private constructor(
    readonly disk: Disk,
    readonly start: number,
    readonly sectors: number,
    readonly spc: number,
    readonly fatStart: number,
    readonly fatSectors: number,
    readonly fats: number,
    readonly root: number,
    readonly dataStart: number,
    readonly clusters: number,
    readonly fat32: boolean,
    private fat: Uint8Array,
    private rootEntries: number,
  ) {}
  static async open(disk: Disk, start?: number) {
    if (start === undefined) {
      const table = await partitions(disk)
      start = table.partitions[0]?.start ?? 0
    }
    const b = await disk.read(start * 512, 512),
      bytes = word(b, 11, 2),
      spc = b[13]!,
      reserved = word(b, 14, 2),
      fats = b[16]!,
      rootEntries = word(b, 17, 2)
    const sectors = word(b, 19, 2) || word(b, 32, 4),
      fatSectors = word(b, 22, 2) || word(b, 36, 4)
    if (
      bytes !== 512 ||
      b[510] !== 0x55 ||
      b[511] !== 0xaa ||
      !spc ||
      spc > 128 ||
      spc & (spc - 1) ||
      !reserved ||
      fats < 1 ||
      fats > 2 ||
      !fatSectors ||
      sectors * 512 > disk.size - start * 512
    )
      throw new Error('Unsupported FAT boot sector (512-byte sectors required)')
    const rootSectors = Math.ceil((rootEntries * 32) / 512),
      dataStart = start + reserved + fats * fatSectors + rootSectors,
      clusters = Math.floor((sectors - (dataStart - start)) / spc),
      fat32 = clusters >= 65525
    if (
      clusters < 4085 ||
      clusters >= 0x0ffffff5 ||
      fatSectors * 512 > 32 * 1048576 ||
      (clusters + 2) * (fat32 ? 4 : 2) > fatSectors * 512
    )
      throw new Error(
        'FAT12, oversized, or inconsistent FAT table is unsupported',
      )
    if (fat32 && word(b, 40, 2) & 0x80)
      throw new Error('Non-mirrored active FAT volumes need external tools')
    const fat = await disk.read((start + reserved) * 512, fatSectors * 512)
    if (fats === 2) {
      const mirror = await disk.read(
        (start + reserved + fatSectors) * 512,
        fat.length,
      )
      if (fat.some((v, i) => v !== mirror[i]))
        throw new Error(
          'FAT copies differ. Export and run filesystem repair before editing or inserting.',
        )
    }
    return new FatVolume(
      disk,
      start,
      sectors,
      spc,
      start + reserved,
      fatSectors,
      fats,
      fat32 ? word(b, 44, 4) : 0,
      dataStart,
      clusters,
      fat32,
      fat,
      rootEntries,
    )
  }
  private next(cluster: number) {
    return (
      word(this.fat, cluster * (this.fat32 ? 4 : 2), this.fat32 ? 4 : 2) &
      (this.fat32 ? EOC : 0xffff)
    )
  }
  private chain(first: number) {
    const out: number[] = [],
      seen = new Set<number>()
    let c = first
    while (c >= 2 && c < (this.fat32 ? 0x0ffffff8 : 0xfff8)) {
      if (c >= this.clusters + 2 || seen.has(c))
        throw new Error('Corrupt FAT cluster chain')
      seen.add(c)
      out.push(c)
      c = this.next(c)
      if (out.length > this.clusters)
        throw new Error('Cluster chain exceeds disk')
    }
    if (out.length && c < (this.fat32 ? 0x0ffffff8 : 0xfff8))
      throw new Error('Unterminated FAT chain')
    return out
  }
  private address(cluster: number) {
    return (this.dataStart + (cluster - 2) * this.spc) * 512
  }
  private async directoryBytes(cluster: number) {
    if (!this.fat32 && !cluster)
      return [
        {
          offset: (this.fatStart + this.fats * this.fatSectors) * 512,
          bytes: await this.disk.read(
            (this.fatStart + this.fats * this.fatSectors) * 512,
            this.rootEntries * 32,
          ),
        },
      ]
    const chain = this.chain(cluster)
    if (chain.length * this.spc * 512 > 16 * 1048576)
      throw new Error('Directory exceeds the 16 MiB safety limit')
    const out = []
    for (const c of chain)
      out.push({
        offset: this.address(c),
        bytes: await this.disk.read(this.address(c), this.spc * 512),
      })
    return out
  }
  async list(cluster = this.root): Promise<Entry[]> {
    const entries: Entry[] = []
    let fragments = new Map<number, string>(),
      slots: number[] = [],
      expected = 0,
      sum = -1
    for (const { offset, bytes } of await this.directoryBytes(cluster))
      for (let at = 0; at < bytes.length; at += 32) {
        const p = bytes.subarray(at, at + 32)
        if (p[0] === 0) return entries
        if (p[0] === 0xe5) {
          fragments.clear()
          slots = []
          expected = 0
          continue
        }
        if (p[11] === 15) {
          const seq = p[0]! & 31
          if (p[0]! & 64) {
            fragments = new Map()
            slots = []
            expected = seq
            sum = p[13]!
          }
          if (
            !seq ||
            seq !== expected ||
            p[13] !== sum ||
            p[12] !== 0 ||
            word(p, 26, 2)
          ) {
            fragments.clear()
            slots = []
            expected = 0
            continue
          }
          let text = ''
          for (const pos of LFN_POS) {
            const u = word(p, pos, 2)
            if (u && u !== 0xffff) text += String.fromCharCode(u)
          }
          fragments.set(seq, text)
          slots.push(offset + at)
          expected--
          continue
        }
        const short = p.slice(0, 11),
          base = ascii(short.subarray(0, 8)).trimEnd(),
          ext = ascii(short.subarray(8, 11)).trimEnd()
        const name =
          fragments.size && expected === 0 && checksum(short) === sum
            ? [...fragments]
                .sort((a, b) => a[0] - b[0])
                .map((p) => p[1])
                .join('')
            : base + (ext ? `.${ext}` : '')
        if (!(p[11]! & 8) && name !== '.' && name !== '..')
          entries.push({
            name,
            directory: !!(p[11]! & 16),
            size: word(p, 28, 4),
            cluster:
              (this.fat32 ? (word(p, 20, 2) << 16) >>> 0 : 0) + word(p, 26, 2),
            offset: offset + at,
            slots: [...slots, offset + at],
            short,
          })
        fragments.clear()
        slots = []
        expected = 0
      }
    return entries
  }
  async find(path: string[]) {
    let c = this.root
    for (const name of path) {
      const entry = (await this.list(c)).find(
        (e) => e.name.toUpperCase() === name.toUpperCase() && e.directory,
      )
      if (!entry) throw new Error(`Folder not found: ${name}`)
      c = entry.cluster
    }
    return c
  }
  async readFile(entry: Entry, offset = 0, length = entry.size - offset) {
    if (
      entry.directory ||
      offset < 0 ||
      length < 0 ||
      offset + length > entry.size
    )
      throw new Error('Invalid file read')
    const out = new Uint8Array(length),
      chain = this.chain(entry.cluster),
      bytes = this.spc * 512
    if (chain.length * bytes < entry.size)
      throw new Error('Truncated file chain')
    for (let n = 0; n < length;) {
      const at = offset + n,
        c = chain[Math.floor(at / bytes)]!,
        within = at % bytes,
        count = Math.min(length - n, bytes - within)
      out.set(await this.disk.read(this.address(c) + within, count), n)
      n += count
    }
    return out
  }
  private async setLinks(pairs: [number, number][]) {
    const sectors = new Set<number>()
    for (const [cluster, value] of pairs) {
      put(this.fat, cluster * 4, value)
      sectors.add(Math.floor((cluster * 4) / 512))
    }
    for (const sector of sectors)
      for (let copy = 0; copy < this.fats; copy++)
        await this.disk.write(
          (this.fatStart + copy * this.fatSectors + sector) * 512,
          this.fat.slice(sector * 512, sector * 512 + 512),
        )
    // Recompute advisory FSInfo from the current FAT after an exclusive edit.
    const b = await this.disk.read(this.start * 512, 512),
      info = word(b, 48, 2),
      backup = word(b, 50, 2),
      reserved = this.fatStart - this.start
    const infoData = new Uint8Array(8)
    let free = 0,
      next = 0xffffffff
    for (let c = 2; c < this.clusters + 2; c++)
      if (!this.next(c)) {
        free++
        if (next === 0xffffffff) next = c
      }
    put(infoData, 0, free)
    put(infoData, 4, next)
    if (info > 0 && info < reserved)
      await this.disk.write((this.start + info) * 512 + 488, infoData)
    if (backup > 0 && backup + info < reserved)
      await this.disk.write((this.start + backup + info) * 512 + 488, infoData)
  }
  private async allocate(count: number) {
    const free: number[] = []
    for (let c = 2; c < this.clusters + 2 && free.length < count; c++)
      if (!this.next(c)) free.push(c)
    if (free.length < count)
      throw new Error(
        'Virtual drive is full. Remove files or create a larger volume.',
      )
    if (count) await this.setLinks(free.map((c, i) => [c, free[i + 1] ?? EOC]))
    return free
  }
  private writable() {
    if (!this.fat32 || this.fats !== 2)
      throw new Error('Client editing requires FAT32 with two mirrored FATs')
  }
  private async directorySlots(
    cluster: number,
    count: number,
  ): Promise<{ slots: number[]; terminator: number | null }> {
    let run: number[] = [],
      ended = false
    for (const { offset, bytes } of await this.directoryBytes(cluster))
      for (let i = 0; i < bytes.length; i += 32) {
        if (!bytes[i]) ended = true
        if (ended || bytes[i] === 0xe5) run.push(offset + i)
        else run = []
        // Reserve one extra slot for an end marker, including at cluster boundaries.
        if (run.length === count + 1)
          return {
            slots: run.slice(0, count),
            terminator: ended ? run[count]! : null,
          }
      }
    const [c] = await this.allocate(1),
      chain = this.chain(cluster)
    await this.disk.write(this.address(c!), new Uint8Array(this.spc * 512))
    await this.setLinks([[chain.at(-1)!, c!]])
    return this.directorySlots(cluster, count)
  }
  async add(parent: number, name: string, file?: Blob) {
    this.writable()
    validateName(name)
    if (file && file.size > 0xffffffff)
      throw new Error(
        'FAT32 individual files are limited to 4 GiB minus 1 byte.',
      )
    const list = await this.list(parent)
    if (list.some((e) => e.name.toUpperCase() === name.toUpperCase()))
      throw new Error('A file or folder with this name already exists')
    const count = Math.ceil(name.length / 13),
      { slots, terminator } = await this.directorySlots(parent, count + 1)
    const bytes = this.spc * 512,
      allocated = await this.allocate(file ? Math.ceil(file.size / bytes) : 1),
      first = allocated[0] ?? 0
    // Contents are initialized before publishing a directory entry.
    if (file) {
      const per = Math.max(1, Math.floor(1048576 / bytes))
      for (let i = 0; i < allocated.length; i += per) {
        const chunk = new Uint8Array(
          await file.slice(i * bytes, (i + per) * bytes).arrayBuffer(),
        )
        for (let j = 0; j < per && i + j < allocated.length; j++) {
          const data = new Uint8Array(bytes)
          data.set(chunk.subarray(j * bytes, (j + 1) * bytes))
          await this.disk.write(this.address(allocated[i + j]!), data)
        }
      }
    } else {
      const data = new Uint8Array(bytes)
      for (let i = 0; i < 2; i++) {
        const at = i * 32
        data.set(new TextEncoder().encode((i ? '..' : '.').padEnd(11)), at)
        data[at + 11] = 16
        const c = i ? (parent === this.root ? 0 : parent) : first
        put(data, at + 20, c >>> 16, 2)
        put(data, at + 26, c & 65535, 2)
      }
      await this.disk.write(this.address(first), data)
    }
    let alias = '',
      number = 1
    const extension = (name.includes('.') ? name.split('.').at(-1)! : '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 3)
      .padEnd(3)
    do {
      alias = `F${String(number++).padStart(7, '0')}${extension}`
    } while (list.some((e) => ascii(e.short) === alias))
    const short = new TextEncoder().encode(alias),
      sum = checksum(short)
    for (let i = 0; i < count; i++) {
      const seq = count - i,
        b = new Uint8Array(32).fill(255)
      b[0] = seq | (i === 0 ? 64 : 0)
      b[11] = 15
      b[12] = 0
      b[13] = sum
      put(b, 26, 0, 2)
      for (let j = 0; j < 13; j++) {
        const at = (seq - 1) * 13 + j
        put(
          b,
          LFN_POS[j]!,
          at < name.length
            ? name.charCodeAt(at)
            : at === name.length
              ? 0
              : 65535,
          2,
        )
      }
      await this.disk.write(slots[i]!, b)
    }
    const b = new Uint8Array(32)
    b.set(short)
    b[11] = file ? 32 : 16
    put(b, 20, first >>> 16, 2)
    put(b, 26, first & 65535, 2)
    put(b, 28, file?.size ?? 0)
    // Valid FAT timestamps: 1980-01-01 (no local timezone assumptions).
    put(b, 16, 33, 2)
    put(b, 18, 33, 2)
    put(b, 24, 33, 2)
    await this.disk.write(slots[count]!, b)
    if (terminator !== null)
      await this.disk.write(terminator, new Uint8Array(32))
  }
  async remove(entry: Entry) {
    this.writable()
    if (entry.directory && (await this.list(entry.cluster)).length)
      throw new Error('Remove the folder contents first')
    const chain = this.chain(entry.cluster)
    for (const slot of entry.slots)
      await this.disk.write(slot, new Uint8Array([0xe5]))
    if (chain.length) await this.setLinks(chain.map((c) => [c, 0]))
  }
}
export async function inspectBoot(disk: Disk) {
  const table = await partitions(disk),
    details: string[] = [table.layout]
  let found = false,
    checked = false
  const candidates = table.partitions.length
    ? table.partitions.filter(
        (p) =>
          p.type === 'EFI System Partition' ||
          /^MBR 0x(ef|b|c|e|6)$/.test(p.type),
      )
    : [{ start: 0, sectors: disk.size / 512, type: 'superfloppy' }]
  for (const p of table.partitions)
    details.push(`${p.type}: LBA ${p.start}, ${p.sectors} sectors`)
  for (const p of candidates) {
    try {
      const fat = await FatVolume.open(disk, p.start)
      checked = true
      const parent = await fat.find(['EFI', 'BOOT'])
      found ||= (await fat.list(parent)).some(
        (e) => !e.directory && e.name.toUpperCase() === 'BOOTX64.EFI',
      )
    } catch (e) {
      details.push(`ESP inspection: ${(e as Error).message}`)
    }
  }
  details.push(
    found
      ? '\\EFI\\BOOT\\BOOTX64.EFI exists. Signature/Secure Boot trust and hardware boot remain unverified.'
      : checked
        ? 'No x86_64 fallback loader found. Firmware may need an explicit boot entry; no image changes were made.'
        : 'Fallback loader could not be verified. Optical-only ISOs need separate CD/DVD emulation.',
  )
  return { found, checked, details }
}
