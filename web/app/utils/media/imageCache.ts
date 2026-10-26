// SPDX-License-Identifier: GPL-3.0-or-later
import { sha256 } from '@noble/hashes/sha2.js'
import { rememberFingerprint, volumes } from './disk'
import { decodeXz, inspectXz } from './xz'

const DIRECTORY = 'cheap-kvm-images'
const CHUNK_SIZE = 1048576
const validKey = (key: string) => /^[0-9a-f-]{36}\.img$/.test(key)
const lockName = (key: string) => `cheap-kvm-image:${key}`
const canceled = () => new Error('Image import canceled.')
async function directory() {
  if (!navigator.storage?.getDirectory)
    throw new Error(
      'This browser needs private file storage to prepare compressed images. Use a current browser in a secure context.',
    )
  return (await navigator.storage.getDirectory()).getDirectoryHandle(
    DIRECTORY,
    { create: true },
  )
}
export async function cachedImage(key: string) {
  if (!validKey(key)) throw new Error('Invalid cached image reference')
  try {
    return await (await (await directory()).getFileHandle(key)).getFile()
  } catch {
    throw new Error(
      'The prepared image is missing from browser storage. Select the original .img.xz again to restore it.',
    )
  }
}
export async function removeCachedImage(key: string) {
  if (!validKey(key)) return
  await directory()
    .then((dir) => dir.removeEntry(key))
    .catch(() => {})
}
/** Reclaim imports interrupted by a closed tab. Active imports hold a lock until
 * their volume metadata commits, so another tab cannot delete their source. */
export async function cleanImageCache() {
  if (!navigator.storage?.getDirectory || !navigator.locks) return
  const dir = await directory()
  for await (const [key] of dir as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    if (!validKey(key)) continue
    await navigator.locks.request(
      lockName(key),
      { ifAvailable: true },
      async (lock) => {
        // Fetch references after acquiring the lock: an import could have just
        // committed since this cleanup began in another tab.
        if (lock && !(await volumes()).some((v) => v.sourceCache === key))
          await dir.removeEntry(key).catch(() => {})
      },
    )
  }
}
/** Stream into a private immutable source, then publish metadata through commit.
 * Only a 1 MiB batch plus the decoder's bounded dictionary stays in memory. */
export async function importCompressedImage<T>(
  file: File,
  signal: AbortSignal,
  progress: (percent: number, phase: string) => void,
  commit: (source: File, key: string, digest: string) => Promise<T>,
): Promise<T> {
  if (!/\.img\.xz$/i.test(file.name))
    throw new Error('Select an .img.xz disk image')
  if (!navigator.locks)
    throw new Error(
      'This browser needs Web Locks to prepare compressed images.',
    )
  progress(0, 'Checking image')
  const { size } = await inspectXz(file)
  if (signal.aborted) throw canceled()
  const estimate = await navigator.storage.estimate()
  if (estimate.quota && size > estimate.quota - (estimate.usage ?? 0))
    throw new Error(
      `Not enough browser storage to prepare this image. It needs ${(size / 1073741824).toFixed(2)} GiB. Free some space and try again.`,
    )
  const dir = await directory(),
    key = `${crypto.randomUUID()}.img`
  return navigator.locks.request(lockName(key), async () => {
    let stream: FileSystemWritableFileStream | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let committed = false
    try {
      if (signal.aborted) throw canceled()
      const handle = await dir.getFileHandle(key, { create: true })
      stream = await handle.createWritable()
      const hash = sha256.create(),
        batch = new Uint8Array(CHUNK_SIZE)
      let buffered = 0,
        written = 0,
        lastProgress = -1
      reader = decodeXz(file, signal).getReader()
      let next = reader.read()
      while (true) {
        const { value, done } = await next
        if (signal.aborted) throw canceled()
        if (done) break
        if (written + buffered + value.length > size)
          throw new Error('The decompressed image does not match its XZ index.')
        hash.update(value)
        for (let at = 0; at < value.length;) {
          const n = Math.min(batch.length - buffered, value.length - at)
          batch.set(value.subarray(at, at + n), buffered)
          buffered += n
          at += n
          if (buffered === batch.length) {
            await stream.write(batch)
            written += buffered
            buffered = 0
          }
        }
        const percent = Math.min(
          99,
          Math.floor(((written + buffered) / size) * 100),
        )
        if (percent !== lastProgress) {
          progress(percent, 'Preparing image')
          lastProgress = percent
        }
        next = reader.read()
      }
      if (written + buffered !== size)
        throw new Error(
          'The compressed image is incomplete. Select a complete .img.xz file.',
        )
      if (buffered) await stream.write(batch.slice(0, buffered))
      await stream.close()
      stream = undefined
      if (signal.aborted) throw canceled()
      const source = await handle.getFile(),
        digest = Array.from(hash.digest(), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('')
      rememberFingerprint(source, digest)
      const result = await commit(source, key, digest)
      committed = true
      progress(100, 'Image ready')
      return result
    } catch (error) {
      if (signal.aborted) throw canceled()
      if ((error as Error).name === 'QuotaExceededError')
        throw new Error(
          'Browser storage filled while preparing the image. Free some space and try again.',
        )
      throw error
    } finally {
      await reader?.cancel().catch(() => {})
      reader?.releaseLock()
      await stream?.abort().catch(() => {})
      if (!committed) await dir.removeEntry(key).catch(() => {})
    }
  })
}
