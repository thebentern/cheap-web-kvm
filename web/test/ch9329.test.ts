/**
 * Golden-frame tests for the CH9329 port.
 *
 * These vectors are the same ones tools/ch9329_test.py asserts against, and the
 * firmware was verified against real hardware using them. If a change here makes
 * a test fail, the change is wrong — not the test.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest'
import {
  ABS_MAX,
  CMD,
  MOD,
  checksum,
  getInfoFrame,
  hex,
  jsKeycodeToHid,
  keyboardFrame,
  modifierBit,
  mouseAbsFrame,
  mouseRelFrame,
  parseReply,
  resetFrame,
} from '../app/utils/ch9329'

const HID_LSHIFT = 0xe1

describe('frame builder golden vectors', () => {
  it('soft reset (0x0F)', () => {
    expect(hex(resetFrame())).toBe('57 ab 00 0f 00 11')
  })

  it('keyboard: shift via the modifier byte', () => {
    expect(hex(keyboardFrame(MOD.LSHIFT, [0x04]))).toBe(
      '57 ab 00 02 08 02 00 04 00 00 00 00 00 12',
    )
  })

  it('keyboard: all released', () => {
    expect(hex(keyboardFrame(0, []))).toBe('57 ab 00 02 08 00 00 00 00 00 00 00 00 0c')
  })

  it('keyboard: browser shift+A, 0xE1 in the array and an empty modifier byte', () => {
    expect(hex(keyboardFrame(0, [HID_LSHIFT, 0x04]))).toBe(
      '57 ab 00 02 08 00 00 e1 04 00 00 00 00 f1',
    )
  })

  it('absolute mouse: centre of a 4095 square', () => {
    expect(hex(mouseAbsFrame(0, 2048, 2048))).toBe('57 ab 00 04 07 02 00 00 08 00 08 00 1f')
  })

  it('relative mouse: dx = -1', () => {
    expect(hex(mouseRelFrame(0, -1, 0, 0))).toBe('57 ab 00 05 05 01 00 ff 00 00 0c')
  })

  it('get info', () => {
    expect(hex(getInfoFrame())).toBe('57 ab 00 01 00 03')
  })
})

describe('protocol invariants', () => {
  it('absolute coordinates span 0..4095, not 0..32767', () => {
    expect(ABS_MAX).toBe(4095)
    // Clamped, and split little-endian.
    expect(hex(mouseAbsFrame(0, 99999, 0))).toContain('ff 0f')
  })

  it('never emits 0x80 for relative dx/dy', () => {
    for (let v = -200; v <= 200; v++) {
      const f = mouseRelFrame(0, v, v)
      expect(f[7]).not.toBe(0x80)
      expect(f[8]).not.toBe(0x80)
    }
  })

  it('a one-byte-payload reply is 7 bytes, the reference client parser minimum', () => {
    // Shorter replies are invisible to the upstream JS parser.
    expect(resetFrame().length).toBe(6)
    expect(keyboardFrame(0, []).length).toBeGreaterThanOrEqual(7)
  })

  it('checksum is a mod-256 sum including the header', () => {
    expect(checksum([0x57, 0xab, 0x00, 0x84, 0x01, 0x00])).toBe(0x87)
  })
})

describe('reply parsing', () => {
  const example = Uint8Array.from([0x57, 0xab, 0x00, 0x84, 0x01, 0x00, 0x87])

  it("accepts the reference client's documented example", () => {
    const r = parseReply(example, CMD.MOUSE_ABS)
    expect(r).not.toBeNull()
    expect(r!.ok).toBe(true)
    expect(Array.from(r!.payload)).toEqual([0x00])
    expect(r!.end).toBe(7)
  })

  it('ignores a reply addressed to a different command', () => {
    expect(parseReply(example, CMD.KEYBOARD)).toBeNull()
  })

  it('rejects a corrupted checksum', () => {
    const bad = Uint8Array.from(example)
    bad[6] = 0x00
    expect(parseReply(bad, CMD.MOUSE_ABS)).toBeNull()
  })

  it('reports an error reply as not ok', () => {
    const err = Uint8Array.from([0x57, 0xab, 0x00, 0xc4, 0x01, 0xe4, 0x00])
    err[6] = checksum(Array.from(err.slice(0, 6)))
    const r = parseReply(err, CMD.MOUSE_ABS)
    expect(r!.ok).toBe(false)
    expect(r!.payload[0]).toBe(0xe4)
  })

  it('finds a reply preceded by noise', () => {
    const noisy = Uint8Array.from([0xff, 0x00, 0x57, ...example])
    const r = parseReply(noisy, CMD.MOUSE_ABS)
    expect(r).not.toBeNull()
    expect(r!.ok).toBe(true)
  })
})

describe('keycode mapping', () => {
  it('maps letters, digits and function keys', () => {
    expect(jsKeycodeToHid(65)).toBe(0x04) // A
    expect(jsKeycodeToHid(90)).toBe(0x1d) // Z
    expect(jsKeycodeToHid(49)).toBe(0x1e) // 1
    expect(jsKeycodeToHid(48)).toBe(0x27) // 0
    expect(jsKeycodeToHid(112)).toBe(0x3a) // F1
    expect(jsKeycodeToHid(13)).toBe(0x28) // Enter
  })

  it('preserves the upstream quirk that Alt maps to Right Alt', () => {
    // 0xE2 would be Left Alt. Kept as-is so the wire stays identical.
    expect(jsKeycodeToHid(18)).toBe(0xe6)
  })

  it('returns 0 for unmapped keys', () => {
    expect(jsKeycodeToHid(255)).toBe(0x00)
  })

  it('resolves modifier bits by location', () => {
    expect(modifierBit(16, false)).toBe(MOD.LSHIFT)
    expect(modifierBit(16, true)).toBe(MOD.RSHIFT)
    expect(modifierBit(91, true)).toBe(MOD.RGUI)
    expect(modifierBit(65, false)).toBe(0)
  })
})
