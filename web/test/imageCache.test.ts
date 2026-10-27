// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import {
  cachedImage,
  cleanImageCache,
  importCompressedImage,
} from '../app/utils/media/imageCache'
import {
  database,
  PersistentDisk,
  volumes,
  type Volume,
} from '../app/utils/media/disk'

// XZ/CRC64 fixture: 2 MiB + 512 bytes, byte[i] = i % 251. Generated once
// with Python's lzma module; tests require no native decompressor or network.
const COMPRESSED =
  '/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj//76AlBdAAAAUlAKhPmbsoAhqWnWJ+A+BlpfBI1T1AS6OVcFCcFVJN6duHFZMWChn/lvSXPyyOqMuhqLKWkhgP4zg2avRm3snomKC4PwPA6Jjj/tX+eekNkc/zL0suA5UbLSFBW0xXG62wbjeZqfuzjBsACskwuqBhkDEggVW5vISPAyLv4toIfI8KTg0lHrjWdWkrJNhMXxhjHfamJbwnkt2fc8c7p0dAfYPKlWIiShZvhahF8wZ9L2S0kufyDr2/gQDpR4d8c/a++0zZXib/ZEbgbPC4Iay9t68FeNmP+QwD7mwRJBde4DnqjoegSV0b7AfmdyeuC6vVn/y92z0tPsI/kLnjc9v9WDUooG7UH9E/uFAI3/OoAmgINRrCtuqCs0rls56r+GInwsRPW90T/wbBnCDL8VCpLvZ6qgzF/vVTGifNVd64ZCEz1noET4Ny1g3etysuRG9lTwiHUsMNvCUFSRIpcGA1/JcDsUwDI3mKUVAaXoowkq7Kr/WiascgwWkqe+OY8k4XCepyNf7CjLhdGVmIp+KpHyJ3X3GcAGmE2Y/div1ZAPxCVT+PWRNjEFpbDub8FwTUcM0ZERqq1gHbrOsScYXFmG6WZSWL7pdqxZ5OVbBQj5x9qt/PtSK3TNHlsgQvndUz34KWQJO4DLKmzftTvwxL0uX6oPPktmQpATDv8Qk/hxeFn4C83/lShGD6n8fN77mjAuVsCPhfODgcBlxCVT+PWRNjEFpbDub8FwTUcM0ZERqq1gHbrOsScYXFmG6WZSWL7pdqxZ5OVbBOaE6riAAwQABQBkG69pAAAAMGgQUldMzrIAAfcEgISAAQb2o3mxxGf7AgAAAAAEWVo='
const RAW_SIZE = 2097664
const DIGEST =
  'c7190d0e848284b5ae882daa22fe8b9272b866d0c74ac322e13b07c78c4c2d09'
const input = () =>
  new File([Buffer.from(COMPRESSED, 'base64')], 'system.img.xz')
const expected = () => Uint8Array.from({ length: RAW_SIZE }, (_, i) => i % 251)
const key = () => `${crypto.randomUUID()}.img`
type StoredFile = {
  bytes: Uint8Array
  writes: number[]
  aborted: boolean
  closed: boolean
}
let files: Map<string, StoredFile>
let created: StoredFile[]
let held: Set<string>
let quota: number
let writeHook: (() => void) | undefined

beforeEach(() => {
  files = new Map()
  created = []
  held = new Set()
  quota = 100 * 1048576
  writeHook = undefined
  const directory = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException('Missing', 'NotFoundError')
        const record = {
          bytes: new Uint8Array(),
          writes: [],
          aborted: false,
          closed: false,
        }
        files.set(name, record)
        created.push(record)
      }
      const record = files.get(name)!
      return {
        async getFile() {
          return new File([record.bytes], name)
        },
        async createWritable() {
          const chunks: Uint8Array[] = []
          return {
            async write(bytes: Uint8Array) {
              writeHook?.()
              record.writes.push(bytes.byteLength)
              // A filesystem write captures bytes before the caller reuses its batch.
              chunks.push(bytes.slice())
            },
            async close() {
              record.bytes = new Uint8Array(
                chunks.reduce((n, chunk) => n + chunk.length, 0),
              )
              let offset = 0
              for (const chunk of chunks) {
                record.bytes.set(chunk, offset)
                offset += chunk.length
              }
              record.closed = true
            },
            async abort() {
              record.aborted = true
            },
          }
        },
      }
    },
    async removeEntry(name: string) {
      files.delete(name)
    },
    async *[Symbol.asyncIterator]() {
      for (const name of [...files.keys()]) yield [name, { kind: 'file' }]
    },
  }
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('navigator', {
    storage: {
      async estimate() {
        return { usage: 0, quota }
      },
      async getDirectory() {
        return {
          async getDirectoryHandle() {
            return directory
          },
        }
      },
    },
    locks: {
      async request(name: string, options: any, callback?: any) {
        const action = callback ?? options
        if (held.has(name)) {
          if (options.ifAvailable) return action(null)
          throw new Error('Unexpected conflicting test lock')
        }
        held.add(name)
        try {
          return await action({ name })
        } finally {
          held.delete(name)
        }
      },
    },
  })
})
afterEach(() => vi.unstubAllGlobals())

