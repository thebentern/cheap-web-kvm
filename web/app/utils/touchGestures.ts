// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Touch gestures on the KVM stage, as a pure state machine: touch pointer
 * events in, pointer intents out. No DOM and no HID, so it can be tested on
 * its own; pages/index.vue turns the intents into reports.
 *
 * Two styles, fixed when the first finger lands:
 *  - direct (absolute mode): the screen is the target's screen. Tap to click
 *    there; touch and drag to drag with the left button held.
 *  - trackpad (relative mode): the screen is a trackpad. Drag to move the
 *    pointer; a quick tap clicks wherever it is.
 * In both, two fingers scroll and a quick two-finger tap is a right click, as
 * on an iPad trackpad.
 *
 * A finger is not a press until it is clearly a tap or a drag, because the
 * first finger of a two-finger scroll must not click on its way down — even
 * when it lands already moving, a frame or two before the second.
 */

export type TouchStyle = 'direct' | 'trackpad'

export type TouchIntent =
  | { type: 'tap'; x: number; y: number }
  | { type: 'dragStart'; x: number; y: number }
  | { type: 'dragMove'; x: number; y: number }
  | { type: 'dragEnd'; x: number; y: number }
  | { type: 'glide'; dx: number; dy: number }
  /**
   * Positive scrolls down, the same sense as a positive WheelEvent.deltaY.
   * x/y is where the two fingers landed, for direct style to scroll under them.
   */
  | { type: 'scroll'; ticks: number; x: number; y: number }
  | { type: 'secondaryTap'; x: number; y: number }

/** Travel under this many CSS pixels still counts as a tap. */
export const TAP_SLOP_PX = 10
/**
 * Direct style waits this long before a moving finger presses the button, so
 * a second finger landing just after it can still make the gesture a scroll.
 */
export const DRAG_HOLD_MS = 80
/** Trackpad style: a touch held longer than this is a pointer move, never a click. */
export const TRACKPAD_TAP_MS = 300
/** Two-finger travel per scroll tick. */
export const SCROLL_STEP_PX = 30
/** A two-finger tap held longer than this is not a right click. */
export const SECONDARY_TAP_MS = 400

interface Contact {
  x: number
  y: number
  startX: number
  startY: number
  downT: number
}

/**
 * pending: one finger down, not yet a tap or a drag.
 * spent:   the gesture is over; ignore every finger until all have lifted.
 */
type Mode = 'idle' | 'pending' | 'drag' | 'glide' | 'scroll' | 'spent'

