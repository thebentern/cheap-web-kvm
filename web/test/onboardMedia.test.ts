// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  addresses: [] as string[],
  close: vi.fn(),
  connections: [] as any[],
}))
vi.mock('../app/composables/useSerialLink', () => ({
  useSerialLink: () => ({ connected: { value: false } }),
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
      state.addresses.push(address)
    }
    close() {
      state.close()
    }
  },
}))
const TOKEN = 'device-token-at-least-16-characters'
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
  let authenticated = false,
    acceptToken = true,
    allowCookies = true
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/device/info') {
      if (initialInfoFailures-- > 0)
        throw new DOMException('Timed out', 'TimeoutError')
      return onboard
        ? json({ device: true, authenticated, httpsPort: 443 })
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
