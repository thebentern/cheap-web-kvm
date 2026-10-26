// SPDX-License-Identifier: GPL-3.0-or-later
import { XzReadableStream } from 'xz-decompress'
import { crc32 } from './protocol'

const MAX_IMAGE_SIZE = 0xffffffff * 512
const MAX_INDEX_SIZE = 16 * 1048576
const MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]

function invalid() {
  return new Error(
    'This XZ image is damaged or incomplete. Select a complete .img.xz file.',
  )
}

function flags(bytes: Uint8Array) {
  if (bytes[0] !== 0 || (bytes[1] !== 1 && bytes[1] !== 4))
    throw new Error(
      'This XZ image uses an unsupported integrity check. CRC32 and CRC64 are supported.',
    )
}

function uint32(bytes: Uint8Array, offset = 0) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true)
}

async function read(file: Blob, offset: number, length: number) {
  if (offset < 0 || offset + length > file.size) throw invalid()
  const bytes = new Uint8Array(
    await file.slice(offset, offset + length).arrayBuffer(),
  )
  if (bytes.length !== length) throw invalid()
  return bytes
}

// An XZ Index contains 63-bit variable integers. Keep every intermediate exact;
// the disk protocol has a much smaller limit, but offsets must also be safe.
function variable(bytes: Uint8Array, cursor: { offset: number }, end: number) {
  let value = 0
  let multiplier = 1
  for (let i = 0; i < 9; i++) {
    if (cursor.offset >= end) throw invalid()
    const byte = bytes[cursor.offset++]!
    const digit = byte & 0x7f
    if (digit > Math.floor((Number.MAX_SAFE_INTEGER - value) / multiplier))
      throw invalid()
    value += digit * multiplier
    if (!(byte & 0x80)) {
      if (i && byte === 0) throw invalid()
      return value
    }
    multiplier *= 128
  }
  throw invalid()
}

/** Read validated XZ indexes without loading or decompressing the image. */
export async function inspectXz(file: Blob): Promise<{ size: number }> {
  if (!Number.isSafeInteger(file.size) || file.size < 32 || file.size % 4)
    throw invalid()
  let end = file.size
  let size = 0
  let streams = 0
  while (end) {
    if (++streams > 65536)
      throw new Error('This XZ image contains too many streams.')
    // Stream padding is zero-filled and must be a multiple of four bytes.
    const beforePadding = end
    while (end) {
      const chunk = await read(
        file,
        Math.max(0, end - 65536),
        Math.min(end, 65536),
      )
      let i = chunk.length - 1
      while (i >= 0 && chunk[i] === 0) i--
      end -= chunk.length - 1 - i
      if (i >= 0) break
    }
    if ((beforePadding - end) % 4 || end < 32) throw invalid()
    const footer = await read(file, end - 12, 12)
    if (
      footer[10] !== 0x59 ||
      footer[11] !== 0x5a ||
      crc32([footer.subarray(4, 10)]) !== uint32(footer)
    )
      throw invalid()
    flags(footer.subarray(8, 10))
    const indexSize = (uint32(footer, 4) + 1) * 4
    if (indexSize > MAX_INDEX_SIZE)
      throw new Error('This XZ image has an index larger than 16 MiB.')
    const indexOffset = end - 12 - indexSize
    const index = await read(file, indexOffset, indexSize)
    const dataEnd = index.length - 4
    if (
      dataEnd < 4 ||
      index[0] !== 0 ||
      crc32([index.subarray(0, dataEnd)]) !== uint32(index, dataEnd)
    )
      throw invalid()
    const cursor = { offset: 1 }
    const records = variable(index, cursor, dataEnd)
    if (records > Math.floor((dataEnd - cursor.offset) / 2)) throw invalid()
    let blockSize = 0
    for (let i = 0; i < records; i++) {
      const unpadded = variable(index, cursor, dataEnd)
      const unpacked = variable(index, cursor, dataEnd)
      if (
        unpadded < 5 ||
        !Number.isSafeInteger(blockSize + Math.ceil(unpadded / 4) * 4)
      )
        throw invalid()
      blockSize += Math.ceil(unpadded / 4) * 4
      size += unpacked
      if (!Number.isSafeInteger(size) || size > MAX_IMAGE_SIZE)
        throw new Error('The expanded image exceeds the 2 TiB disk limit.')
    }
    if (
      dataEnd - cursor.offset > 3 ||
      index.subarray(cursor.offset, dataEnd).some((b) => b !== 0)
    )
      throw invalid()
    const headerOffset = indexOffset - blockSize - 12
    const header = await read(file, headerOffset, 12)
    if (
      MAGIC.some((b, i) => header[i] !== b) ||
      crc32([header.subarray(6, 8)]) !== uint32(header, 8) ||
      header[6] !== footer[8] ||
      header[7] !== footer[9]
    )
      throw invalid()
    end = headerOffset
  }
  if (size < 512 || size % 512)
    throw new Error(
      'The expanded image must contain complete 512-byte disk sectors.',
    )
  return { size }
}

