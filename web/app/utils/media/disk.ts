// SPDX-License-Identifier: GPL-3.0-or-later
import { sha256 } from '@noble/hashes/sha2.js'
import { checkRange } from './protocol'
export const PAGE_SIZE = 65536
export interface Disk {
  size: number
  read(offset: number, length: number): Promise<Uint8Array>
  write(offset: number, data: Uint8Array): Promise<void>
}
export interface Volume {
  id: string
  name: string
  size: number
  kind: 'boot' | 'fat32'
  fingerprint?: string
  /** Immutable decompressed source in this origin's private file storage. */
  sourceCache?: string
  needsCheck?: boolean
  revision: number
  exportedRevision: number
  created: string
}
function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () =>
      reject(tx.error ?? new Error('Storage transaction aborted'))
    tx.onerror = () => {}
  })
}
export async function database() {
  const req = indexedDB.open('cheap-kvm-media-v1', 1)
  req.onupgradeneeded = () => {
    req.result.createObjectStore('volumes', { keyPath: 'id' })
    req.result.createObjectStore('pages')
  }
  return result(req)
}
export async function volumes() {
  const db = await database()
  try {
    return (await result(
      db.transaction('volumes').objectStore('volumes').getAll(),
    )) as Volume[]
  } finally {
    db.close()
  }
}
const hashes = new WeakMap<File, Promise<string>>()
/** Only use with a digest computed over every byte while preparing this File. */
export function rememberFingerprint(file: File, digest: string) {
  hashes.set(file, Promise.resolve(digest))
}
export function fingerprint(file: File, progress?: (percent: number) => void) {
  let hash = hashes.get(file)
  if (!hash) {
    hash = hashFile(file, progress)
    hashes.set(file, hash)
    hash.catch(() => hashes.delete(file))
  }
  return hash
}
async function hashFile(file: File, progress?: (percent: number) => void) {
  if (
    !/\.(img|iso)$/i.test(file.name) ||
    file.size < 512 ||
    file.size % 512 ||
    file.size / 512 > 0xffffffff
  )
    throw new Error(
      'Select a sector-aligned .img or USB-bootable hybrid .iso (512-byte sectors, below 2 TiB).',
    )
  const hash = sha256.create()
  for (let offset = 0; offset < file.size; offset += 4 * 1048576) {
    hash.update(
      new Uint8Array(
        await file.slice(offset, offset + 4 * 1048576).arrayBuffer(),
      ),
    )
    progress?.(
      Math.round(Math.min(1, (offset + 4 * 1048576) / file.size) * 100),
    )
  }
  return Array.from(hash.digest(), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  )
}
/** A sparse, persistent copy-on-write disk. The selected File is never written.
 * Callers serialize operations (the media worker does so), including export.
 * Strict IDB transactions commit all affected pages and revision atomically.
 */
