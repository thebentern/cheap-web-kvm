// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  addresses: [] as string[],
  close: vi.fn(),
  connections: [] as any[],
  events: [] as string[],
  token: '',
  physicalFingerprint: '',
  httpsFingerprint: undefined as string | undefined,
  cancelUsb: false,
  cancelBluetooth: false,
  mediaFailure: '',
  switchBoardDuringTokenRead: false,
  serial: {
    supported: { value: true },
    connected: { value: false },
    lastError: { value: null as string | null },
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendAndWait: vi.fn(),
  },
  ble: {
    supported: { value: true },
    connected: { value: false },
    lastError: { value: null as string | null },
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendAndWait: vi.fn(),
  },
}))
vi.mock('../app/composables/useSerialLink', () => ({
  useSerialLink: () => state.serial,
}))
vi.mock('../app/composables/useBleLink', () => ({
  useBleLink: () => state.ble,
}))
vi.mock('../app/utils/media/client', () => ({
  MediaConnection: class {
    onActivity = (_bytes: number, _write: boolean) => {}
    onReadResponse = (_stats: unknown) => {}
    constructor() {
      state.connections.push(this)
    }
    resetReadStats() {
      this.onReadResponse({ requests: 0, totalMs: 0, maxMs: 0 })
    }
    async request() {}
    async connect(address: string) {
      state.events.push('wss:connect')
      if (state.mediaFailure) throw new Error(state.mediaFailure)
      state.addresses.push(address)
    }
    close() {
      state.close()
    }
  },
}))
const TOKEN = 'device-token-at-least-16-characters'
const FINGERPRINT = 'ab'.repeat(32)
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  })
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function setup(onboard = true, initialInfoFailures = 0) {
  vi.resetModules()
  state.addresses = []
  state.connections = []
  state.close.mockClear()
  state.events = []
  state.token = TOKEN
  state.physicalFingerprint = FINGERPRINT
  state.httpsFingerprint = FINGERPRINT
  state.cancelUsb = false
  state.cancelBluetooth = false
  state.mediaFailure = ''
  state.switchBoardDuringTokenRead = false
  for (const [kind, physical] of [
    ['usb', state.serial],
    ['bluetooth', state.ble],
  ] as const) {
    physical.connected.value = false
    physical.supported.value = true
    physical.lastError.value = null
    physical.disconnect.mockReset()
    physical.connect.mockReset().mockImplementation(async () => {
      state.events.push(`${kind}:connect`)
      if (kind === 'usb' ? state.cancelUsb : state.cancelBluetooth) return false
      physical.connected.value = true
      return true
    })
    physical.sendAndWait
      .mockReset()
      .mockImplementation(async (f: Uint8Array, cmd: number) => {
        expect(cmd).toBe(0x35) // Pairing only reads; it never changes board settings.
        if (!f[4])
          return {
            ok: true,
            timeout: false,
            payload: new Uint8Array([1, 1, 2, 1, 1, 1, 1, 0]),
          }
        const field = f[6]!,
          offset = f[7]!
        state.events.push(`${kind}:field:${field}:${offset}`)
        const value =
          field === 0x80
            ? state.physicalFingerprint
            : field === 6
              ? state.token
              : field === 2
                ? 'Recovery'
                : 'Client network'
        if (field === 6 && state.switchBoardDuringTokenRead)
          state.physicalFingerprint = 'cd'.repeat(32)
        return {
          ok: true,
          timeout: false,
          payload: new Uint8Array([
            1,
            field,
            value.length,
            offset,
            ...new TextEncoder().encode(value.slice(offset, offset + 60)),
          ]),
        }
      })
  }
  let authenticated = false,
    acceptToken = true,
    allowCookies = true
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    state.events.push(`https:${path}`)
    if (path === '/device/info') {
      if (initialInfoFailures-- > 0)
        throw new DOMException('Timed out', 'TimeoutError')
      return onboard
        ? json({
            device: true,
            authenticated,
            httpsPort: 443,
            certificateFingerprint: state.httpsFingerprint,
          })
        : new Response(null, { status: 404 })
    }
    if (path === '/device/session') {
      if (!acceptToken) return new Response(null, { status: 401 })
      if (allowCookies) authenticated = true
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected path ${path}`)
  })
  class Worker {
    onmessage?: (event: { data: unknown }) => void
    postMessage(message: { id: number; method: string }) {
      if (!['saved', 'insert', 'eject'].includes(message.method))
        throw new Error(`Unexpected worker operation ${message.method}`)
      queueMicrotask(() =>
        this.onmessage?.({ data: { id: message.id, value: [] } }),
      )
    }
  }
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('Worker', Worker)
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('location', { protocol: 'https:', host: 'kvm.local' })
  vi.stubGlobal('navigator', { storage: { persisted: async () => false } })
  vi.stubGlobal('window', { addEventListener: vi.fn() })
  const listeners = new Map<string, () => void>()
  const document = {
    hidden: false,
    addEventListener: vi.fn((event: string, listener: () => void) =>
      listeners.set(event, listener),
    ),
    createElement: () => ({}),
  }
  vi.stubGlobal('document', document)
  const media = (
    await import('../app/composables/useVirtualMedia')
  ).useVirtualMedia()
  await media.initialize()
  return {
    media,
    fetch,
    hide: () => {
      document.hidden = true
      listeners.get('visibilitychange')?.()
    },
    expire: () => {
      authenticated = false
    },
    rejectToken: () => {
      acceptToken = false
    },
    blockCookies: () => {
      allowCookies = false
    },
  }
}

describe('direct on-board media connection', () => {
  it('defaults to Wi-Fi, pairs over HTTPS, clears the token and connects to the same board', async () => {
    const { media, fetch } = await setup()
    expect(media.transport.value).toBe('wifi')
    expect(media.onboard.value).toBe(true)
    media.boardToken.value = TOKEN
    await media.connect()
    expect(media.connected.value).toBe(true)
    expect(media.boardToken.value).toBe('')
    expect(media.deviceInfo.value?.authenticated).toBe(true)
    expect(state.addresses).toEqual(['wss://kvm.local/media'])
    const session = fetch.mock.calls.find(
      ([path]) => path === '/device/session',
    )
    expect(session?.[1]?.body).toBe(JSON.stringify({ token: TOKEN }))
    expect(session?.[1]?.credentials).toBe('same-origin')
  })

  it('preserves an explicit USB choice on panel reopen', async () => {
    const { media } = await setup()
    media.transport.value = 'usb'
    await media.initialize()
    expect(media.transport.value).toBe('usb')
  })
  it('preserves the disconnect reason when the media panel reopens or the tab is hidden', async () => {
    const { media, hide } = await setup()
    media.boardToken.value = TOKEN
    await media.connect()
    media.inserted.value = true
    const reason = 'Media connection lost. Eject the target before recovery.'
    state.connections.at(-1)!.onError(reason)
    expect(media.connected.value).toBe(false)
    expect(media.uncertain.value).toBe(true)
    await media.initialize()
    expect(media.error.value).toBe(reason)
    hide()
    expect(media.error.value).toBe(reason)
    expect(media.uncertain.value).toBe(true)
  })
  it('shows recent read speed, clears it while idle, and stops sampling on ejection', async () => {
    vi.useFakeTimers()
    const { media } = await setup()
    media.boardToken.value = TOKEN
    await media.connect()
    media.meta.value = {
      id: 'test-disk',
      kind: 'boot',
      name: 'test.img',
      size: 1048576,
      revision: 0,
      exportedRevision: 0,
      created: '',
    }
    await media.insert()
    expect(media.error.value).toBe(null)
    const connection = state.connections.at(-1)!
    connection.onActivity(8192, false)
    connection.onReadResponse({ requests: 1, totalMs: 3, maxMs: 3 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(media.activity.rate).toBe(8192)
    expect(media.activity.readRequests).toBe(1)
    expect(media.activity.readTotalMs).toBe(3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(media.activity.rate).toBe(0)
    connection.onActivity(8192, true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(media.activity.rate).toBe(0)
    connection.onActivity(4096, false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(media.activity.rate).toBe(4096)
    await media.eject(false)
    expect(media.inserted.value).toBe(false)
    expect(media.activity.rate).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('recovers a failed startup probe when Wi-Fi is selected and requires pairing before WSS', async () => {
    const { media } = await setup(true, 1)
    expect(media.onboard.value).toBe(false)
    expect(media.transport.value).toBe('usb')
    await media.selectTransport('wifi')
    expect(media.onboard.value).toBe(true)
    expect(media.deviceInfo.value?.authenticated).toBe(false)
    await media.connect()
    expect(media.connected.value).toBe(false)
    expect(media.error.value).toMatch(/access token/)
    expect(state.addresses).toHaveLength(0)
    media.boardToken.value = TOKEN
    await media.connect()
    expect(media.connected.value).toBe(true)
    expect(state.addresses).toEqual(['wss://kvm.local/media'])
  })
  it('rechecks an unknown host on Connect and preserves explicit USB after late identification', async () => {
    const direct = await setup(true, 1)
    direct.media.transport.value = 'wifi'
    await direct.media.connect()
    expect(direct.media.onboard.value).toBe(true)
    expect(direct.media.error.value).toMatch(/access token/)
    expect(state.addresses).toHaveLength(0)
    const explicit = await setup(true, 1)
    await explicit.media.selectTransport('usb')
    await explicit.media.initialize()
    expect(explicit.media.onboard.value).toBe(true)
    expect(explicit.media.transport.value).toBe('usb')
  })
  it('explains certificate trust when browser storage is blocked', async () => {
    const { media } = await setup()
    vi.stubGlobal('isSecureContext', false)
    vi.stubGlobal('navigator', {})
    await media.initialize()
    expect(media.error.value).toMatch(/Trust this board’s certificate/)
  })

  it('rechecks a session on connect and requests the token again after expiry', async () => {
    const { media, fetch, expire } = await setup()
    media.boardToken.value = TOKEN
    await media.connect()
    await media.disconnect()
    await media.connect()
    expect(media.connected.value).toBe(true)
    expect(
      fetch.mock.calls.filter(([path]) => path === '/device/session'),
    ).toHaveLength(1)
    await media.disconnect()
    expire()
    await media.connect()
    expect(media.connected.value).toBe(false)
    expect(media.deviceInfo.value?.authenticated).toBe(false)
    expect(media.error.value).toMatch(/access token/)
    expect(state.addresses).toHaveLength(2)
  })

  it('does not open a media connection when credentials are rejected or cookies cannot persist', async () => {
    const invalid = await setup()
    invalid.rejectToken()
    invalid.media.boardToken.value = TOKEN
    await invalid.media.connect()
    expect(invalid.media.connected.value).toBe(false)
    expect(invalid.media.boardToken.value).toBe('')
    expect(invalid.media.error.value).toMatch(/not accepted/)
    expect(state.addresses).toHaveLength(0)

    const blocked = await setup()
    blocked.blockCookies()
    blocked.media.boardToken.value = TOKEN
    await blocked.media.connect()
    expect(blocked.media.connected.value).toBe(false)
    expect(blocked.media.error.value).toMatch(/Allow cookies/)
    expect(state.addresses).toHaveLength(0)
  })

  it('keeps existing USB defaults and helper connections for ordinary hosted pages', async () => {
    const { media, fetch } = await setup(false)
    expect(media.transport.value).toBe('usb')
    media.transport.value = 'wifi'
    media.url.value = 'wss://helper.example/media'
    await media.connect()
    expect(media.connected.value).toBe(true)
    expect(state.addresses).toEqual(['wss://helper.example/media'])
    expect(
      fetch.mock.calls.filter(([path]) => path === '/device/session'),
    ).toHaveLength(0)
  })
})

describe('pair and connect through a physical control link', () => {
  it('starts the USB chooser before HTTPS, verifies identity, reads a paged token and connects Wi-Fi', async () => {
    const { media, fetch } = await setup()
    state.token = 't'.repeat(80)
    media.boardToken.value = 'unused-manual-token-at-least-16-characters'
    state.events = []
    const paired = media.pairWithUsb()
    expect(state.events[0]).toBe('usb:connect')
    await paired
    expect(media.error.value).toBe(null)
    expect(media.connected.value).toBe(true)
    expect(media.transport.value).toBe('wifi')
    expect(media.boardToken.value).toBe('')
    expect(
      state.events.filter((event) => event.startsWith('usb:field:6:')),
    ).toEqual(['usb:field:6:0', 'usb:field:6:60'])
    expect(state.events.indexOf('usb:field:128:60')).toBeLessThan(
      state.events.indexOf('https:/device/info'),
    )
    expect(state.events.indexOf('https:/device/info')).toBeLessThan(
      state.events.indexOf('usb:field:6:0'),
    )
    expect(state.events.indexOf('https:/device/session')).toBeLessThan(
      state.events.indexOf('wss:connect'),
    )
    expect(
      fetch.mock.calls.find(([path]) => path === '/device/session')?.[1]?.body,
    ).toBe(JSON.stringify({ token: state.token }))
    expect(state.addresses).toEqual(['wss://kvm.local/media'])
    expect(state.serial.connected.value).toBe(true)
    expect(state.serial.disconnect).not.toHaveBeenCalled()
  })
  it('reuses an open USB port without reopening, changing its baud or disconnecting it', async () => {
    const { media } = await setup()
    state.serial.connected.value = true
    await media.pairWithUsb()
    expect(media.connected.value).toBe(true)
    expect(state.serial.connect).not.toHaveBeenCalled()
    expect(state.serial.disconnect).not.toHaveBeenCalled()
  })
  it.each([false, true])(
    'pairs over Bluetooth and preserves the physical link (already connected: %s)',
    async (reused) => {
      const { media } = await setup()
      state.ble.connected.value = reused
      await media.pairWithBluetooth()
      expect(media.connected.value).toBe(true)
      expect(state.ble.connect).toHaveBeenCalledTimes(reused ? 0 : 1)
      expect(state.ble.connected.value).toBe(true)
      expect(state.ble.disconnect).not.toHaveBeenCalled()
      expect(state.serial.connect).not.toHaveBeenCalled()
    },
  )
  it.each(['usb', 'bluetooth'] as const)(
    'does not authenticate when %s is unsupported or its chooser is cancelled',
    async (kind) => {
      const unsupported = await setup()
      const physical = kind === 'usb' ? state.serial : state.ble
      physical.supported.value = false
      await (kind === 'usb'
        ? unsupported.media.pairWithUsb()
        : unsupported.media.pairWithBluetooth())
      expect(unsupported.media.error.value).toMatch(/not available/)
      expect(physical.connect).not.toHaveBeenCalled()
      expect(physical.sendAndWait).not.toHaveBeenCalled()
      expect(
        unsupported.fetch.mock.calls.some(
          ([path]) => path === '/device/session',
        ),
      ).toBe(false)

      const cancelled = await setup()
      if (kind === 'usb') state.cancelUsb = true
      else state.cancelBluetooth = true
      cancelled.media.boardToken.value = TOKEN
      await (kind === 'usb'
        ? cancelled.media.pairWithUsb()
        : cancelled.media.pairWithBluetooth())
      expect(cancelled.media.error.value).toMatch(/cancelled/)
      expect(cancelled.media.boardToken.value).toBe('')
      expect(state.addresses).toHaveLength(0)
      expect(
        cancelled.fetch.mock.calls.some(([path]) => path === '/device/session'),
      ).toBe(false)
    },
  )
  it.each(['mismatch', 'missing'] as const)(
    'does not read the token or authenticate when board identity is %s',
    async (failure) => {
      const { media, fetch } = await setup()
      if (failure === 'mismatch') state.physicalFingerprint = 'cd'.repeat(32)
      else state.httpsFingerprint = undefined
      await media.pairWithUsb()
      expect(media.error.value).toMatch(
        failure === 'mismatch' ? /does not match/ : /manually/,
      )
      expect(
        state.events.some((event) => event.startsWith('usb:field:6:')),
      ).toBe(false)
      expect(
        fetch.mock.calls.some(([path]) => path === '/device/session'),
      ).toBe(false)
      expect(state.addresses).toHaveLength(0)
      expect(state.serial.disconnect).not.toHaveBeenCalled()
    },
  )
  it.each(['credentials', 'cookies'] as const)(
    'does not open Wi-Fi media when pairing fails because of %s',
    async (failure) => {
      const current = await setup()
      if (failure === 'credentials') current.rejectToken()
      else current.blockCookies()
      current.media.boardToken.value = TOKEN
      await current.media.pairWithUsb()
      expect(current.media.error.value).toMatch(
        failure === 'credentials' ? /not accepted/ : /Allow cookies/,
      )
      expect(current.media.boardToken.value).toBe('')
      expect(current.media.connected.value).toBe(false)
      expect(state.addresses).toHaveLength(0)
      expect(state.serial.connected.value).toBe(true)
      expect(state.serial.disconnect).not.toHaveBeenCalled()
    },
  )
  it('does not submit a token if physical control changes boards during its read', async () => {
    const { media, fetch } = await setup()
    state.switchBoardDuringTokenRead = true
    media.boardToken.value = TOKEN
    await media.pairWithUsb()
    expect(media.error.value).toMatch(/changed while pairing/)
    expect(media.boardToken.value).toBe('')
    expect(fetch.mock.calls.some(([path]) => path === '/device/session')).toBe(
      false,
    )
    expect(state.addresses).toHaveLength(0)
    expect(state.serial.disconnect).not.toHaveBeenCalled()
  })
  it.each(['inserted', 'uncertain', 'busy'] as const)(
    'does not open physical control or pair while media is %s',
    async (lock) => {
      const { media, fetch } = await setup()
      media[lock].value = true
      await media.pairWithUsb()
      expect(state.serial.connect).not.toHaveBeenCalled()
      expect(state.serial.sendAndWait).not.toHaveBeenCalled()
      expect(
        fetch.mock.calls.some(([path]) => path === '/device/session'),
      ).toBe(false)
      expect(state.addresses).toHaveLength(0)
    },
  )
  it('requires the board’s trusted HTTPS page before opening a physical chooser', async () => {
    const ordinary = await setup(false)
    await ordinary.media.pairWithUsb()
    expect(ordinary.media.error.value).toMatch(/own HTTPS page/)
    expect(state.serial.connect).not.toHaveBeenCalled()
    const insecure = await setup()
    vi.stubGlobal('isSecureContext', false)
    await insecure.media.pairWithUsb()
    expect(insecure.media.error.value).toMatch(/trusted HTTPS/)
    expect(state.serial.connect).not.toHaveBeenCalled()
  })
  it('does not bypass media ownership when another backend refuses the Wi-Fi connection', async () => {
    const { media } = await setup()
    state.mediaFailure = 'Media already owned by another backend'
    await media.pairWithUsb()
    expect(media.error.value).toMatch(/already owned/)
    expect(media.connected.value).toBe(false)
    expect(state.addresses).toHaveLength(0)
    expect(state.serial.disconnect).not.toHaveBeenCalled()
  })
  it('does not authenticate after an unsupported physical settings response', async () => {
    const { media, fetch } = await setup()
    state.serial.sendAndWait.mockResolvedValue({
      ok: false,
      timeout: false,
      payload: new Uint8Array([0xe3]),
    })
    await media.pairWithUsb()
    expect(media.error.value).toMatch(/updated firmware/)
    expect(fetch.mock.calls.some(([path]) => path === '/device/session')).toBe(
      false,
    )
    expect(state.addresses).toHaveLength(0)
  })
})