function decodeError(error: unknown) {
  const code = /error code (\d+)/.exec(
    error instanceof Error ? error.message : '',
  )?.[1]
  if (code === '4')
    return new Error(
      'This XZ image needs a compression dictionary larger than 64 MiB.',
    )
  if (code === '6' || code === '2')
    return new Error(
      'This XZ image uses an unsupported compression filter or integrity check.',
    )
  return invalid()
}

/** Stream bounded chunks; cancellation lets the decoder clean up through its error path. */
export function decodeXz(
  file: Blob,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let input: ReadableStreamDefaultController<Uint8Array> | undefined
  let decoder: ReadableStreamDefaultReader<Uint8Array> | undefined
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  let cleanup: Promise<void> | undefined
  let stopped = false
  let reason: unknown
  let complete = false
  let output: ReadableStreamDefaultController<Uint8Array> | undefined

  const stop = (cause: unknown) => {
    if (!stopped) {
      stopped = true
      reason =
        cause ?? new DOMException('Image preparation canceled.', 'AbortError')
      try {
        input?.error(reason)
      } catch {
        /* Already closed or errored. */
      }
    }
    // The package's cancel() can dispose while its asynchronous pull is pending.
    // Error its input instead, then drain only its buffered input until it exits.
    return (cleanup ??= (async () => {
      try {
        await pending?.catch(() => {})
        if (decoder && !complete)
          while (!(await decoder.read()).done) {
            /* Discard buffered output. */
          }
      } catch {
        /* Decoder errors release its WASM context and mutex. */
      } finally {
        decoder?.releaseLock()
        signal?.removeEventListener('abort', abort)
      }
    })())
  }
  const abort = () => {
    void stop(signal?.reason)
    output?.error(reason)
  }
  signal?.addEventListener('abort', abort, { once: true })

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        output = controller
        if (signal?.aborted) abort()
      },
      async pull(controller) {
        if (stopped) return
        if (!decoder) {
          let offset = 0
          const compressed = new ReadableStream<Uint8Array>(
            {
              start(controller) {
                input = controller
              },
              async pull(controller) {
                if (stopped) return
                if (offset === file.size) return controller.close()
                const bytes = await read(
                  file,
                  offset,
                  Math.min(65536, file.size - offset),
                )
                if (stopped) return
                offset += bytes.length
                controller.enqueue(bytes)
              },
            },
            { highWaterMark: 0 },
          )
          decoder = new XzReadableStream(compressed).getReader()
        }
        try {
          pending = decoder.read()
          const next = await pending
          if (stopped) return
          if (next.done) {
            complete = true
            decoder.releaseLock()
            signal?.removeEventListener('abort', abort)
            controller.close()
          } else controller.enqueue(next.value)
        } catch (error) {
          await stop(error)
          controller.error(decodeError(error))
        } finally {
          pending = undefined
        }
      },
      cancel(cause) {
        return stop(cause)
      },
    },
    { highWaterMark: 0 },
  )
}
