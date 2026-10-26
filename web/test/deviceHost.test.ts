// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticateDevice, probeDeviceHost } from '../app/utils/deviceHost'

const TOKEN = 'board-token-with-at-least-16-characters'
afterEach(() => vi.unstubAllGlobals())
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
const identify = (authenticated = false) => ({
  device: true,
  authenticated,
  httpsPort: 443,
})
function secure() {
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('location', { protocol: 'https:' })
}

describe('on-board host detection and authentication', () => {
  it('recognizes only the expected public device metadata and sends existing cookies', async () => {
    const fetch = vi.fn(async () =>
      json({
        ...identify(),
        hostname: 'kvm.local',
        certificateFingerprint: 'ab'.repeat(32),
        token: 'must not propagate',
      }),
    )
    vi.stubGlobal('fetch', fetch)
    expect(await probeDeviceHost()).toEqual({
      ...identify(),
      hostname: 'kvm.local',
      certificateFingerprint: 'ab'.repeat(32),
    })
    expect(fetch).toHaveBeenCalledWith(
      '/device/info',
      expect.objectContaining({
        credentials: 'same-origin',
        cache: 'no-store',
      }),
    )
  })

  it('treats hosted pages, helper HTML, unavailable endpoints, and malformed metadata as ordinary hosts', async () => {
    for (const response of [
      new Response('not found', { status: 404 }),
      new Response('<!doctype html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
      json({ ...identify(), authenticated: 'false' }),
      json({ ...identify(), httpsPort: 0 }),
      json({ ...identify(), httpsPort: 65536 }),
      json({ ...identify(), httpsPort: 443.5 }),
      json({ ...identify(), device: false }),
      new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response),
      )
      expect(await probeDeviceHost()).toBeNull()
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    expect(await probeDeviceHost()).toBeNull()
  })

  it('submits a token only in the HTTPS request body and relies on a browser cookie', async () => {
    secure()
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    await authenticateDevice(TOKEN)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(
      '/device/session',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN }),
      }),
    )
    expect(fetch.mock.calls[0]![0]).not.toContain(TOKEN)
  })

  it('does not transmit a token over an insecure origin or untrusted context', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const [protocol, isSecureContext] of [
      ['http:', true],
      ['https:', false],
    ]) {
      vi.stubGlobal('location', { protocol })
      vi.stubGlobal('isSecureContext', isSecureContext)
      await expect(authenticateDevice(TOKEN)).rejects.toThrow(/trusted HTTPS/)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects malformed tokens before making a request', async () => {
    secure()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const token of [
      '',
      'short',
      'a'.repeat(81),
      'token with spaces in it',
      'token-with-a-newline\n',
    ])
      await expect(authenticateDevice(token)).rejects.toThrow(/16–80/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('distinguishes rejected credentials from other session errors without echoing the token', async () => {
    secure()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    )
    await expect(authenticateDevice(TOKEN)).rejects.toThrow(/not accepted/)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(TOKEN, { status: 403 })),
    )
    await expect(authenticateDevice(TOKEN)).rejects.toThrow(
      /could not start a browser session/,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('timeout')
      }),
    )
    await expect(authenticateDevice(TOKEN)).rejects.toThrow(
      /Cannot reach the board to pair/,
    )
  })

  it('probes once across UI consumers, while an explicit refresh updates cookie authentication', async () => {
    vi.resetModules()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(identify()))
      .mockResolvedValueOnce(json(identify(true)))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetch)
    const { useDeviceHost } = await import('../app/composables/useDeviceHost')
    const first = useDeviceHost(),
      second = useDeviceHost()
    await Promise.all([first.initialize(), second.initialize()])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(first.onboard.value).toBe(true)
    expect(first.firmwareUrl.value).toBe(
      'https://thebentern.github.io/cheap-web-kvm/flash',
    )
    await second.refresh()
    expect(first.info.value?.authenticated).toBe(true)
    expect(await first.refresh()).toBeNull()
    expect(first.onboard.value).toBe(true)
  })
})