export function createTouchRecognizer() {
  const contacts = new Map<number, Contact>()
  let mode: Mode = 'idle'
  let style: TouchStyle = 'direct'
  /** The finger driving a one-finger gesture. */
  let primary = -1
  let scrollIds: number[] = []
  let scrollStartT = 0
  let scrollStart = { x: 0, y: 0 }
  let scrollMoved = false
  let scrollAcc = 0
  let lastCentroidY = 0

  function reset() {
    contacts.clear()
    mode = 'idle'
    primary = -1
    scrollIds = []
  }

  const travel = (c: Contact) => Math.hypot(c.x - c.startX, c.y - c.startY)

  function centroid() {
    const a = contacts.get(scrollIds[0]!)!
    const b = contacts.get(scrollIds[1]!)!
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }

  function beginScroll(t: number) {
    scrollIds = [...contacts.keys()].slice(0, 2)
    // Travel before the second finger landed is not part of the scroll, and
    // must not count against a two-finger tap either.
    for (const id of scrollIds) {
      const c = contacts.get(id)!
      c.startX = c.x
      c.startY = c.y
    }
    mode = 'scroll'
    scrollStartT = t
    scrollMoved = false
    scrollAcc = 0
    scrollStart = centroid()
    lastCentroidY = scrollStart.y
  }

  function down(id: number, x: number, y: number, t: number, s: TouchStyle): TouchIntent[] {
    // A pointer id is unique while it is down; a repeat would corrupt the pair.
    if (contacts.has(id)) return []
    contacts.set(id, { x, y, startX: x, startY: y, downT: t })
    if (mode === 'idle') {
      mode = 'pending'
      primary = id
      style = s
    } else if (mode === 'pending' || mode === 'glide') {
      // Nothing is held yet, so a second finger can still become a scroll.
      beginScroll(t)
    }
    // A finger added mid-drag or mid-scroll changes nothing.
    return []
  }

  function move(id: number, x: number, y: number, t: number): TouchIntent[] {
    const c = contacts.get(id)
    if (!c) return []
    const px = c.x
    const py = c.y
    c.x = x
    c.y = y

    switch (mode) {
      case 'pending': {
        const held = t - c.downT
        if (style === 'direct') {
          if (travel(c) < TAP_SLOP_PX || held < DRAG_HOLD_MS) return []
          mode = 'drag'
          return [
            { type: 'dragStart', x: c.startX, y: c.startY },
            { type: 'dragMove', x, y },
          ]
        }
        if (travel(c) < TAP_SLOP_PX && held <= TRACKPAD_TAP_MS) return []
        mode = 'glide'
        const dx = x - c.startX
        const dy = y - c.startY
        return dx || dy ? [{ type: 'glide', dx, dy }] : []
      }
      case 'drag':
        return id === primary ? [{ type: 'dragMove', x, y }] : []
      case 'glide':
        return id === primary ? [{ type: 'glide', dx: x - px, dy: y - py }] : []
      case 'scroll': {
        if (!scrollIds.includes(id)) return []
        const m = centroid()
        // A pinch or a twist barely moves the midpoint, so watch each finger too.
        if (
          travel(c) >= TAP_SLOP_PX ||
          Math.hypot(m.x - scrollStart.x, m.y - scrollStart.y) >= TAP_SLOP_PX
        ) {
          scrollMoved = true
        }
        // Content follows the fingers: moving them up scrolls down.
        scrollAcc += lastCentroidY - m.y
        lastCentroidY = m.y
        const ticks = Math.trunc(scrollAcc / SCROLL_STEP_PX)
        if (!ticks) return []
        scrollAcc -= ticks * SCROLL_STEP_PX
        return [{ type: 'scroll', ticks, x: scrollStart.x, y: scrollStart.y }]
      }
      default:
        return []
    }
  }

  function up(id: number, x: number, y: number, t: number): TouchIntent[] {
    // Take the lift position as a final move first, so nothing is skipped.
    const out = move(id, x, y, t)
    const c = contacts.get(id)
    if (!c) return out

    if (id === primary && mode === 'pending') {
      // Still pending with real travel means a flick shorter than the drag
      // hold: it was a quick drag, not a tap.
      if (travel(c) >= TAP_SLOP_PX) {
        out.push(
          { type: 'dragStart', x: c.startX, y: c.startY },
          { type: 'dragMove', x, y },
          { type: 'dragEnd', x, y },
        )
      } else {
        out.push({ type: 'tap', x: c.startX, y: c.startY })
      }
      mode = 'spent'
    } else if (id === primary && mode === 'drag') {
      out.push({ type: 'dragEnd', x, y })
      mode = 'spent'
    } else if (id === primary && mode === 'glide') {
      mode = 'spent'
    } else if (mode === 'scroll' && scrollIds.includes(id)) {
      if (!scrollMoved && t - scrollStartT <= SECONDARY_TAP_MS) {
        out.push({ type: 'secondaryTap', x: scrollStart.x, y: scrollStart.y })
      }
      mode = 'spent'
    }

    contacts.delete(id)
    if (contacts.size === 0) reset()
    return out
  }

  /** The system took the touch away (a palm, an edge swipe). Never a tap. */
  function cancel(id: number): TouchIntent[] {
    const c = contacts.get(id)
    if (!c) return []
    const out: TouchIntent[] = []

    if (id === primary && mode === 'drag') {
      out.push({ type: 'dragEnd', x: c.x, y: c.y })
      mode = 'spent'
    } else if (id === primary && (mode === 'pending' || mode === 'glide')) {
      mode = 'spent'
    } else if (mode === 'scroll' && scrollIds.includes(id)) {
      mode = 'spent'
    }

    contacts.delete(id)
    if (contacts.size === 0) reset()
    return out
  }

  /** Abandon whatever is in progress, releasing a held drag. */
  function cancelAll(): TouchIntent[] {
    const out = primary >= 0 && mode === 'drag' ? cancel(primary) : []
    reset()
    return out
  }

  return { down, move, up, cancel, cancelAll }
}
