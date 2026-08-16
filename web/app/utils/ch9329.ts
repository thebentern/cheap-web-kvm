/**
 * CH9329 wire protocol — pure functions, no DOM, no browser APIs.
 *
 * This is the layer the ESP32-S3 firmware was written against and it has been
 * verified byte for byte on real hardware. Frame layouts, the 0..4095 absolute
 * range, the 0x80 avoidance in relative mode and the reply framing must not
 * drift. See docs/PROTOCOL.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const HDR0 = 0x57
export const HDR1 = 0xab

export const CMD = {
  GET_INFO: 0x01,
  KEYBOARD: 0x02,
  MOUSE_ABS: 0x04,
  MOUSE_REL: 0x05,
  RESET: 0x0f,
} as const

/** Absolute coordinate space. Not 32767 — see docs/PROTOCOL.md §3. */
export const ABS_MAX = 4095

export const MOD = {
  LCTRL: 0x01,
  LSHIFT: 0x02,
  LALT: 0x04,
  LGUI: 0x08,
  RCTRL: 0x10,
  RSHIFT: 0x20,
  RALT: 0x40,
  RGUI: 0x80,
} as const

/** Sum of every byte, mod 256 — header included. */
export function checksum(bytes: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]!) & 0xff
  return sum
}

export function frame(cmd: number, payload: number[] = [], addr = 0x00): Uint8Array {
  const body = [HDR0, HDR1, addr, cmd, payload.length, ...payload]
  return Uint8Array.from([...body, checksum(body)])
}

/** payload: [modifier, reserved, keycode ×6] */
export function keyboardFrame(modifier: number, keys: readonly number[]): Uint8Array {
  const k = keys.slice(0, 6)
  while (k.length < 6) k.push(0)
  return frame(CMD.KEYBOARD, [modifier & 0xff, 0x00, ...k.map((v) => v & 0xff)])
}

/** payload: [0x02, buttons, xLSB, xMSB, yLSB, yMSB, wheel] */
export function mouseAbsFrame(buttons: number, x: number, y: number, wheel = 0): Uint8Array {
  const cx = Math.max(0, Math.min(ABS_MAX, Math.round(x)))
  const cy = Math.max(0, Math.min(ABS_MAX, Math.round(y)))
  return frame(CMD.MOUSE_ABS, [
    0x02,
    buttons & 0xff,
    cx & 0xff,
    (cx >> 8) & 0xff,
    cy & 0xff,
    (cy >> 8) & 0xff,
    wheel & 0xff,
  ])
}

/**
 * payload: [0x01, buttons, dx, dy, wheel]
 * dx/dy/wheel are signed values carried in unsigned bytes. 0x80 is deliberately
 * never emitted, matching the reference client.
 */
export function mouseRelFrame(buttons: number, dx: number, dy: number, wheel = 0): Uint8Array {
  const enc = (v: number) => {
    const b = Math.max(-127, Math.min(127, Math.round(v))) & 0xff
    return b === 0x80 ? 0x81 : b
  }
  return frame(CMD.MOUSE_REL, [0x01, buttons & 0xff, enc(dx), enc(dy), wheel & 0xff])
}

export function resetFrame(): Uint8Array {
  return frame(CMD.RESET)
}

export function getInfoFrame(): Uint8Array {
  return frame(CMD.GET_INFO)
}

export interface ReplyMatch {
  ok: boolean
  payload: Uint8Array
  /** Index just past the matched frame, for trimming the receive buffer. */
  end: number
}

/**
 * Find the first well-formed reply to `cmd`.
 *
 * A reply is at least 7 bytes (header 3 + reply byte + length + ≥1 payload +
 * checksum); the firmware always answers with a one-byte status so this holds.
 */
export function parseReply(buf: ArrayLike<number>, cmd: number): ReplyMatch | null {
  const wantOk = (cmd | 0x80) & 0xff
  const wantErr = (cmd | 0xc0) & 0xff

  for (let i = 0; i + 7 <= buf.length; i++) {
    if (buf[i] !== HDR0 || buf[i + 1] !== HDR1) continue
    const replyByte = buf[i + 2 + 1]!
    const len = buf[i + 4]!
    const total = 5 + len + 1
    if (i + total > buf.length) continue

    const slice: number[] = []
    for (let j = i; j < i + total - 1; j++) slice.push(buf[j]!)
    if (checksum(slice) !== buf[i + total - 1]) continue

    if (replyByte === wantOk || replyByte === wantErr) {
      const payload = new Uint8Array(len)
      for (let j = 0; j < len; j++) payload[j] = buf[i + 5 + j]!
      return { ok: replyByte === wantOk, payload, end: i + total }
    }
  }
  return null
}

/**
 * Browser KeyboardEvent.keyCode → HID usage id.
 *
 * Ported verbatim from the reference client, including its quirks: keycode 18
 * (Alt) maps to 0xE6 (Right Alt) rather than 0xE2, and modifier keys resolve to
 * usages 0xE0..0xE7 which the caller places in the keycode array rather than the
 * modifier byte. The firmware folds those across — see docs/PROTOCOL.md §7.
 */
export function jsKeycodeToHid(keycode: number): number {
  if (keycode >= 65 && keycode <= 90) return keycode - 65 + 0x04 // A–Z
  if (keycode >= 49 && keycode <= 57) return keycode - 49 + 0x1e // 1–9
  if (keycode >= 112 && keycode <= 123) return keycode - 112 + 0x3a // F1–F12

  const map: Record<number, number> = {
    8: 0x2a, 9: 0x2b, 13: 0x28, 16: 0xe1, 17: 0xe0, 18: 0xe6, 19: 0x48,
    20: 0x39, 27: 0x29, 32: 0x2c, 33: 0x4b, 34: 0x4e, 35: 0x4d, 36: 0x4a,
    37: 0x50, 38: 0x52, 39: 0x4f, 40: 0x51, 44: 0x46, 45: 0x49, 46: 0x4c,
    48: 0x27, 59: 0x33, 61: 0x2e, 91: 0xe3, 92: 0xe7, 93: 0x65,
    96: 0x62, 97: 0x59, 98: 0x5a, 99: 0x5b, 100: 0x5c, 101: 0x5d, 102: 0x5e,
    103: 0x5f, 104: 0x60, 105: 0x61, 106: 0x55, 107: 0x57, 109: 0x56,
    110: 0x63, 111: 0x54, 144: 0x53, 145: 0x47, 146: 0x58,
    173: 0x2d, 186: 0x33, 187: 0x2e, 188: 0x36, 189: 0x2d, 190: 0x37,
    191: 0x38, 192: 0x35, 219: 0x2f, 220: 0x31, 221: 0x30, 222: 0x34,
  }
  return map[keycode] ?? 0x00
}

/** Modifier bit for a modifier keycode, honouring left/right location. */
export function modifierBit(keycode: number, isRight: boolean): number {
  switch (keycode) {
    case 17: return isRight ? MOD.RCTRL : MOD.LCTRL
    case 16: return isRight ? MOD.RSHIFT : MOD.LSHIFT
    case 18: return isRight ? MOD.RALT : MOD.LALT
    case 91: return isRight ? MOD.RGUI : MOD.LGUI
    default: return 0
  }
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')
}
