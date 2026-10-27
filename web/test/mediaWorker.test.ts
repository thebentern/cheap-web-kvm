// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest'
import { indexedDB } from 'fake-indexeddb'
import { FatVolume } from '../app/utils/media/fat'
describe('media storage worker ownership', () => {
  it('keeps metadata current, excludes client edits while inserted, and retrieves target-created files after ejection', async () => {
    const waiting = new Map<
      number,
      { resolve: (v: any) => void; reject: (e: Error) => void }
    >()
    let id = 0
    let failNextTransfer = false
    const transferred: { source: ArrayBuffer; exactRange: boolean }[] = []
    const scope: any = {
      postMessage(m: any, transfer: Transferable[] = []) {
        if (!m.id) return
        if (failNextTransfer && transfer.length) {
          failNextTransfer = false
          throw new DOMException('Synthetic transfer rejection', 'DataCloneError')
        }
        const source = m.value instanceof Uint8Array ? m.value.buffer : null
        if (source)
          transferred.push({
            source,
            exactRange:
              m.value.byteOffset === 0 &&
              m.value.byteLength === source.byteLength &&
              transfer.length === 1 &&
              transfer[0] === source,
          })
        // Model real worker ownership transfer, including sender detachment.
        const delivered = structuredClone(m, { transfer })
        const p = waiting.get(m.id)!
        waiting.delete(m.id)
        if (delivered.error) p.reject(new Error(delivered.error))
        else p.resolve(delivered.value)
      },
    }
    vi.stubGlobal('indexedDB', indexedDB)
    vi.stubGlobal('self', scope)
    vi.stubGlobal('navigator', {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          fn: (lock: object) => unknown,
        ) => fn({}),
      },
    })
    await import('../app/workers/media.worker')
    const rpc = (method: string, args: any = {}): Promise<any> =>
      new Promise((resolve, reject) => {
        const n = ++id
        waiting.set(n, { resolve, reject })
        scope.onmessage({ data: { id: n, method, args } })
      })
    try {
      const meta = await rpc('open', {
        size: 64 * 1048576,
        label: 'WORKER',
        persistent: true,
      })
      expect(meta.needsCheck).toBe(false)
      await expect(
        rpc('open', { file: new File(['broken'], 'broken.img.xz') }),
      ).rejects.toThrow()
      expect((await rpc('meta')).id).toBe(meta.id)
      const edited = await rpc('add', { path: [], name: 'Client folder' })
      expect(edited.needsCheck).toBe(false)
      expect((await rpc('list', { path: [] }))[0].name).toBe('Client folder')
      await rpc('insert', { writable: true })
      await expect(rpc('list', { path: [] })).rejects.toThrow(/Eject/)
      await expect(rpc('add', { path: [], name: 'Forbidden' })).rejects.toThrow(
        /Eject/,
      )
      // Independent FAT reader/writer acts like the target's filesystem stack.
      const bridge = {
        size: meta.size,
        read: (offset: number, length: number) =>
          rpc('read', { offset, length }),
        write: async (offset: number, data: Uint8Array) => {
          await rpc('write', { offset, data })
        },
      }
      const target = await FatVolume.open(bridge)
      await target.add(
        target.root,
        'Target-created.txt',
        new Blob(['hello from target\n']),
      )
      await rpc('eject')
      expect((await rpc('list', { path: [] })).map((e: any) => e.name)).toEqual(
        ['Client folder', 'Target-created.txt'],
      )
      expect(
        (await rpc('preview', { path: [], name: 'Target-created.txt' })).text,
      ).toBe('hello from target\n')
      await rpc('close')
      const restored = await rpc('open', { meta, persistent: true })
      expect(restored.revision).toBeGreaterThan(meta.revision)
      expect(
        (await rpc('preview', { path: [], name: 'Target-created.txt' })).text,
      ).toBe('hello from target\n')
      await rpc('insert', { writable: false })
      await expect(
        rpc('write', { offset: 0, data: new Uint8Array([1]) }),
      ).rejects.toThrow(/read-only/)
      const first = await rpc('read', { offset: 0, length: 512 }),
        expected = first.slice()
      expect(expected.some((byte: number) => byte !== 0)).toBe(true)
      first.fill(0) // Main-thread mutation must not change the worker's page cache.
      expect(await rpc('read', { offset: 0, length: 512 })).toEqual(expected)
      failNextTransfer = true
      await expect(rpc('read', { offset: 0, length: 512 })).rejects.toThrow(
        /Synthetic transfer rejection/,
      )
      expect(waiting.size).toBe(0)
      expect(await rpc('read', { offset: 0, length: 512 })).toEqual(expected)
      expect(transferred.length).toBeGreaterThan(2)
      expect(transferred.every(({ exactRange }) => exactRange)).toBe(true)
      expect(transferred.every(({ source }) => source.byteLength === 0)).toBe(true)
      await rpc('eject')
      await rpc('close')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
