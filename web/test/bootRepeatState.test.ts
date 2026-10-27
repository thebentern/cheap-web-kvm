// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type EffectScope } from 'vue'
import { FLAG } from '../app/utils/media/protocol'

let useBootRepeatState: typeof import('../app/composables/useBootRepeatState').useBootRepeatState
let scopes: EffectScope[]

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  scopes = []
  const state = await import('../app/composables/useBootRepeatState')
  useBootRepeatState = state.useBootRepeatState
})
afterEach(() => {
  for (const scope of scopes) scope.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
})

function panel(connected = ref(false), flags = ref(0)) {
  const scope = effectScope()
  scopes.push(scope)
  const state = scope.run(() => useBootRepeatState(connected, flags))!
  return { ...state, connected, flags, close: () => scope.stop() }
}

function start(p: ReturnType<typeof panel>, duration = 60_000) {
  expect(p.begin(false)).toBe(true)
  p.acknowledge(false, duration)
  p.finish()
}

describe('boot repetition action state', () => {
  it('keeps Serial/Bluetooth repetition stoppable after closing and reopening its panel', () => {
    const first = panel()
    start(first, 2_000)
    vi.advanceTimersByTime(500)
    first.close()
    const reopened = panel()
    expect(reopened.active.value).toBe(true)
    expect(reopened.begin(false)).toBe(false)
    vi.advanceTimersByTime(1_499)
    expect(reopened.active.value).toBe(true)
    vi.advanceTimersByTime(1)
    expect(reopened.active.value).toBe(false)
    expect(reopened.begin(false)).toBe(true)
  })

  it('hands completion to the board after its first active status', () => {
    const p = panel(ref(true))
    start(p, 1_000)
    expect(p.active.value).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    p.flags.value = FLAG.MACRO
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(2_000)
    expect(p.active.value).toBe(true)
    p.flags.value = 0
    expect(p.active.value).toBe(false)
  })

  it('retains an acknowledged Start that finishes after its panel has closed', () => {
    const first = panel()
    expect(first.begin(false)).toBe(true)
    first.close()
    const reopened = panel()
    expect(reopened.pending.value).toBe('start')
    first.acknowledge(false, 1_000)
    first.finish()
    expect(reopened.active.value).toBe(true)
    expect(reopened.pending.value).toBeNull()
    vi.advanceTimersByTime(1_000)
    expect(reopened.active.value).toBe(false)
  })

  it('adopts active board status immediately when a panel reopens', () => {
    const first = panel()
    start(first, 1_000)
    first.close()
    first.connected.value = true
    first.flags.value = FLAG.MACRO
    expect(vi.getTimerCount()).toBe(1)
    const reopened = panel(first.connected, first.flags)
    expect(reopened.active.value).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    reopened.flags.value = 0
    expect(reopened.active.value).toBe(false)
  })

  it('returns to idle after Stop is acknowledged while preserving other media flags', () => {
    const p = panel(ref(true), ref(FLAG.PRESENT | FLAG.MACRO))
    expect(p.active.value).toBe(true)
    expect(p.begin(true)).toBe(true)
    expect(p.pending.value).toBe('stop')
    p.acknowledge(true, 60_000)
    p.finish()
    expect(p.active.value).toBe(false)
    expect(p.flags.value).toBe(FLAG.PRESENT)
    expect(p.pending.value).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps Stop available when the Stop request fails', () => {
    const p = panel()
    start(p)
    expect(p.begin(true)).toBe(true)
    // A failed request finishes without acknowledging cancellation.
    p.finish()
    expect(p.active.value).toBe(true)
    expect(p.begin(false)).toBe(false)
    expect(p.begin(true)).toBe(true)
  })

  it('keeps the pending action stable if board activity arrives before the Start reply', () => {
    const p = panel(ref(true))
    expect(p.begin(false)).toBe(true)
    expect(p.pending.value).toBe('start')
    p.flags.value = FLAG.MACRO
    expect(p.active.value).toBe(true)
    expect(p.pending.value).toBe('start')
    p.acknowledge(false, 1_000)
    p.finish()
    expect(vi.getTimerCount()).toBe(0)
    p.flags.value = 0
    expect(p.active.value).toBe(false)
  })

  it('shares pending actions between panels and leaves failed Start requests idle', () => {
    const first = panel()
    const second = panel()
    expect(first.begin(false)).toBe(true)
    expect(second.pending.value).toBe('start')
    expect(second.begin(false)).toBe(false)
    expect(second.begin(true)).toBe(false)
    first.finish()
    expect(second.active.value).toBe(false)
    expect(second.pending.value).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(second.begin(false)).toBe(true)
  })

  it('ignores disconnected board flags while retaining a bounded local fallback', () => {
    const p = panel(ref(false), ref(FLAG.MACRO))
    expect(p.active.value).toBe(false)
    start(p, 1_000)
    expect(p.active.value).toBe(true)
    vi.advanceTimersByTime(1_000)
    expect(p.active.value).toBe(false)
    p.connected.value = true
    expect(p.active.value).toBe(true)
    p.connected.value = false
    expect(p.active.value).toBe(false)
  })

  it('cancels the old expiry when a repetition is stopped and replaced', () => {
    const p = panel()
    start(p, 1_000)
    vi.advanceTimersByTime(200)
    expect(p.begin(true)).toBe(true)
    p.acknowledge(true, 0)
    p.finish()
    start(p, 2_000)
    vi.advanceTimersByTime(800)
    expect(p.active.value).toBe(true)
    vi.advanceTimersByTime(1_200)
    expect(p.active.value).toBe(false)
  })
})
