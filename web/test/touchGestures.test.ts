/**
 * The touch recogniser behind the KVM stage: pointer events in, intents out.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest'
import {
  DRAG_HOLD_MS,
  SCROLL_STEP_PX,
  SECONDARY_TAP_MS,
  TAP_SLOP_PX,
  TRACKPAD_TAP_MS,
  createTouchRecognizer,
  type TouchIntent,
} from '../app/utils/touchGestures'

const types = (intents: TouchIntent[]) => intents.map((i) => i.type)
const ticks = (intents: TouchIntent[]) =>
  intents.reduce((s, i) => (i.type === 'scroll' ? s + i.ticks : s), 0)
const glided = (intents: TouchIntent[]) =>
  intents.reduce(
    (s, i) => (i.type === 'glide' ? { dx: s.dx + i.dx, dy: s.dy + i.dy } : s),
    { dx: 0, dy: 0 },
  )

/** Past the drag hold, so a moving finger in direct style commits to a drag. */
const LATE = DRAG_HOLD_MS + 20

describe('one finger, direct style', () => {
  it('a still touch is a tap where the finger landed, on lift and not before', () => {
    const r = createTouchRecognizer()
    expect(r.down(1, 100, 100, 0, 'direct')).toEqual([])
    expect(r.move(1, 103, 102, 40)).toEqual([])
    expect(r.up(1, 103, 102, 80)).toEqual([{ type: 'tap', x: 100, y: 100 }])
  })

  it('holding still for a long time and lifting is still a tap', () => {
    const r = createTouchRecognizer()
    r.down(1, 100, 100, 0, 'direct')
    expect(types(r.up(1, 101, 100, 3000))).toEqual(['tap'])
  })

  it('travel past the slop becomes a drag that starts where the finger landed', () => {
    const r = createTouchRecognizer()
    r.down(1, 100, 100, 0, 'direct')
    expect(r.move(1, 100 + TAP_SLOP_PX, 100, LATE)).toEqual([
      { type: 'dragStart', x: 100, y: 100 },
      { type: 'dragMove', x: 100 + TAP_SLOP_PX, y: 100 },
    ])
    expect(r.move(1, 150, 120, LATE + 10)).toEqual([{ type: 'dragMove', x: 150, y: 120 }])
    expect(r.up(1, 160, 125, 500)).toEqual([
      { type: 'dragMove', x: 160, y: 125 },
      { type: 'dragEnd', x: 160, y: 125 },
    ])
  })

  it('does not press before the drag hold, however far the finger has gone', () => {
    const r = createTouchRecognizer()
    r.down(1, 100, 100, 0, 'direct')
    expect(r.move(1, 140, 100, DRAG_HOLD_MS - 1)).toEqual([])
    expect(types(r.move(1, 150, 100, DRAG_HOLD_MS))).toEqual(['dragStart', 'dragMove'])
  })

  it('a flick lifted inside the drag hold is a quick drag, not a tap', () => {
    const r = createTouchRecognizer()
    r.down(1, 100, 100, 0, 'direct')
    r.move(1, 130, 100, 20)
    expect(r.up(1, 160, 100, 40)).toEqual([
      { type: 'dragStart', x: 100, y: 100 },
      { type: 'dragMove', x: 160, y: 100 },
      { type: 'dragEnd', x: 160, y: 100 },
    ])
  })

  it('a cancelled touch never taps, and a cancelled drag lets go', () => {
    const r = createTouchRecognizer()
    r.down(1, 100, 100, 0, 'direct')
    expect(r.cancel(1)).toEqual([])

    r.down(2, 100, 100, 0, 'direct')
    r.move(2, 140, 100, LATE)
    expect(r.cancel(2)).toEqual([{ type: 'dragEnd', x: 140, y: 100 }])
  })

  it('a second finger mid-drag changes nothing, and the drag ends with the first', () => {
    const r = createTouchRecognizer()
    r.down(1, 100, 100, 0, 'direct')
    r.move(1, 140, 100, LATE)
    expect(r.down(2, 300, 300, LATE + 10, 'direct')).toEqual([])
    expect(r.move(2, 300, 200, LATE + 20)).toEqual([])
    expect(types(r.up(2, 300, 200, LATE + 30))).toEqual([])
    expect(types(r.up(1, 150, 100, LATE + 40))).toEqual(['dragMove', 'dragEnd'])
  })
})

