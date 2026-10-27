// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference lib="webworker" />
import {
  PersistentDisk,
  fingerprint,
  volumes,
  type Volume,
} from '../utils/media/disk'
import {
  FatVolume,
  formatFat32,
  inspectBoot,
  validateFat32,
} from '../utils/media/fat'
import {
  cachedImage,
  cleanImageCache,
  importCompressedImage,
  removeCachedImage,
} from '../utils/media/imageCache'
let disk: PersistentDisk | null = null
let inserted = false,
  writable = false,
  persistent = false
let queue = Promise.resolve()
let importing: AbortController | null = null
const metadata = () => disk?.meta ?? null
async function requireDisk(edit = false) {
  if (!disk) throw new Error('Open a disk first')
  if (inserted)
    throw new Error(
      'Eject and synchronize the target before browsing, editing or exporting',
    )
  if (edit && disk.meta.needsCheck)
    throw new Error(
      'An interrupted client edit needs filesystem repair. Export the image and run fsck before importing it again.',
    )
  return disk
}
async function filesystem() {
  return FatVolume.open(await requireDisk(true))
}
async function mutate(fn: () => Promise<unknown>) {
  const d = await requireDisk(true)
  await d.setNeedsCheck(true)
  await fn()
  await d.setNeedsCheck(false)
  return metadata()
}
async function output(
  name: string,
  size: number,
  read: (offset: number, length: number) => Promise<Uint8Array>,
  handle?: FileSystemFileHandle,
) {
  let file: FileSystemFileHandle
  if (handle) file = handle
  else {
    const root = await navigator.storage.getDirectory(),
      dir = await root.getDirectoryHandle('cheap-kvm-exports', {
        create: true,
      })
    file = await dir.getFileHandle(
      `${crypto.randomUUID()}-${name.replace(/[\\/]/g, '_')}`,
      { create: true },
    )
    const estimate = await navigator.storage.estimate()
    if (estimate.quota && size > estimate.quota - (estimate.usage ?? 0))
      throw new Error(
        'Insufficient browser storage for export. Use a browser with Save File support, or free storage outside this app.',
      )
  }
  const stream = await file.createWritable()
  try {
    for (let offset = 0; offset < size; offset += 1048576) {
      const n = Math.min(1048576, size - offset)
      await stream.write(new Uint8Array(await read(offset, n)))
      self.postMessage({
        progress: Math.round(((offset + n) / Math.max(size, 1)) * 100),
      })
    }
    await stream.close()
  } catch (e) {
    await stream.abort().catch(() => {})
    throw e
  }
  return handle ? null : await file.getFile()
}
async function call(method: string, a: any) {
  switch (method) {
    case 'persistence':
      persistent = !!a.persistent
      return persistent
    case 'saved':
      await cleanImageCache().catch(() => {}) // Optional orphan cleanup must not block raw media.
      return volumes()
    case 'open': {
      if (!a.file && !a.meta) validateFat32(a.size, a.label)
      if (disk) await requireDisk()
      // An immutable source already saved in OPFS does not need another full
      // scan. Freshly selected files still establish/confirm their identity.
      const savedSource = !!(a.meta?.sourceCache && !a.file)
      const activate = async (source?: File, key?: string, digest?: string) => {
        const hash =
          source && !savedSource
            ? (digest ??
              (await fingerprint(source, (progress) =>
                self.postMessage({ progress, phase: 'Verifying image' }),
              )))
            : undefined
        if (
          a.meta?.kind === 'boot' &&
          (source?.size !== a.meta.size ||
            (!savedSource && hash !== a.meta.fingerprint))
        )
          throw new Error(
            'Select the original image matching this saved overlay.',
          )
        const meta: Volume = a.meta ?? {
          id: crypto.randomUUID(),
          kind: source ? 'boot' : 'fat32',
          name: a.file?.name.replace(/\.xz$/i, '') ?? a.label,
          size: source?.size ?? a.size,
          fingerprint: hash,
          sourceCache: key,
          created: new Date().toISOString(),
          revision: 0,
          exportedRevision: -1,
        }
        if (importing?.signal.aborted) throw new Error('Image import canceled.')
        const previous = disk,
          oldKey = a.meta?.sourceCache
        // Reopening the same disk must release our own exclusive ownership.
        if (previous?.meta.id === meta.id) {
          await previous.close()
          disk = null
        }
        const opened = await PersistentDisk.open(
          meta,
          source,
          !a.meta,
          !savedSource,
        )
        try {
          if (a.meta && (key || (a.file && oldKey)))
            await opened.setSourceCache(key)
        } catch (error) {
          await opened.close()
          throw error
        }
        if (previous && previous === disk) await previous.close()
        disk = opened
        if (a.file && oldKey && key !== oldKey) await removeCachedImage(oldKey)
        if (!source && !a.meta) await mutate(() => formatFat32(disk!, a.label))
        persistent = !!a.persistent
        return metadata()
      }
      if (a.file && /\.img\.xz$/i.test(a.file.name)) {
        importing = new AbortController()
        try {
          return await importCompressedImage(
            a.file,
            importing.signal,
            (progress, phase) => self.postMessage({ progress, phase }),
            activate,
          )
        } finally {
          importing = null
        }
      }
      let source = a.file
      if (savedSource) {
        self.postMessage({ progress: 0, phase: 'Opening saved image' })
        source = await cachedImage(a.meta.sourceCache)
      }
      return activate(source)
    }
    case 'close':
      await requireDisk()
      await disk!.close()
      disk = null
      return null
    case 'inspect':
      return inspectBoot(await requireDisk())
    case 'list': {
      const f = await filesystem()
      return f.list(await f.find(a.path))
    }
    case 'add':
      return mutate(async () => {
        const f = await FatVolume.open(disk!)
        await f.add(await f.find(a.path), a.name, a.file)
        return metadata()
      })
    case 'remove':
      return mutate(async () => {
        const f = await FatVolume.open(disk!)
        const parent = await f.find(a.path),
          entry = (await f.list(parent)).find((e) => e.name === a.name)
        if (!entry) throw new Error('File no longer exists')
        await f.remove(entry)
        return metadata()
      })
    case 'preview': {
      const f = await filesystem(),
        entry = (await f.list(await f.find(a.path))).find(
          (e) => e.name === a.name,
        )
      if (!entry || entry.directory) throw new Error('Choose an ordinary file')
      const data = await f.readFile(entry, 0, Math.min(entry.size, 65536))
      return {
        text: new TextDecoder().decode(data),
        truncated: entry.size > data.length,
      }
    }
    case 'download': {
      const f = await filesystem(),
        entry = (await f.list(await f.find(a.path))).find(
          (e) => e.name === a.name,
        )
      if (!entry || entry.directory) throw new Error('Choose an ordinary file')
      return output(
        entry.name,
        entry.size,
        (o, n) => f.readFile(entry, o, n),
        a.handle,
      )
    }
    case 'export': {
      const d = await requireDisk(),
        file = await output(
          `${d.meta.name.replace(/\.(img|iso)$/i, '')}-updated.img`,
          d.size,
          (o, n) => d.read(o, n),
          a.handle,
        )
      // A downloadable export is not yet confirmed saved by the user.
      if (a.handle) await d.markExported()
      return { file, meta: metadata() }
    }
    case 'markExported':
      await requireDisk()
      await disk!.markExported()
      return metadata()
    case 'insert':
      await requireDisk(true)
      if (a.writable && !persistent)
        throw new Error(
          'Writable media needs persistent browser storage permission. Keep read-only mode or grant storage permission.',
        )
      inserted = true
      writable = !!a.writable
      return metadata()
    case 'eject':
      inserted = false
      writable = false
      return metadata() // FIFO queue is the flush barrier
    case 'read':
      if (!disk || !inserted) throw new Error('Media is ejected')
      return disk.read(a.offset, a.length)
    case 'write':
      if (!disk || !inserted || !writable)
        throw new Error('Media is read-only or ejected')
      await disk.write(a.offset, a.data)
      return metadata()
    case 'meta':
      return metadata()
    default:
      throw new Error('Unknown storage operation')
  }
}
self.onmessage = (e) => {
  const { id, method, args } = e.data
  if (method === 'cancelImport') {
    importing?.abort()
    return
  }
  queue = queue.then(async () => {
    try {
      const value = await call(method, args ?? {})
      // Disk.read returns a fresh exact-length buffer, never a cached page.
      // Transfer its ownership instead of copying every block to the main thread.
      self.postMessage(
        { id, value },
        method === 'read' && value instanceof Uint8Array
          ? [value.buffer as ArrayBuffer]
          : [],
      )
    } catch (e) {
      self.postMessage({ id, error: (e as Error).message, meta: metadata() })
    }
  })
}
