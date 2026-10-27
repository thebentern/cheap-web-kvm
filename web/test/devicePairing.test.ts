// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPhysicalPairingToken } from '../app/utils/devicePairing'
import { WIFI_FIELD } from '../app/utils/wifi'

const FINGERPRINT = 'ab'.repeat(32)
function setup() {
  const client = {
    ready: vi.fn(async () => ({
      mode: 2 as const,
      recovery: true,
      apSsid: 'Recovery',
      staSsid: 'Client',
      apPasswordSet: true,
      staPasswordSet: true,
      tokenSet: true,
      pending: false,
    })),
    certificateFingerprint: vi.fn(async () => FINGERPRINT),
    field: vi.fn(async () => 'synthetic-token-at-least-16-characters'),
  }
  const identify = vi.fn(async () => ({
    device: true as const,
    authenticated: false,
    httpsPort: 443,
    certificateFingerprint: FINGERPRINT,
  }))
  return { client, identify }
}
afterEach(() => vi.useRealTimers())

describe('physical board identity before browser pairing', () => {
  it('reads the token only after firmware readiness and a matching HTTPS fingerprint', async () => {
    const { client, identify } = setup()
    await expect(readPhysicalPairingToken(client, identify)).resolves.toBe(
      'synthetic-token-at-least-16-characters',
    )
    expect(client.ready.mock.invocationCallOrder[0]).toBeLessThan(
      client.certificateFingerprint.mock.invocationCallOrder[0]!,
    )
    expect(
      client.certificateFingerprint.mock.invocationCallOrder[0],
    ).toBeLessThan(identify.mock.invocationCallOrder[0]!)
    expect(identify.mock.invocationCallOrder[0]).toBeLessThan(
      client.field.mock.invocationCallOrder[0]!,
    )
    expect(client.field.mock.invocationCallOrder[0]).toBeLessThan(
      client.certificateFingerprint.mock.invocationCallOrder[1]!,
    )
    expect(client.field).toHaveBeenCalledExactlyOnceWith(WIFI_FIELD.TOKEN)
  })
  it('refuses missing or mismatched HTTPS identity without requesting the token', async () => {
    for (const fingerprint of ['', 'cd'.repeat(32)]) {
      const { client, identify } = setup()
      identify.mockResolvedValue({
        device: true,
        authenticated: false,
        httpsPort: 443,
        certificateFingerprint: fingerprint,
      })
      await expect(readPhysicalPairingToken(client, identify)).rejects.toThrow(
        fingerprint ? /does not match/ : /manually/,
      )
      expect(client.field).not.toHaveBeenCalled()
    }
  })
  it('retries a certificate still being prepared after USB startup', async () => {
    vi.useFakeTimers()
    const { client, identify } = setup()
    client.certificateFingerprint.mockRejectedValueOnce(
      new Error('The board certificate is not ready.'),
    )
    const result = readPhysicalPairingToken(client, identify)
    await vi.advanceTimersByTimeAsync(250)
    await result
    expect(client.certificateFingerprint).toHaveBeenCalledTimes(3)
    expect(client.field).toHaveBeenCalledOnce()
  })
  it.each(['changed', 'unavailable'])(
    'does not return a token if the physical identity is %s after reading it',
    async (failure) => {
      const { client, identify } = setup()
      client.field.mockImplementation(async () => {
        if (failure === 'changed')
          client.certificateFingerprint.mockResolvedValue('cd'.repeat(32))
        else
          client.certificateFingerprint.mockRejectedValue(
            new Error('Physical link disconnected'),
          )
        return 'synthetic-token-from-replaced-link'
      })
      await expect(readPhysicalPairingToken(client, identify)).rejects.toThrow(
        failure === 'changed' ? /changed while pairing/ : /disconnected/,
      )
      expect(client.field).toHaveBeenCalledOnce()
    },
  )
  it('bounds certificate startup retries and does not hide other control failures', async () => {
    vi.useFakeTimers()
    const { client, identify } = setup()
    client.certificateFingerprint.mockRejectedValue(
      new Error('The board certificate is not ready.'),
    )
    const rejected = expect(
      readPhysicalPairingToken(client, identify),
    ).rejects.toThrow(/not ready/)
    await vi.advanceTimersByTimeAsync(5250)
    await rejected
    expect(client.certificateFingerprint.mock.calls.length).toBeLessThanOrEqual(
      21,
    )
    expect(client.field).not.toHaveBeenCalled()
    expect(identify).not.toHaveBeenCalled()
    client.certificateFingerprint
      .mockReset()
      .mockRejectedValue(new Error('Unsupported firmware'))
    await expect(readPhysicalPairingToken(client, identify)).rejects.toThrow(
      /Unsupported/,
    )
    expect(client.certificateFingerprint).toHaveBeenCalledOnce()
  })
})