describe('one finger, trackpad style', () => {
  it('a quick tap clicks without saying where', () => {
    const r = createTouchRecognizer()
    r.down(1, 100, 100, 0, 'trackpad')
    expect(types(r.up(1, 100, 100, 60))).toEqual(['tap'])
  })

  it('a touch held past the tap window never clicks', () => {
    const r = createTouchRecognizer()
    r.down(1, 100, 100, 0, 'trackpad')
    expect(types(r.up(1, 100, 100, TRACKPAD_TAP_MS + 1))).toEqual([])
  })

  it('a slow nudge under the slop still moves the pointer, and does not click', () => {
    const r = createTouchRecognizer()
    r.down(1, 300, 300, 0, 'trackpad')
    const out: TouchIntent[] = []
    for (let i = 1; i <= 8; i++) out.push(...r.move(1, 300 + i, 300, i * 110))
    out.push(...r.up(1, 308, 300, 900))
    expect(types(out)).not.toContain('tap')
    expect(glided(out)).toEqual({ dx: 8, dy: 0 })
  })

  it('glide deltas add up to the whole travel, slop included', () => {
    const r = createTouchRecognizer()
    r.down(1, 100, 100, 0, 'trackpad')
    const out = [
      ...r.move(1, 104, 101, 10),
      ...r.move(1, 115, 103, 20),
      ...r.move(1, 130, 90, 30),
      ...r.up(1, 131, 92, 300),
    ]
    expect(types(out).every((t) => t === 'glide')).toBe(true)
    expect(glided(out)).toEqual({ dx: 31, dy: -8 })
  })

  it('never presses a button', () => {
    const r = createTouchRecognizer()
    r.down(1, 0, 0, 0, 'trackpad')
    const out = [...r.move(1, 50, 50, 10), ...r.move(1, 90, 10, 20), ...r.up(1, 90, 10, 400)]
    expect(types(out).filter((t) => t !== 'glide')).toEqual([])
  })
})

describe('two fingers', () => {
  function twoDown(style: 'direct' | 'trackpad' = 'direct') {
    const r = createTouchRecognizer()
    r.down(1, 100, 300, 0, style)
    r.down(2, 200, 300, 30, style)
    return r
  }

  it('the first finger of a scroll never clicks', () => {
    const r = twoDown()
    const out = [
      ...r.move(1, 100, 250, 100),
      ...r.move(2, 200, 250, 110),
      ...r.up(1, 100, 250, 400),
    ]
    expect(types(out).filter((t) => t !== 'scroll')).toEqual([])
    expect(r.up(2, 200, 250, 420)).toEqual([])
  })

  it('a flick whose first finger lands moving is still a scroll', () => {
    const r = createTouchRecognizer()
    r.down(1, 100, 400, 0, 'direct')
    // Finger 1 is a frame ahead and already past the slop.
    expect(r.move(1, 100, 388, 16)).toEqual([])
    r.down(2, 200, 400, 20, 'direct')
    const out: TouchIntent[] = []
    for (let n = 1; n <= 6; n++) {
      out.push(...r.move(1, 100, 388 - n * 20, 20 + n * 8))
      out.push(...r.move(2, 200, 400 - n * 20, 24 + n * 8))
    }
    out.push(...r.up(1, 100, 268, 80), ...r.up(2, 200, 280, 82))
    expect(types(out).filter((t) => t !== 'scroll')).toEqual([])
    expect(ticks(out)).toBeGreaterThan(0)
  })

  it('moving up scrolls down, one tick per step of centroid travel, at the landing point', () => {
    const r = twoDown()
    const out = [
      ...r.move(1, 100, 300 - 2 * SCROLL_STEP_PX, 100),
      ...r.move(2, 200, 300 - 2 * SCROLL_STEP_PX, 110),
    ]
    expect(ticks(out)).toBe(2)
    for (const i of out) if (i.type === 'scroll') expect([i.x, i.y]).toEqual([150, 300])
  })

  it('moving down scrolls up, and part-steps carry over rather than vanish', () => {
    const r = twoDown()
    const out: TouchIntent[] = []
    let t = 40
    for (let y = 300; y <= 300 + 3 * SCROLL_STEP_PX; y += 7) {
      out.push(...r.move(1, 100, y, (t += 5)), ...r.move(2, 200, y, (t += 5)))
    }
    const end = 300 + 3 * SCROLL_STEP_PX
    out.push(...r.move(1, 100, end, (t += 5)), ...r.move(2, 200, end, (t += 5)))
    expect(ticks(out)).toBe(-3)
  })

  it('a quick still two-finger tap is a right click where the fingers landed', () => {
    const r = twoDown()
    expect(r.up(2, 200, 300, 30 + SECONDARY_TAP_MS - 1)).toEqual([
      { type: 'secondaryTap', x: 150, y: 300 },
    ])
    expect(r.up(1, 100, 300, 30 + SECONDARY_TAP_MS)).toEqual([])
  })

  it('a slow or moved two-finger touch is not a right click', () => {
    const slow = twoDown()
    expect(slow.up(1, 100, 300, 30 + SECONDARY_TAP_MS + 1)).toEqual([])

    const moved = twoDown()
    moved.move(1, 100, 300 - TAP_SLOP_PX * 2, 60)
    expect(types(moved.up(1, 100, 300 - TAP_SLOP_PX * 2, 100))).not.toContain('secondaryTap')
  })

  it('a quick pinch or twist is not a right click, though the midpoint stays put', () => {
    const pinch = createTouchRecognizer()
    pinch.down(1, 300, 400, 0, 'direct')
    pinch.down(2, 500, 400, 10, 'direct')
    for (let n = 1; n <= 18; n++) {
      pinch.move(1, 300 - n * 8, 400, 10 + n * 16)
      pinch.move(2, 500 + n * 8, 400, 12 + n * 16)
    }
    expect(types(pinch.up(1, 156, 400, 300))).not.toContain('secondaryTap')

    const twist = createTouchRecognizer()
    twist.down(1, 320, 400, 0, 'trackpad')
    twist.down(2, 480, 400, 10, 'trackpad')
    for (let n = 1; n <= 9; n++) {
      const a = (n / 9) * (Math.PI / 2)
      twist.move(1, 400 - 80 * Math.cos(a), 400 - 80 * Math.sin(a), 10 + n * 25)
      twist.move(2, 400 + 80 * Math.cos(a), 400 + 80 * Math.sin(a), 12 + n * 25)
    }
    expect(types(twist.up(1, 400, 320, 260))).not.toContain('secondaryTap')
  })

  it('a second finger joining a trackpad glide turns it into a scroll', () => {
    const r = createTouchRecognizer()
    r.down(1, 100, 300, 0, 'trackpad')
    expect(types(r.move(1, 130, 300, 50))).toEqual(['glide'])
    r.down(2, 200, 300, 200, 'trackpad')
    const out = [...r.move(1, 130, 200, 250), ...r.move(2, 200, 200, 260)]
    expect(types(out)).not.toContain('glide')
    expect(ticks(out)).toBeGreaterThan(0)
  })

  it('a third finger is ignored', () => {
    const r = twoDown()
    expect(r.down(3, 300, 300, 50, 'direct')).toEqual([])
    expect(r.move(3, 300, 0, 60)).toEqual([])
  })
})

