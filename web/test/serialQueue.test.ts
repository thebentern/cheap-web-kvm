// SPDX-License-Identifier: GPL-3.0-or-later
import { it, expect, vi } from 'vitest'
import { frame } from '../app/utils/ch9329'
it('serializes configuration and HID replies instead of clearing another command receive buffer', async () => {
  const { useSerialLink } = await import('../app/composables/useSerialLink')
  let incoming!: ReadableStreamDefaultController<Uint8Array>
  const sent: Uint8Array[] = []
  const port = {
    readable: new ReadableStream<Uint8Array>({
      start(c) {
        incoming = c
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(bytes) {
        sent.push(bytes)
      },
    }),
    async open() {},
    async close() {},
    getInfo() {
      return { usbVendorId: 0x303a }
    },
  }
  vi.stubGlobal('navigator', {
    serial: {
      async requestPort() {
        return port
      },
    },
  })
  const link = useSerialLink()
  try {
    expect(await link.connect()).toBe(true)
    const first = link.sendAndWait(frame(2, new Array(8).fill(0)), 2),
      second = link.sendAndWait(frame(0x35), 0x35)
    await new Promise((r) => setTimeout(r, 10))
    expect(sent).toHaveLength(1)
    incoming.enqueue(frame(0x82, [0]))
    expect((await first).ok).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(sent).toHaveLength(2)
    incoming.enqueue(frame(0xb5, [1, 1, 2, 1, 1, 1, 1, 0]))
    expect((await second).payload).toHaveLength(8)
  } finally {
    await link.disconnect()
    vi.unstubAllGlobals()
  }
})
