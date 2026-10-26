// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
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

async function connectedWifi(inserted = true) {
  const control = await setup(inserted)
  state.media.connected.value = false
  state.media.transport.value = 'wifi'
  state.serial.connected.value = false
  state.media.connected.value = true
  await nextTick()
  return control
}

describe('Wi-Fi media and keyboard control share one connection', () => {
  it('adopts connected Wi-Fi media for every control consumer without reconnecting', async () => {
    const control = await connectedWifi()
    const second = (await import('../app/composables/useLink')).useLink()
    expect(control.kind.value).toBe('wifi')
    expect(control.connected.value).toBe(true)
    expect(second.kind.value).toBe('wifi')
    expect(second.connected.value).toBe(true)
    const frame = new Uint8Array([0x57, 0xab])
    await second.sendAndWait(frame, 1)
    expect(state.media.sendAndWait).toHaveBeenCalledWith(frame, 1)
    expect(state.media.connect).not.toHaveBeenCalled()
    expect(state.media.disconnect).not.toHaveBeenCalled()
    expect(state.media.releaseHid).not.toHaveBeenCalled()
  })

  it('preserves live USB control when Wi-Fi media connects', async () => {
    const control = await setup(true)
    state.media.connected.value = false
    state.media.transport.value = 'wifi'
    state.media.connected.value = true
    await nextTick()
    expect(control.kind.value).toBe('serial')
    expect(control.connected.value).toBe(true)
    expect(state.serial.disconnect).not.toHaveBeenCalled()
    expect(state.media.connect).not.toHaveBeenCalled()
  })

  it('preserves live Bluetooth control when Wi-Fi media connects', async () => {
    const control = await setup(true)
    expect(await control.connect('ble')).toBe(true)
    state.media.connected.value = false
    state.media.transport.value = 'wifi'
    state.media.connected.value = true
    await nextTick()
    expect(control.kind.value).toBe('ble')
    expect(control.connected.value).toBe(true)
    expect(state.ble.disconnect).not.toHaveBeenCalled()
    expect(state.media.connect).not.toHaveBeenCalled()
    expect(state.media.disconnect).not.toHaveBeenCalled()
  })

  it('pauses and resumes Wi-Fi control without disturbing an inserted disk', async () => {
    const control = await connectedWifi()
    expect(await control.disconnect()).toBe(true)
    await nextTick()
    const second = (await import('../app/composables/useLink')).useLink()
    expect(control.connected.value).toBe(false)
    expect(second.connected.value).toBe(false)
    expect(state.media.connected.value).toBe(true)
    expect(state.media.inserted.value).toBe(true)
    expect(state.media.releaseHid).toHaveBeenCalledOnce()
    expect(state.media.disconnect).not.toHaveBeenCalled()
    expect(await second.connect('wifi')).toBe(true)
    expect(control.connected.value).toBe(true)
    expect(control.kind.value).toBe('wifi')
    expect(state.media.connect).not.toHaveBeenCalled()
    expect(state.media.releaseHid).toHaveBeenCalledOnce()
  })

  it('restores Wi-Fi control when its existing media connection returns', async () => {
    const control = await connectedWifi()
    state.media.connected.value = false
    await nextTick()
    expect(control.connected.value).toBe(false)
    state.media.connected.value = true
    await nextTick()
    expect(control.connected.value).toBe(true)
    expect(control.kind.value).toBe('wifi')
    expect(state.media.connect).not.toHaveBeenCalled()
    expect(state.media.disconnect).not.toHaveBeenCalled()
    expect(state.media.releaseHid).not.toHaveBeenCalled()
  })

  it('uses available Wi-Fi media when the selected USB control cable disconnects', async () => {
    const control = await setup(true)
    state.media.connected.value = false
    state.media.transport.value = 'wifi'
    state.media.connected.value = true
    await nextTick()
    expect(control.kind.value).toBe('serial')
    state.serial.connected.value = false
    await nextTick()
    expect(control.kind.value).toBe('wifi')
    expect(control.connected.value).toBe(true)
    expect(state.media.inserted.value).toBe(true)
    expect(state.media.connect).not.toHaveBeenCalled()
    expect(state.media.disconnect).not.toHaveBeenCalled()
  })

  it('uses available Wi-Fi media when Bluetooth control disconnects', async () => {
    const control = await connectedWifi()
    expect(await control.connect('ble')).toBe(true)
    state.ble.connected.value = false
    await nextTick()
    expect(control.kind.value).toBe('wifi')
    expect(control.connected.value).toBe(true)
    expect(state.media.inserted.value).toBe(true)
    expect(state.media.connect).not.toHaveBeenCalled()
    expect(state.media.disconnect).not.toHaveBeenCalled()
  })

  it('retains working Wi-Fi control if a Bluetooth picker is cancelled', async () => {
    const control = await connectedWifi()
    state.ble.connect.mockImplementationOnce(async () => false)
    expect(await control.connect('ble')).toBe(false)
    await nextTick()
    expect(control.kind.value).toBe('wifi')
    expect(control.connected.value).toBe(true)
    expect(state.media.inserted.value).toBe(true)
    expect(state.media.connect).not.toHaveBeenCalled()
    expect(state.media.disconnect).not.toHaveBeenCalled()
  })

  it('waits for a pending Bluetooth picker before choosing a Wi-Fi fallback', async () => {
    const control = await connectedWifi()
    let finishPicker!: (connected: boolean) => void
    state.ble.connect.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishPicker = resolve
        }),
    )
    const selection = control.connect('ble')
    await vi.waitFor(() => expect(state.ble.connect).toHaveBeenCalledOnce())
    expect(control.kind.value).toBe('ble')
    expect(control.connected.value).toBe(false)
    // Reconnection can complete while the browser's Bluetooth picker is open.
    state.media.connected.value = false
    state.media.connected.value = true
    await nextTick()
    expect(control.kind.value).toBe('ble')
    finishPicker(false)
    expect(await selection).toBe(false)
    expect(control.kind.value).toBe('wifi')
    expect(control.connected.value).toBe(true)
    expect(state.media.inserted.value).toBe(true)
    expect(state.media.connect).not.toHaveBeenCalled()
    expect(state.media.disconnect).not.toHaveBeenCalled()
  })

  it('keeps a successful Bluetooth selection after the picker finishes', async () => {
    const control = await connectedWifi()
    let finishPicker!: (connected: boolean) => void
    state.ble.connect.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishPicker = resolve
        }),
    )
    const selection = control.connect('ble')
    await vi.waitFor(() => expect(state.ble.connect).toHaveBeenCalledOnce())
    state.media.connected.value = false
    state.media.connected.value = true
    state.ble.connected.value = true
    finishPicker(true)
    expect(await selection).toBe(true)
    expect(control.kind.value).toBe('ble')
    expect(control.connected.value).toBe(true)
    expect(state.media.connected.value).toBe(true)
    expect(state.media.inserted.value).toBe(true)
    expect(state.media.connect).not.toHaveBeenCalled()
    expect(state.media.disconnect).not.toHaveBeenCalled()
  })

  it('keeps an explicit control pause until a new media session connects', async () => {
    const control = await connectedWifi()
    expect(await control.disconnect()).toBe(true)
    // Unrelated transport changes must not undo the user's pause.
    state.ble.connected.value = true
    state.ble.connected.value = false
    state.serial.connected.value = true
    state.serial.connected.value = false
    await nextTick()
    const second = (await import('../app/composables/useLink')).useLink()
    expect(control.connected.value).toBe(false)
    expect(second.connected.value).toBe(false)
    expect(state.media.connected.value).toBe(true)
    expect(state.media.inserted.value).toBe(true)
    expect(state.media.releaseHid).toHaveBeenCalledOnce()
    state.media.connected.value = false
    state.media.connected.value = true
    await nextTick()
    expect(control.kind.value).toBe('wifi')
    expect(control.connected.value).toBe(true)
    expect(second.connected.value).toBe(true)
    expect(state.media.connect).not.toHaveBeenCalled()
    expect(state.media.disconnect).not.toHaveBeenCalled()
    expect(state.media.releaseHid).toHaveBeenCalledOnce()
  })
})
