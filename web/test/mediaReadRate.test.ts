// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { MediaReadRate } from '../app/utils/media/readRate'

describe('current virtual media read speed', () => {
  it('samples byte deltas, becomes zero while idle and accounts for delayed timers', () => {
    const rate = new MediaReadRate()
    rate.reset(0, 1000)
    expect(rate.sample(8192, 2000)).toBe(8192)
    expect(rate.sample(8192, 3000)).toBe(0)
    expect(rate.sample(24576, 5000)).toBe(8192)
  })
  it('starts a new insertion without carrying earlier bytes or time into its speed', () => {
    const rate = new MediaReadRate()
    rate.reset(1048576, 1000)
    rate.reset(0, 100000)
    expect(rate.sample(4096, 100500)).toBe(8192)
    expect(rate.sample(0, 101000)).toBe(0)
    expect(rate.sample(0, 101000)).toBe(0)
  })
})
