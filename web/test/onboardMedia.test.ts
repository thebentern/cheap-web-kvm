// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  addresses: [] as string[],
  close: vi.fn(),
}))
vi.mock('../app/composables/useSerialLink', () => ({
  useSerialLink: () => ({ connected: { value: false } }),
}))
vi.mock('../app/utils/media/client', () => ({
  MediaConnection: class {
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
afterEach(() => vi.unstubAllGlobals())

async function setup(onboard = true) {
  vi.resetModules()
  state.addresses = []
  state.close.mockClear()
  let authenticated = false,
    acceptToken = true,
    allowCookies = true
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/device/info')
      return onboard
        ? json({ device: true, authenticated, httpsPort: 443 })
        : new Response(null, { status: 404 })
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
      if (message.method !== 'saved')
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
  vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    createElement: () => ({}),
  })
  const media = (
    await import('../app/composables/useVirtualMedia')
  ).useVirtualMedia()
  await media.initialize()
  return {
    media,
    fetch,
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
