// SPDX-License-Identifier: GPL-3.0-or-later
import { frame } from './ch9329'
import type { SendResult } from '../composables/useSerialLink'
export const WIFI_CMD = {
  GET: 0x35,
  STAGE: 0x36,
  APPLY: 0x37,
  STATUS: 0x38,
} as const
export const WIFI_FIELD = {
  MODE: 1,
  AP_SSID: 2,
  AP_PASSWORD: 3,
  STA_SSID: 4,
  STA_PASSWORD: 5,
  TOKEN: 6,
  RECOVERY: 7,
} as const
export type WifiMode = 0 | 1 | 2
export interface WifiConfig {
  mode: WifiMode
  recovery: boolean
  apSsid: string
  staSsid: string
  apPasswordSet: boolean
  staPasswordSet: boolean
  tokenSet: boolean
  pending: boolean
}
export interface WifiStatus {
  mode: WifiMode
  state: number
  pending: boolean
  apIp: string
  clientIp: string
  retries: number
  reason: number
  error: number
}
export interface WifiChanges {
  mode: WifiMode
  recovery: boolean
  apSsid: string
  staSsid: string
  apPassword?: string
  staPassword?: string
  token?: string
}
const encode = new TextEncoder(),
  decode = new TextDecoder()
function ssid(value: string, required: boolean) {
  const n = encode.encode(value).length
  if (n > 32 || (required && !n) || /[\x00-\x1f]/.test(value))
    throw new Error(
      'Network names must contain 1–32 UTF-8 bytes, without control characters.',
    )
}
export function validateWifi(c: WifiChanges) {
  if (![0, 1, 2].includes(c.mode))
    throw new Error('Select Wi-Fi off, hotspot, or Client mode.')
  ssid(c.apSsid, true)
  ssid(c.staSsid, c.mode === 2)
  for (const [name, password] of [
    ['Hotspot', c.apPassword],
    ['Client', c.staPassword],
  ] as const)
    if (
      password !== undefined &&
      !/^[\x20-\x7e]{8,63}$/.test(password)
    )
      throw new Error(
        `${name} password must be 8–63 printable ASCII characters.`,
      )
  if (c.token !== undefined && !/^[\x21-\x7e]{16,80}$/.test(c.token))
    throw new Error(
      'Helper token must be 16–80 printable ASCII characters without spaces.',
    )
}
export class WifiClient {
  constructor(
    private send: (frame: Uint8Array, cmd: number) => Promise<SendResult>,
  ) {}
  private async request(cmd: number, data: number[] = []) {
    const r = await this.send(frame(cmd, data), cmd)
    if (!r.ok || !r.payload)
      throw new Error(
        r.payload?.[0] === 0xe3
          ? 'This firmware has no Wi-Fi settings interface. Install the updated firmware first.'
          : r.timeout
            ? 'Wi-Fi command timed out. Reconnect the control link and reload settings.'
            : 'Wi-Fi settings were rejected. Eject media, wait for any network change, and check the settings. They were not applied.',
      )
    return r.payload
  }
  async field(field: number) {
    let offset = 0,
      total = 0
    const chunks: number[] = []
    do {
      const p = await this.request(WIFI_CMD.GET, [1, field, offset])
      const max =
        field === WIFI_FIELD.TOKEN
          ? 80
          : field === WIFI_FIELD.AP_PASSWORD
            ? 63
            : 32
      if (
        p.length < 4 ||
        p[0] !== 1 ||
        p[1] !== field ||
        p[2]! > max ||
        p[3] !== offset ||
        (offset && p[2] !== total) ||
        p.length - 4 > p[2]! - offset
      )
        throw new Error('Invalid Wi-Fi settings response.')
      total = p[2]!
      const data = p.subarray(4)
      if (!data.length && offset < total)
        throw new Error('Incomplete Wi-Fi settings response.')
      chunks.push(...data)
      offset += data.length
    } while (offset < total)
    return decode.decode(new Uint8Array(chunks))
  }
  async ready(): Promise<WifiConfig> {
    const deadline = Date.now() + 5000
    for (;;) {
      try {
        return await this.config()
      } catch (e) {
        if (
          Date.now() >= deadline ||
          (e as Error).message.includes('has no Wi-Fi settings')
        )
          throw e
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  }
  async config(): Promise<WifiConfig> {
    const p = await this.request(WIFI_CMD.GET)
    if (p.length !== 8 || p[0] !== 1 || p[1] !== 1 || p[2]! > 2)
      throw new Error('Unsupported Wi-Fi configuration version.')
    return {
      mode: p[2] as WifiMode,
      recovery: !!p[3],
      apPasswordSet: !!p[4],
      staPasswordSet: !!p[5],
      tokenSet: !!p[6],
      pending: !!p[7],
      apSsid: await this.field(WIFI_FIELD.AP_SSID),
      staSsid: await this.field(WIFI_FIELD.STA_SSID),
    }
  }
  async status(): Promise<WifiStatus> {
    const p = await this.request(WIFI_CMD.STATUS)
    if (p.length !== 19 || p[0] !== 1 || p[1]! > 2 || p[2]! > 4)
      throw new Error('Invalid Wi-Fi status response.')
    const ip = (at: number) =>
      [...p.subarray(at, at + 4)].some(Boolean)
        ? [...p.subarray(at, at + 4)].join('.')
        : ''
    return {
      mode: p[1] as WifiMode,
      state: p[2]!,
      pending: !!p[3],
      apIp: ip(4),
      clientIp: ip(8),
      retries: p[12]!,
      reason: p[13]! | (p[14]! << 8),
      error: new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(
        15,
        true,
      ),
    }
  }
  async apply(c: WifiChanges) {
    validateWifi(c)
    const begin = await this.request(WIFI_CMD.STAGE, [1, 0])
    if (
      begin.length !== 5 ||
      begin[0] !== 1 ||
      !new DataView(begin.buffer, begin.byteOffset, begin.byteLength).getUint32(
        1,
        true,
      )
    )
      throw new Error('Invalid Wi-Fi configuration transaction.')
    const id = [...begin.subarray(1)],
      fields: [number, Uint8Array][] = [
        [WIFI_FIELD.MODE, new Uint8Array([c.mode])],
        [WIFI_FIELD.RECOVERY, new Uint8Array([+c.recovery])],
        [WIFI_FIELD.AP_SSID, encode.encode(c.apSsid)],
        [WIFI_FIELD.STA_SSID, encode.encode(c.staSsid)],
      ]
    if (c.apPassword !== undefined)
      fields.push([WIFI_FIELD.AP_PASSWORD, encode.encode(c.apPassword)])
    if (c.staPassword !== undefined)
      fields.push([WIFI_FIELD.STA_PASSWORD, encode.encode(c.staPassword)])
    if (c.token !== undefined)
      fields.push([WIFI_FIELD.TOKEN, encode.encode(c.token)])
    for (const [field, data] of fields) {
      if (!data.length)
        await this.request(WIFI_CMD.STAGE, [1, field, ...id, 0, 0])
      for (let at = 0; at < data.length; at += 56)
        await this.request(WIFI_CMD.STAGE, [
          1,
          field,
          ...id,
          at,
          data.length,
          ...data.subarray(at, at + 56),
        ])
    }
    await this.request(WIFI_CMD.APPLY, [1, ...id])
  }
}
