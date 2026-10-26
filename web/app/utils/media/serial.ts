// SPDX-License-Identifier: GPL-3.0-or-later
import { checksum } from '../ch9329'
import { HEADER, MAX_IO } from './protocol'
const MAGIC = [0x4b, 0x56, 0x53, 0x31] // KVS1
const MAX_PACKET = HEADER + MAX_IO
export function serialMediaFrame(payload: Uint8Array) {
  if (
    payload.length > MAX_PACKET ||
    (payload.length && payload.length < HEADER)
  )
    throw new Error('Invalid USB media packet length')
  const out = new Uint8Array(6 + payload.length)
  out.set(MAGIC)
  out[4] = payload.length & 255
  out[5] = payload.length >>> 8
  out.set(payload, 6)
  return out
}

/** One bounded parser owns the UART stream. Never scan inside a valid packet. */
export class SerialDemux {
  private bytes: number[] = []
  private timer?: ReturnType<typeof setTimeout>
  constructor(
    private onControl: (packet: Uint8Array) => void,
    private onMedia: (packet: Uint8Array) => void,
  ) {}
  reset() {
    this.bytes = []
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
  feed(input: Uint8Array) {
    if (this.timer) clearTimeout(this.timer)
    for (const byte of input) {
      this.bytes.push(byte)
      this.parse()
    }
    // At 115200 baud a maximum packet takes < 0.75 s. Allow two seconds
    // without any bytes, then discard a truncated frame before accepting more.
    if (this.bytes.length) this.timer = setTimeout(() => this.reset(), 2000)
  }
  private parse() {
    const b = this.bytes
    while (b.length) {
      if (b[0] === 0x57) {
        if (b.length < 2) return
        if (b[1] === 0xab) {
          if (b.length < 5) return
          const size = b[4]!
          if (size <= 64) {
            const total = size + 6
            if (b.length < total) return
            if (checksum(b.slice(0, total - 1)) === b[total - 1]) {
              this.onControl(Uint8Array.from(b.splice(0, total)))
              continue
            }
          }
        }
      } else if (b[0] === MAGIC[0]) {
        let prefix = true
        for (let i = 1; i < Math.min(b.length, MAGIC.length); i++)
          if (b[i] !== MAGIC[i]) prefix = false
        if (prefix) {
          if (b.length < 6) return
          const size = b[4]! | (b[5]! << 8)
          if (size === 0 || (size >= HEADER && size <= MAX_PACKET)) {
            if (b.length < size + 6) return
            const packet = Uint8Array.from(b.splice(0, size + 6)).slice(6)
            this.onMedia(packet)
            continue
          }
        }
      }
      b.shift()
    }
  }
}