export class PersistentDisk implements Disk {
  readonly size: number
  private cache = new Map<number, Uint8Array>()
  private release!: () => void
  private lockDone!: Promise<void>
  private constructor(
    public meta: Volume,
    private db: IDBDatabase,
    private source?: File,
  ) {
    this.size = meta.size
  }
  static async open(meta: Volume, source?: File, create = false) {
    if (!navigator.locks)
      throw new Error(
        'This browser needs Web Locks for exclusive disk ownership. Use a current browser in a secure context.',
      )
    if (
      meta.kind === 'boot' &&
      (!source || (await fingerprint(source)) !== meta.fingerprint)
    )
      throw new Error(
        'Reselect the original image matching this saved overlay.',
      )
    const db = await database(),
      disk = new PersistentDisk(meta, db, source)
    let acquired!: () => void, rejected!: (e: unknown) => void
    const ready = new Promise<void>((res, rej) => {
      acquired = res
      rejected = rej
    })
    disk.lockDone = navigator.locks
      .request(
        `cheap-kvm-disk:${meta.id}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            rejected(
              new Error(
                'This disk is already open in another tab. Close it there first.',
              ),
            )
            return
          }
          await new Promise<void>((resolve) => {
            disk.release = resolve
            acquired()
          })
        },
      )
      .then(
        () => {},
        (e) => {
          rejected(e)
        },
      )
    try {
      await ready
    } catch (e) {
      db.close()
      throw e
    }
    try {
      if (create) {
        const tx = disk.transaction(['volumes']),
          done = complete(tx)
        tx.objectStore('volumes').add(meta)
        await done
      } else {
        const saved = (await result(
          db.transaction('volumes').objectStore('volumes').get(meta.id),
        )) as Volume | undefined
        if (!saved) throw new Error('Saved disk is missing')
        disk.meta = saved
      }
    } catch (e) {
      await disk.close()
      throw e
    }
    return disk
  }
  private transaction(stores: string[]) {
    const tx = this.db.transaction(stores, 'readwrite', {
      durability: 'strict',
    })
    if (tx.durability !== 'strict') {
      tx.abort()
      throw new Error(
        'This browser cannot promise strict write durability. Use read-only media or a current browser.',
      )
    }
    return tx
  }
  private async page(index: number) {
    let page = this.cache.get(index)
    if (page) {
      this.cache.delete(index)
      this.cache.set(index, page)
      return page
    }
    const stored = (await result(
      this.db
        .transaction('pages')
        .objectStore('pages')
        .get([this.meta.id, index]),
    )) as Uint8Array | undefined
    page = new Uint8Array(PAGE_SIZE)
    if (stored) page.set(stored)
    else if (this.source)
      page.set(
        new Uint8Array(
          await this.source
            .slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE)
            .arrayBuffer(),
        ),
      )
    this.cache.set(index, page)
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!)
    return page
  }
  async read(offset: number, length: number) {
    checkRange(this.size, offset, length)
    const out = new Uint8Array(length)
    for (let n = 0; n < length;) {
      const at = offset + n,
        p = await this.page(Math.floor(at / PAGE_SIZE)),
        within = at % PAGE_SIZE
      const count = Math.min(length - n, PAGE_SIZE - within)
      out.set(p.subarray(within, within + count), n)
      n += count
    }
    return out
  }
  async write(offset: number, data: Uint8Array) {
    checkRange(this.size, offset, data.length)
    const updates: [number, Uint8Array][] = []
    for (let n = 0; n < data.length;) {
      const at = offset + n,
        index = Math.floor(at / PAGE_SIZE),
        within = at % PAGE_SIZE
      const p = (await this.page(index)).slice(),
        count = Math.min(data.length - n, PAGE_SIZE - within)
      p.set(data.subarray(n, n + count), within)
      updates.push([index, p])
      n += count
    }
    const meta = { ...this.meta, revision: this.meta.revision + 1 }
    const tx = this.transaction(['pages', 'volumes']),
      done = complete(tx)
    for (const [index, page] of updates)
      tx.objectStore('pages').put(page, [meta.id, index])
    tx.objectStore('volumes').put(meta)
    await done
    this.meta = meta
    // On failure cache and meta remain at the last committed revision.
    for (const [index, page] of updates) this.cache.set(index, page)
    while (this.cache.size > 8)
      this.cache.delete(this.cache.keys().next().value!)
  }
  async setNeedsCheck(needsCheck: boolean) {
    const meta = { ...this.meta, needsCheck }
    const tx = this.transaction(['volumes']),
      done = complete(tx)
    tx.objectStore('volumes').put(meta)
    await done
    this.meta = meta
  }
  async markExported() {
    const meta = { ...this.meta, exportedRevision: this.meta.revision }
    const tx = this.transaction(['volumes']),
      done = complete(tx)
    tx.objectStore('volumes').put(meta)
    await done
    this.meta = meta
  }
  async setSourceCache(sourceCache?: string) {
    const meta = { ...this.meta, sourceCache }
    const tx = this.transaction(['volumes']),
      done = complete(tx)
    tx.objectStore('volumes').put(meta)
    await done
    this.meta = meta
  }
  async close() {
    this.release()
    await this.lockDone
    this.db.close()
  }
}
