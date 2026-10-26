// SPDX-License-Identifier: GPL-3.0-or-later
export const HEADER = 32
export const MAX_IO = 8192
export const OP = {
  HELLO: 1,
  INSERT: 2,
  EJECT: 3,
  ECHO: 4,
  HEARTBEAT: 5,
  STATUS: 6,
  HID: 7,
  BOOT: 8,
  CANCEL: 9,
  READ: 16,
  WRITE: 17,
} as const
export const FLAG = {
  WRITABLE: 1,
  LOCAL: 2,
  PRESENT: 4,
  FAILED: 8,
  PREVENTED: 16,
  MACRO: 32,
} as const
export interface Message {
  op: number
  flags: number
  session: number
  id: number
  offset: number
  length: number
  data: Uint8Array
}
export function crc32(parts: Uint8Array[]) {
  let crc = 0xffffffff
  for (const part of parts)
    for (const b of part) {
      crc ^= b
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  return (crc ^ 0xffffffff) >>> 0
}
export function encode(m: Omit<Message, 'data'> & { data?: Uint8Array }) {
  const data = m.data ?? new Uint8Array()
  if (
    !Number.isSafeInteger(m.offset) ||
    m.offset < 0 ||
    !m.id ||
    m.length > MAX_IO ||
    m.length < 0 ||
    data.length > MAX_IO
  )
    throw new Error('Invalid media frame')
  const out = new Uint8Array(HEADER + data.length),
    v = new DataView(out.buffer)
  out.set([75, 86, 77, 49, 1, m.op])
  v.setUint16(6, m.flags, true)
  v.setUint32(8, m.session, true)
  v.setUint32(12, m.id, true)
  v.setBigUint64(16, BigInt(m.offset), true)
  v.setUint32(24, m.length, true)
  out.set(data, HEADER)
  v.setUint32(28, crc32([out.subarray(0, 28), data]), true)
  return out
}
export function decode(input: ArrayBuffer | Uint8Array): Message {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (
    b.length < HEADER ||
    b.length > HEADER + MAX_IO ||
    b[0] !== 75 ||
    b[1] !== 86 ||
    b[2] !== 77 ||
    b[3] !== 49 ||
    b[4] !== 1
  )
    throw new Error('Unsupported or truncated media frame')
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength),
    rawOffset = v.getBigUint64(16, true)
  if (crc32([b.subarray(0, 28), b.subarray(32)]) !== v.getUint32(28, true))
    throw new Error('Media integrity check failed')
  if (
    rawOffset > BigInt(Number.MAX_SAFE_INTEGER) ||
    !v.getUint32(12, true) ||
    v.getUint32(24, true) > MAX_IO
  )
    throw new Error('Invalid media bounds')
  return {
    op: b[5]!,
    flags: v.getUint16(6, true),
    session: v.getUint32(8, true),
    id: v.getUint32(12, true),
    offset: Number(rawOffset),
    length: v.getUint32(24, true),
    data: b.slice(32),
  }
}
export function checkRange(size: number, offset: number, length: number) {
  if (
    ![size, offset, length].every(Number.isSafeInteger) ||
    offset < 0 ||
    length <= 0 ||
    offset > size ||
    length > size - offset
  )
    throw new Error('Disk request outside image bounds')
}
