// SPDX-License-Identifier: GPL-3.0-or-later
import { it, expect, vi } from 'vitest'
import { frame } from '../app/utils/ch9329'
it('sends and receives configuration frames across minimum-MTU BLE fragments', async () => {
  const { useBleLink } = await import('../app/composables/useBleLink')
  class Characteristic extends EventTarget {
    value?: DataView
    startNotifications() {
      return Promise.resolve(this)
    }
  }
  const tx = new Characteristic(),
    writes: Uint8Array[] = []
  let bytes: number[] = []
  const rx = {
    async writeValueWithResponse(chunk: Uint8Array) {
      expect(chunk.length).toBeLessThanOrEqual(20)
      writes.push(chunk)
      bytes.push(...chunk)
      if (bytes.length >= 6 && bytes.length === bytes[4]! + 6) {
        const cmd = bytes[3]!
        bytes = []
        const reply = frame(
          cmd | 0x80,
          cmd === 1
            ? [0x30, 1, 0, 0, 0, 0, 0, 0]
            : Array.from({ length: 64 }, (_, i) => i),
        )
        for (let at = 0; at < reply.length; at += 20) {
          const part = reply.slice(at, at + 20)
          tx.value = new DataView(part.buffer)
          tx.dispatchEvent(new Event('characteristicvaluechanged'))
        }
      }
    },
  }
  const device = new EventTarget() as EventTarget & { name: string; gatt: any }
  device.name = 'Test KVM'
  device.gatt = {
    async connect() {
      return this
    },
    disconnect() {},
    async getPrimaryService() {
      return {
        async getCharacteristic(id: string) {
          return id.includes('0002') ? rx : tx
        },
      }
    },
  }
  vi.stubGlobal('navigator', {
    bluetooth: {
      async requestDevice() {
        return device
      },
    },
  })
  const link = useBleLink()
  try {
    expect(await link.connect()).toBe(true)
    const reply = await link.sendAndWait(
      frame(0x36, new Array(64).fill(1)),
      0x36,
    )
    expect(reply.ok).toBe(true)
    expect(reply.payload).toHaveLength(64)
    expect(writes.slice(1).map((p) => p.length)).toEqual([20, 20, 20, 10])
  } finally {
    await link.disconnect()
    vi.unstubAllGlobals()
  }
})