describe('after a gesture', () => {
  it('a finger left behind does nothing until every finger has lifted', () => {
    const r = createTouchRecognizer()
    r.down(1, 100, 300, 0, 'direct')
    r.down(2, 200, 300, 30, 'direct')
    r.up(2, 200, 300, 60)
    expect(r.move(1, 400, 300, 150)).toEqual([])
    expect(r.up(1, 400, 300, 200)).toEqual([])

    expect(r.down(3, 50, 50, 300, 'direct')).toEqual([])
    expect(types(r.up(3, 50, 50, 350))).toEqual(['tap'])
  })

  it('the style is fixed when the first finger lands', () => {
    const r = createTouchRecognizer()
    r.down(1, 0, 0, 0, 'trackpad')
    r.down(2, 10, 0, 10, 'direct')
    r.up(1, 0, 0, 500)
    r.up(2, 10, 0, 500)
    r.down(3, 0, 0, 600, 'direct')
    expect(types(r.move(3, 50, 0, 600 + LATE))).toEqual(['dragStart', 'dragMove'])
  })

  it('a repeated pointerdown for an id already down is ignored', () => {
    const r = createTouchRecognizer()
    r.down(1, 100, 100, 0, 'direct')
    expect(r.down(1, 100, 100, 5, 'direct')).toEqual([])
    expect(types(r.up(1, 100, 100, 50))).toEqual(['tap'])
  })

  it('cancelAll releases a held drag and starts clean', () => {
    const r = createTouchRecognizer()
    r.down(1, 0, 0, 0, 'direct')
    r.move(1, 40, 0, LATE)
    expect(r.cancelAll()).toEqual([{ type: 'dragEnd', x: 40, y: 0 }])
    expect(r.cancelAll()).toEqual([])
    r.down(2, 0, 0, 200, 'direct')
    expect(types(r.up(2, 0, 0, 250))).toEqual(['tap'])
  })
})
