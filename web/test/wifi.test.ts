// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest'
import {
  WifiClient,
  WIFI_CMD,
  WIFI_FIELD,
  validateWifi,
  type WifiChanges,
} from '../app/utils/wifi'
const config = (): WifiChanges => ({
  mode: 2,
  recovery: true,
  apSsid: 'Recovery',
  staSsid: 'Router',
  apPassword: 'new-ap-password',
  staPassword: 'router-password',
  token: '0123456789abcdef0123456789abcdef',
})
describe('Wi-Fi settings protocol', () => {
  it('stages long credentials in bounded frames and commits only after all fields succeed', async () => {
    const sent: Uint8Array[] = []
    const client = new WifiClient(async (f, cmd) => {
      sent.push(f)
      return {
        ok: true,
        timeout: false,
        payload:
          cmd === WIFI_CMD.STAGE && f[6] === 0
            ? new Uint8Array([1, 0x78, 0x56, 0x34, 0x12])
            : new Uint8Array([0]),
      }
    })
    const c = config()
    c.staPassword = 'p'.repeat(63)
    c.token = 't'.repeat(80)
    await client.apply(c)
    expect(sent.every((f) => f[4]! <= 64)).toBe(true)
    expect(sent[0]!.slice(5, 7)).toEqual(new Uint8Array([1, 0]))
    const password = sent.filter(
      (f) => f[3] === WIFI_CMD.STAGE && f[6] === WIFI_FIELD.STA_PASSWORD,
    )
    expect(password.map((f) => [f[11], f[12], f[4]! - 8])).toEqual([
      [0, 63, 56],
      [56, 63, 7],
    ])
    const token = sent.filter(
      (f) => f[3] === WIFI_CMD.STAGE && f[6] === WIFI_FIELD.TOKEN,
    )
    expect(token.map((f) => f[11])).toEqual([0, 56])
    expect(sent.at(-1)![3]).toBe(WIFI_CMD.APPLY)
    expect([...sent.at(-1)!.slice(5, 10)]).toEqual([1, 0x78, 0x56, 0x34, 0x12])
  })
  it('preserves omitted passwords, explicitly clears an open-client password, and never commits rejected chunks', async () => {
    const sent: Uint8Array[] = []
    const client = new WifiClient(async (f, cmd) => {
      sent.push(f)
      return {
        ok: true,
        timeout: false,
        payload:
          cmd === WIFI_CMD.STAGE && f[6] === 0
            ? new Uint8Array([1, 1, 2, 3, 4])
            : new Uint8Array([0]),
      }
    })
    const c = config()
    delete c.apPassword
    delete c.token
    c.staPassword = ''
    await client.apply(c)
    expect(
      sent.some(
        (f) => f[3] === WIFI_CMD.STAGE && f[6] === WIFI_FIELD.AP_PASSWORD,
      ),
    ).toBe(false)
    expect(
      sent.some(
        (f) => f[6] === WIFI_FIELD.STA_PASSWORD && f[4] === 8 && f[12] === 0,
      ),
    ).toBe(true)
    let committed = false
    const bad = new WifiClient(async (f, cmd) => {
      if (cmd === WIFI_CMD.APPLY) committed = true
      return {
        ok: cmd === WIFI_CMD.STAGE && f[6] === 0,
        timeout: false,
        payload: new Uint8Array([1, 1, 2, 3, 4]),
      }
    })
    await expect(bad.apply(config())).rejects.toThrow(/rejected/)
    expect(committed).toBe(false)
  })
  it('reads paged tokens, decodes router/hotspot IPs, and detects unsupported firmware', async () => {
    const token = 'a'.repeat(80)
    const client = new WifiClient(async (f, cmd) => {
      const at = f[7] ?? 0
      return {
        ok: true,
        timeout: false,
        payload:
          cmd === WIFI_CMD.GET
            ? new Uint8Array([
                1,
                WIFI_FIELD.TOKEN,
                80,
                at,
                ...new TextEncoder().encode(token.slice(at, at + 60)),
              ])
            : new Uint8Array([
                1, 2, 3, 0, 192, 168, 4, 1, 10, 0, 0, 25, 0, 0, 0, 0, 0, 0, 0,
              ]),
      }
    })
    expect(await client.field(WIFI_FIELD.TOKEN)).toBe(token)
    expect(await client.status()).toMatchObject({
      mode: 2,
      state: 3,
      apIp: '192.168.4.1',
      clientIp: '10.0.0.25',
    })
    const old = new WifiClient(async () => ({
      ok: false,
      timeout: false,
      payload: new Uint8Array([0xe3]),
    }))
    await expect(old.config()).rejects.toThrow(/updated firmware/)
  })
  it('validates modes, UTF-8 SSID bounds, passwords and helper tokens', () => {
    validateWifi(config())
    validateWifi({ ...config(), staPassword: '' })
    for (const change of [
      { mode: 3 },
      { apSsid: '' },
      { staSsid: '' },
      { staSsid: '界'.repeat(11) },
      { apPassword: '' },
      { staPassword: 'short' },
      { token: 'short' },
      { token: 'a'.repeat(81) },
    ])
      expect(() =>
        validateWifi({ ...config(), ...change } as WifiChanges),
      ).toThrow()
    validateWifi({ ...config(), mode: 0, staSsid: '' })
    validateWifi({ ...config(), staSsid: 'a'.repeat(32) })
  })
})
