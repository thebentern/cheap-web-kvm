// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
const state = vi.hoisted(() => ({
  media: null as any,
  serial: null as any,
  ble: null as any,
}))
vi.mock('../app/composables/useVirtualMedia', () => ({
  useVirtualMedia: () => state.media,
}))
vi.mock('../app/composables/useSerialLink', () => ({
  useSerialLink: () => state.serial,
}))
vi.mock('../app/composables/useBleLink', () => ({
  useBleLink: () => state.ble,
}))
function link() {
  const connected = ref(true)
  return {
    connected,
    connecting: ref(false),
    supported: ref(true),
    portLabel: ref('Test link'),
    lastError: ref(null),
    connect: vi.fn(async () => {
      connected.value = true
      return true
    }),
    disconnect: vi.fn(async () => {
      connected.value = false
    }),
    sendAndWait: vi.fn(),
  }
}
async function setup(inserted = false) {
  vi.resetModules()
  state.serial = link()
  state.ble = link()
  state.ble.connected.value = false
  state.media = {
    connected: ref(true),
    transport: ref('usb'),
    connecting: ref(false),
    inserted: ref(inserted),
    busy: ref(false),
    uncertain: ref(false),
    error: ref(null),
    releaseHid: vi.fn(),
    sendAndWait: vi.fn(),
    disconnect: vi.fn(async () => {
      state.media.connected.value = false
    }),
    connect: vi.fn(),
  }
  return (await import('../app/composables/useLink')).useLink()
}
afterEach(() => vi.clearAllMocks())
describe('USB media and control transport selection', () => {
  it('keeps the serial cable open when keyboard control switches to Bluetooth', async () => {
    const control = await setup(true)
    expect(await control.connect('ble')).toBe(true)
    expect(state.serial.disconnect).not.toHaveBeenCalled()
    expect(state.media.disconnect).not.toHaveBeenCalled()
    expect(state.ble.connect).toHaveBeenCalledOnce()
    expect(control.wifiAvailable.value).toBe(false)
    expect(control.kind.value).toBe('ble')
  })
  it('blocks control disconnection while USB media is inserted', async () => {
    const control = await setup(true)
    await control.disconnect()
    expect(state.serial.disconnect).not.toHaveBeenCalled()
    expect(state.media.disconnect).not.toHaveBeenCalled()
    expect(state.media.error.value).toMatch(/Eject and synchronize/)
  })
  it('releases ejected USB media before closing its serial cable', async () => {
    const control = await setup()
    await control.disconnect()
    expect(state.media.disconnect).toHaveBeenCalledOnce()
    expect(state.serial.disconnect).toHaveBeenCalledOnce()
    expect(state.media.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      state.serial.disconnect.mock.invocationCallOrder[0],
    )
  })
  it('keeps USB control selected if a Bluetooth picker is cancelled', async () => {
    const control = await setup(true)
    state.ble.connect.mockImplementationOnce(async () => false)
    expect(await control.connect('ble')).toBe(false)
    expect(control.kind.value).toBe('serial')
    expect(control.connected.value).toBe(true)
    expect(state.serial.disconnect).not.toHaveBeenCalled()
  })
  it('rejects Wi-Fi control selection without losing the existing USB control link', async () => {
    const control = await setup(true)
    expect(await control.connect('wifi')).toBe(false)
    expect(control.kind.value).toBe('serial')
    expect(control.connected.value).toBe(true)
    expect(state.serial.disconnect).not.toHaveBeenCalled()
    expect(state.media.error.value).toMatch(/disconnect USB media/)
  })
  it('does not close serial if USB media could not be released', async () => {
    const control = await setup()
    state.media.disconnect.mockImplementationOnce(async () => {})
    expect(await control.disconnect()).toBe(false)
    expect(state.serial.disconnect).not.toHaveBeenCalled()
  })
})
