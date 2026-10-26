// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { useSerialLink } from '../app/composables/useSerialLink'
let link: ReturnType<typeof useSerialLink> | undefined
let values: Map<string, string>
let open: ReturnType<typeof vi.fn>
let port: object
beforeEach(() => {
  vi.resetModules()
  values = new Map()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
  open = vi.fn(async () => {})
  port = {
    connected: true,
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
    open,
    async close() {},
    getInfo: () => ({ usbVendorId: 0x303a }),
  }
  vi.stubGlobal('navigator', { serial: { requestPort: async () => port } })
})
afterEach(async () => {
  await link?.disconnect()
  link = undefined
  vi.unstubAllGlobals()
})
async function current() {
  const module = await import('../app/composables/useSerialLink')
  return (link = module.useSerialLink())
}
describe('USB serial baud selection', () => {
  it('uses and saves a supported selection on the next ordinary connection', async () => {
    const serial = await current()
    expect(serial.baudRate.value).toBe(115200)
    expect(serial.setBaudRate(2000000)).toBe(true)
    expect(values.get('kvm.serialBaudRate')).toBe('2000000')
    expect(await serial.connect()).toBe(true)
    expect(open).toHaveBeenCalledWith({ baudRate: 2000000 })
    expect(serial.activeBaudRate.value).toBe(2000000)
  })
  it.each([
    ['921600', 921600],
    ['NaN', 115200],
    ['2000001', 115200],
    ['9600', 115200],
  ])('loads saved %s safely as %i', async (stored, expected) => {
    values.set('kvm.serialBaudRate', stored)
    const serial = await current()
    expect(serial.baudRate.value).toBe(expected)
    expect(await serial.connect()).toBe(true)
    expect(open).toHaveBeenCalledWith({ baudRate: expected })
  })
  it('keeps an explicit connection rate compatible without changing the saved preference', async () => {
    const serial = await current()
    serial.setBaudRate(460800)
    expect(await serial.connect(921600)).toBe(true)
    expect(open).toHaveBeenCalledWith({ baudRate: 921600 })
    expect(serial.baudRate.value).toBe(460800)
    expect(serial.activeBaudRate.value).toBe(921600)
    expect(values.get('kvm.serialBaudRate')).toBe('460800')
  })
  it('cannot change speed while a port is opening or connected', async () => {
    let choose!: (port: object) => void
    vi.stubGlobal('navigator', {
      serial: {
        requestPort: () =>
          new Promise((resolve) => {
            choose = resolve
          }),
      },
    })
    const serial = await current()
    const connecting = serial.connect()
    expect(serial.baudLocked.value).toBe(true)
    expect(serial.setBaudRate(2000000)).toBe(false)
    choose(port)
    await connecting
    expect(serial.baudLocked.value).toBe(true)
    expect(serial.setBaudRate(2000000)).toBe(false)
    expect(serial.baudRate.value).toBe(115200)
    await serial.disconnect()
    expect(serial.baudLocked.value).toBe(false)
    expect(serial.setBaudRate(2000000)).toBe(true)
  })
  it('rejects unsupported selections and works when browser storage is unavailable', async () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('Storage unavailable')
        },
        setItem: () => {
          throw new Error('Storage unavailable')
        },
      },
    })
    const serial = await current()
    expect(serial.setBaudRate(0)).toBe(false)
    expect(serial.setBaudRate(9600)).toBe(false)
    expect(serial.setBaudRate(460800)).toBe(true)
    expect(await serial.connect()).toBe(true)
    expect(open).toHaveBeenCalledWith({ baudRate: 460800 })
  })
})