async function reference(sourceCache: string) {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('volumes', 'readwrite')
      tx.objectStore('volumes').put({ id: crypto.randomUUID(), sourceCache })
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

describe('compressed boot image cache', () => {
  it('streams exact decoded bytes in bounded batches, commits a digest, and reopens with its overlay', async () => {
    const progress: [number, string][] = []
    const meta = await importCompressedImage(
      input(),
      new AbortController().signal,
      (percent, phase) => progress.push([percent, phase]),
      async (source, sourceCache, fingerprint) => {
        expect(source.size).toBe(RAW_SIZE)
        expect(Buffer.from(await source.arrayBuffer()).equals(expected())).toBe(
          true,
        )
        expect(fingerprint).toBe(DIGEST)
        // An unpublished import must survive cleanup from another tab.
        await cleanImageCache()
        expect(files.has(sourceCache)).toBe(true)
        const meta: Volume = {
          id: crypto.randomUUID(),
          kind: 'boot',
          name: 'system.img',
          size: source.size,
          sourceCache,
          fingerprint,
          created: '',
          revision: 0,
          exportedRevision: -1,
        }
        const disk = await PersistentDisk.open(meta, source, true)
        await disk.write(65530, new Uint8Array(8192).fill(42))
        const updated = disk.meta
        await disk.close()
        return updated
      },
    )
    expect(created).toHaveLength(1)
    expect(created[0]!.writes).toEqual([1048576, 1048576, 512])
    expect(progress[0]).toEqual([0, 'Checking image'])
    expect(progress.at(-1)).toEqual([100, 'Image ready'])
    const saved = (await volumes())[0]!
    expect(saved.sourceCache).toBe(meta.sourceCache)
    const source = await cachedImage(saved.sourceCache!)
    const disk = await PersistentDisk.open(saved, source)
    try {
      expect(await disk.read(65530, 8192)).toEqual(
        new Uint8Array(8192).fill(42),
      )
      expect(await disk.read(RAW_SIZE - 512, 512)).toEqual(
        expected().slice(-512),
      )
      expect(Buffer.from(await source.arrayBuffer()).equals(expected())).toBe(
        true,
      )
    } finally {
      await disk.close()
    }
    await cleanImageCache()
    expect(files.has(saved.sourceCache!)).toBe(true)
  })

  it('checks available storage before creating a source or publishing metadata', async () => {
    quota = RAW_SIZE - 1
    const commit = vi.fn()
    await expect(
      importCompressedImage(
        input(),
        new AbortController().signal,
        () => {},
        commit,
      ),
    ).rejects.toThrow(/Not enough browser storage/)
    expect(created).toHaveLength(0)
    expect(commit).not.toHaveBeenCalled()
    expect(await volumes()).toEqual([])
  })

  it('rejects corrupt or truncated input and removes any incomplete source', async () => {
    const bytes = Buffer.from(COMPRESSED, 'base64')
    bytes[42]! ^= 1
    const commit = vi.fn()
    for (const file of [
      new File([bytes], 'corrupt.img.xz'),
      new File(
        [Buffer.from(COMPRESSED, 'base64').subarray(0, -7)],
        'truncated.img.xz',
      ),
    ]) {
      await expect(
        importCompressedImage(
          file,
          new AbortController().signal,
          () => {},
          commit,
        ),
      ).rejects.toThrow(/corrupt|invalid|incomplete|XZ|compressed/i)
      expect(files.size).toBe(0)
    }
    expect(commit).not.toHaveBeenCalled()
    expect(await volumes()).toEqual([])
  })

  it('cancels an in-progress import, aborts its writer, and publishes nothing', async () => {
    const controller = new AbortController(),
      commit = vi.fn()
    await expect(
      importCompressedImage(
        input(),
        controller.signal,
        (_percent, phase) => {
          if (phase === 'Preparing image') controller.abort()
        },
        commit,
      ),
    ).rejects.toThrow('Image import canceled.')
    expect(created).toHaveLength(1)
    expect(created[0]!.aborted).toBe(true)
    expect(files.size).toBe(0)
    expect(commit).not.toHaveBeenCalled()
    expect(await volumes()).toEqual([])
  })

  it('removes the prepared file if metadata cannot commit', async () => {
    await expect(
      importCompressedImage(
        input(),
        new AbortController().signal,
        () => {},
        async () => {
          throw new Error('Metadata transaction failed')
        },
      ),
    ).rejects.toThrow('Metadata transaction failed')
    expect(created[0]!.closed).toBe(true)
    expect(files.size).toBe(0)
    expect(await volumes()).toEqual([])
  })

  it('cleans up a real quota failure during writing', async () => {
    const commit = vi.fn()
    writeHook = () => {
      throw new DOMException('Full', 'QuotaExceededError')
    }
    await expect(
      importCompressedImage(
        input(),
        new AbortController().signal,
        () => {},
        commit,
      ),
    ).rejects.toThrow(/storage filled/)
    expect(created[0]!.aborted).toBe(true)
    expect(files.size).toBe(0)
    expect(commit).not.toHaveBeenCalled()
  })

  it('reclaims abandoned files while retaining saved, active, and unrelated files', async () => {
    const saved = key(),
      active = key(),
      orphan = key()
    for (const name of [saved, active, orphan, 'unrelated.txt'])
      files.set(name, {
        bytes: new Uint8Array(512),
        writes: [],
        aborted: false,
        closed: true,
      })
    await reference(saved)
    held.add(`cheap-kvm-image:${active}`)
    await cleanImageCache()
    expect([...files.keys()].sort()).toEqual(
      [saved, active, 'unrelated.txt'].sort(),
    )
    held.delete(`cheap-kvm-image:${active}`)
    await cleanImageCache()
    expect([...files.keys()].sort()).toEqual([saved, 'unrelated.txt'].sort())
    await expect(cachedImage('../outside.img')).rejects.toThrow(/Invalid/)
    await expect(cachedImage(orphan)).rejects.toThrow(
      /Select the original .img.xz/,
    )
  })
})
