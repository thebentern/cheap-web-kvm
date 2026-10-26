// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { decodeXz, inspectXz } from '../app/utils/media/xz'
import { crc32 } from '../app/utils/media/protocol'

// xz --check=crc64 of 512 bytes with byte[i] = i % 251.
const FIXTURE =
  '/Td6WFoAAATm1rRGBMDyAYAEIQEWAAAAAAAAAPiVPDTgAf8A6l0AAABSUAqE+ZuygCGpadYn4D4GWl8EjVPUBLo5VwUJwVUk3p24cVkxYKGf+W9Jc/LI6oy6GospaSGA/jODZq9GbeyeiYoLg/A8DomOP+1f556Q2Rz/MvSy4DlRstIUFbTFcbrbBuN5mp+7OMGwAKyTC6oGGQMSCBVbm8hI8DIu/i2gh8jwpODSUeuNZ1aSsk2ExfGGMd9qYlvCeS3Z9zxzunR0B9g8qVYiJKFm+FqEXzBn0vZLSS5/IOvb+BAOlHh3xz9r77TNleJv9kRuBs8LghrL23rwV42Y/5DAPubBEkF17gOeCaXAOAAAAAAA3SDrjYcoLIoAAY4CgAQAAPLsf3exxGf7AgAAAAAEWVo='
const bytes = () => Uint8Array.from(Buffer.from(FIXTURE, 'base64'))
const expected = () => Uint8Array.from({ length: 512 }, (_, i) => i % 251)
const checksum = (data: Uint8Array, offset: number, content: Uint8Array) =>
  new DataView(data.buffer).setUint32(offset, crc32([content]), true)

function vli(value: number) {
  const result: number[] = []
  do {
    const digit = value % 128
    value = Math.floor(value / 128)
    result.push(digit + (value ? 128 : 0))
  } while (value)
  return result
}

// Metadata-only fixture lets size/overflow checks run without allocating a disk.
function indexed(raw: number | number[]) {
  const indexData = [0, 1, 8, ...(Array.isArray(raw) ? raw : vli(raw))]
  while (indexData.length % 4) indexData.push(0)
  const index = new Uint8Array(indexData.length + 4)
  index.set(indexData)
  checksum(index, indexData.length, index.subarray(0, indexData.length))
  const footer = bytes().slice(-12)
  new DataView(footer.buffer).setUint32(4, index.length / 4 - 1, true)
  checksum(footer, 0, footer.subarray(4, 10))
  return new Blob([bytes().slice(0, 12), new Uint8Array(8), index, footer])
}

async function collect(file: Blob) {
  const output: number[] = []
  const reader = decodeXz(file).getReader()
  while (true) {
    const part = await reader.read()
    if (part.done) return Uint8Array.from(output)
    expect(part.value.length).toBeLessThanOrEqual(65536)
    output.push(...part.value)
  }
}

describe('XZ disk image import', () => {
  it('reads exact size from checked metadata and decodes standard CRC64 bytes', async () => {
    const file = new Blob([bytes()])
    expect(await inspectXz(file)).toEqual({ size: 512 })
    expect(await collect(file)).toEqual(expected())
  })

  it('supports concatenated streams and four-byte stream padding', async () => {
    const file = new Blob([
      bytes(),
      new Uint8Array(8),
      bytes(),
      new Uint8Array(4),
    ])
    expect(await inspectXz(file)).toEqual({ size: 1024 })
    expect(await collect(file)).toEqual(
      new Uint8Array([...expected(), ...expected()]),
    )
  })

  it('keeps size arithmetic exact above four GiB', async () => {
    expect(await inspectXz(indexed(2 ** 32 + 512))).toEqual({
      size: 2 ** 32 + 512,
    })
    await expect(inspectXz(indexed(0xffffffff * 512 + 512))).rejects.toThrow(
      /2 TiB/,
    )
    await expect(inspectXz(indexed(513))).rejects.toThrow(/512-byte/)
  })

  it('rejects truncated, corrupt or inconsistent metadata before import', async () => {
    const original = bytes()
    for (const file of [
      new Blob([]),
      new Blob([original.slice(0, -1)]),
      new Blob([original.slice(0, -12)]),
      new Blob([new Uint8Array(64)]),
    ])
      await expect(inspectXz(file)).rejects.toThrow(/damaged or incomplete/)
    for (const offset of [
      0,
      7,
      8,
      original.length - 12,
      original.length - 17,
    ]) {
      const changed = original.slice()
      changed[offset] ^= 1
      await expect(inspectXz(new Blob([changed]))).rejects.toThrow()
    }
    await expect(
      inspectXz(new Blob([original, new Uint8Array(1)])),
    ).rejects.toThrow()
  })

  it('bounds index allocation and rejects integer overflow/noncanonical VLIs', async () => {
    const changed = bytes()
    const footer = changed.subarray(-12)
    new DataView(footer.buffer, footer.byteOffset).setUint32(
      4,
      (16 * 1048576) / 4,
      true,
    )
    new DataView(footer.buffer, footer.byteOffset).setUint32(
      0,
      crc32([footer.subarray(4, 10)]),
      true,
    )
    await expect(inspectXz(new Blob([changed]))).rejects.toThrow(/index larger/)
    await expect(inspectXz(indexed([0x80, 0]))).rejects.toThrow(
      /damaged or incomplete/,
    )
    await expect(inspectXz(indexed(Array(9).fill(0xff)))).rejects.toThrow(
      /damaged or incomplete/,
    )
    await expect(
      inspectXz(indexed([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10])),
    ).rejects.toThrow(/damaged or incomplete/)
  })

  it('rejects unsupported integrity checks instead of skipping verification', async () => {
    const changed = bytes()
    changed[7] = 10 // SHA-256 is not implemented by the embedded decoder.
    checksum(changed, 8, changed.subarray(6, 8))
    changed[changed.length - 3] = 10
    checksum(changed, changed.length - 12, changed.subarray(-8, -2))
    await expect(inspectXz(new Blob([changed]))).rejects.toThrow(
      /unsupported integrity check/,
    )
  })

  it('rejects damaged payload even when its size metadata remains valid', async () => {
    const changed = bytes()
    changed[42] ^= 1
    const file = new Blob([changed])
    expect(await inspectXz(file)).toEqual({ size: 512 })
    await expect(collect(file)).rejects.toThrow(/damaged or incomplete/)
    // A failed stream must release the shared decoder mutex.
    expect(await collect(new Blob([bytes()]))).toEqual(expected())
  })

  it('cancels before or after reading without poisoning the next import', async () => {
    const unread = decodeXz(new Blob([bytes()])).getReader()
    await unread.cancel()
    const reader = decodeXz(new Blob(Array(256).fill(bytes()))).getReader()
    expect((await reader.read()).value?.length).toBeGreaterThan(0)
    await reader.cancel()
    expect(await collect(new Blob([bytes()]))).toEqual(expected())
  })

  it('aborts while compressed-file I/O is pending', async () => {
    let enter!: () => void
    let finish!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    class SlowBlob extends Blob {
      override slice(start?: number, end?: number, type?: string) {
        const result = super.slice(start, end, type)
        const arrayBuffer = result.arrayBuffer.bind(result)
        result.arrayBuffer = async () => {
          enter()
          await gate
          return arrayBuffer()
        }
        return result
      }
    }
    const abort = new AbortController()
    const reader = decodeXz(new SlowBlob([bytes()]), abort.signal).getReader()
    const pending = reader.read()
    await entered
    abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    finish()
    expect(await collect(new Blob([bytes()]))).toEqual(expected())
  })
})
