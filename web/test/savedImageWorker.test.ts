// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { database, fingerprint, type Volume } from '../app/utils/media/disk'

type Reads = { bytes: number; calls: number }
class CountedFile extends File {
  constructor(
    bytes: Uint8Array,
    name: string,
    private reads: Reads,
  ) {
    super([bytes], name)
  }
  override async arrayBuffer() {
    this.reads.bytes += this.size
    this.reads.calls++
    return super.arrayBuffer()
  }
  override slice(start?: number, end?: number, type?: string) {
    const part = super.slice(start, end, type)
    const read = part.arrayBuffer.bind(part)
    part.arrayBuffer = async () => {
      this.reads.bytes += part.size
      this.reads.calls++
      return read()
    }
    return part
  }
}
type Cached = { bytes: Uint8Array; reads: Reads }
let files: Map<string, Cached>
let rpc: (method: string, args?: unknown) => Promise<any>
let messages: any[]

beforeEach(async () => {
  vi.resetModules()
  files = new Map()
  messages = []
  const held = new Set<string>()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('navigator', {
    locks: {
      async request(name: string, options: any, callback?: any) {
        const action = callback ?? options
        if (held.has(name)) return action(null)
        held.add(name)
        try {
          return await action({ name })
        } finally {
          held.delete(name)
        }
      },
    },
    storage: {
      async getDirectory() {
        return {
          async getDirectoryHandle() {
            return {
              async getFileHandle(name: string) {
                const cached = files.get(name)
                if (!cached) throw new DOMException('Missing', 'NotFoundError')
                return {
                  async getFile() {
                    // Each reopen obtains a new File snapshot, as real OPFS does.
                    return new CountedFile(cached.bytes, name, cached.reads)
                  },
                }
              },
            }
          },
        }
      },
    },
  })
  let id = 0
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >()
  const scope: any = {
    postMessage(message: any) {
      messages.push(message)
      if (!message.id) return
      const call = pending.get(message.id)!
      pending.delete(message.id)
      if (message.error) call.reject(new Error(message.error))
      else call.resolve(message.value)
    },
  }
  vi.stubGlobal('self', scope)
  await import('../app/workers/media.worker')
  rpc = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, { resolve, reject })
      scope.onmessage({ data: { id: n, method, args } })
    })
})
afterEach(async () => {
  await rpc('eject').catch(() => {})
  await rpc('close').catch(() => {})
  vi.unstubAllGlobals()
})

async function savedImage() {
  const bytes = new Uint8Array(2 * 1048576).fill(7)
  const reads = { bytes: 0, calls: 0 }
  const sourceCache = `${crypto.randomUUID()}.img`
  files.set(sourceCache, { bytes, reads })
  const meta: Volume = {
    id: crypto.randomUUID(),
    kind: 'boot',
    name: 'system.img',
    size: bytes.length,
    fingerprint: await fingerprint(new File([bytes], 'system.img')),
    sourceCache,
    created: '',
    revision: 5,
    exportedRevision: -1,
  }
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['volumes', 'pages'], 'readwrite')
      tx.objectStore('volumes').put(meta)
      tx.objectStore('pages').put(new Uint8Array(65536).fill(42), [meta.id, 0])
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
  return { meta, bytes, reads }
}

describe('saved image reopening', () => {
  it('opens the cached source without reading it and serves the saved overlay lazily', async () => {
    const { meta, reads } = await savedImage()
    expect(await rpc('open', { meta })).toEqual(meta)
    expect(reads).toEqual({ bytes: 0, calls: 0 })
    expect(messages.some((m) => m.phase === 'Verifying image')).toBe(false)

    await rpc('insert', { writable: false })
    expect(await rpc('read', { offset: 0, length: 512 })).toEqual(
      new Uint8Array(512).fill(42),
    )
    expect(reads.bytes).toBe(0)
    expect(await rpc('read', { offset: 65536, length: 512 })).toEqual(
      new Uint8Array(512).fill(7),
    )
    expect(reads).toEqual({ bytes: 65536, calls: 1 })

    await rpc('eject')
    await rpc('close')
    reads.bytes = reads.calls = 0
    expect(await rpc('open', { meta })).toEqual(meta)
    expect(reads).toEqual({ bytes: 0, calls: 0 })
  })

  it('rejects a missing or differently sized cache without scanning any data', async () => {
    const { meta, reads } = await savedImage()
    files.get(meta.sourceCache!)!.bytes = new Uint8Array(512)
    await expect(rpc('open', { meta })).rejects.toThrow(
      /size|matching|original/i,
    )
    expect(reads).toEqual({ bytes: 0, calls: 0 })
    files.delete(meta.sourceCache!)
    await expect(rpc('open', { meta })).rejects.toThrow(/missing/)
    expect(reads).toEqual({ bytes: 0, calls: 0 })
  })

  it('still hashes initial imports and rejects a different selected replacement', async () => {
    const reads = { bytes: 0, calls: 0 }
    const bytes = new Uint8Array(131072).fill(7)
    const file = new CountedFile(bytes, 'new.img', reads)
    const fresh = await rpc('open', { file })
    expect(fresh.fingerprint).toBe(
      await fingerprint(new File([bytes], 'new.img')),
    )
    expect(reads.bytes).toBe(bytes.length)

    const replacementReads = { bytes: 0, calls: 0 }
    const wrong = new CountedFile(
      new Uint8Array(bytes.length).fill(9),
      'new.img',
      replacementReads,
    )
    await expect(rpc('open', { meta: fresh, file: wrong })).rejects.toThrow(
      /original|matching/,
    )
    expect(replacementReads.bytes).toBe(bytes.length)
    expect((await rpc('meta')).id).toBe(fresh.id)
  })
})
