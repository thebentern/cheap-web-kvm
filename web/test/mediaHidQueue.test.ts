// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from 'vitest'
import { MediaHidQueue } from '../app/utils/media/hidQueue'
import { CMD, frame, keyboardFrame, mouseAbsFrame } from '../app/utils/ch9329'
it('bounds HID flow, preserves button edges, coalesces motion, and prioritizes macro cancellation', async () => {
  const sent: number[] = [],
    releases: (() => void)[] = []
  const q = new MediaHidQueue(async (_frame, cmd) => {
    sent.push(cmd)
    if (cmd !== 0x33) await new Promise<void>((r) => releases.push(r))
    return { ok: true, timeout: false, payload: null }
  })
  const first = q.send(keyboardFrame(0, [4]), CMD.KEYBOARD)
  const moves = [
    q.send(mouseAbsFrame(0, 1, 1), CMD.MOUSE_ABS),
    q.send(mouseAbsFrame(0, 2, 2), CMD.MOUSE_ABS),
  ]
  const press = q.send(mouseAbsFrame(1, 2, 2), CMD.MOUSE_ABS)
  const after = q.send(mouseAbsFrame(1, 3, 3), CMD.MOUSE_ABS)
  await q.send(frame(0x33), 0x33)
  expect(sent).toEqual([CMD.KEYBOARD, 0x33])
  releases.shift()!()
  await first
  await new Promise((r) => setTimeout(r, 0))
  expect(sent).toEqual([CMD.KEYBOARD, 0x33, CMD.MOUSE_ABS])
  q.clear()
  releases.shift()!()
  await Promise.all([...moves, press, after])
  expect(sent).toHaveLength(3)
})
