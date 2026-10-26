// SPDX-License-Identifier: GPL-3.0-or-later
import { coalesceMove, CMD } from '../ch9329'
import type { SendResult } from '../../composables/useSerialLink'
const failed = (): SendResult => ({ ok: false, timeout: false, payload: null })
interface Pending {
  frame: Uint8Array
  cmd: number
  pinned: boolean
  resolve: (r: SendResult) => void
}
/** One HID request at a time, leaving control slots for heartbeat and cancel.
 * Match the Bluetooth pointer coalescing rules; button edges are never merged.
 */
export class MediaHidQueue {
  private pending: Pending[] = []
  private pumping = false
  private buttons = 0
  constructor(
    private transact: (frame: Uint8Array, cmd: number) => Promise<SendResult>,
  ) {}
  send(frame: Uint8Array, cmd: number): Promise<SendResult> {
    // Firmware macro control bypasses queued input, including cancellation.
    if (cmd === 0x32 || cmd === 0x33)
      return this.transact(frame, cmd).catch(failed)
    const pointer = cmd === CMD.MOUSE_ABS || cmd === CMD.MOUSE_REL
    const buttons = pointer ? frame[6]! : this.buttons,
      pinned = pointer && buttons !== this.buttons
    if (pointer) this.buttons = buttons
    return new Promise((resolve) => {
      const last = this.pending.at(-1)
      if (pointer && !pinned && last && !last.pinned) {
        const merged = coalesceMove(last.frame, frame)
        if (merged) {
          last.resolve({ ok: true, timeout: false, payload: null })
          last.frame = merged
          last.resolve = resolve
          return
        }
      }
      if (this.pending.length >= 64) {
        resolve(failed())
        return
      }
      this.pending.push({ frame, cmd, resolve, pinned })
      void this.pump()
    })
  }
  clear() {
    for (const p of this.pending.splice(0)) p.resolve(failed())
    this.buttons = 0
  }
  private async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.pending.length) {
        const p = this.pending.shift()!
        p.resolve(await this.transact(p.frame, p.cmd).catch(failed))
      }
    } finally {
      this.pumping = false
    }
  }
}
