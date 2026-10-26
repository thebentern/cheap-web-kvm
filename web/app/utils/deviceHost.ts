// SPDX-License-Identifier: GPL-3.0-or-later
export interface DeviceHostInfo {
  device: true
  authenticated: boolean
  httpsPort: number
  certificateFingerprint?: string
  hostname?: string
}
export const HOSTED_APP = 'https://thebentern.github.io/cheap-web-kvm/'
export const HOSTED_FIRMWARE = `${HOSTED_APP}flash`

/** A failed probe is a normal hosted/helper deployment, never a login failure. */
export async function probeDeviceHost(): Promise<DeviceHostInfo | null> {
  try {
    const response = await fetch('/device/info', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    })
    if (
      !response.ok ||
      !response.headers.get('Content-Type')?.includes('application/json')
    )
      return null
    const info: unknown = await response.json()
    if (!info || typeof info !== 'object') return null
    const value = info as Record<string, unknown>
    if (
      value.device !== true ||
      typeof value.authenticated !== 'boolean' ||
      !Number.isInteger(value.httpsPort) ||
      (value.httpsPort as number) < 1 ||
      (value.httpsPort as number) > 65535
    )
      return null
    return {
      device: true,
      authenticated: value.authenticated,
      httpsPort: value.httpsPort as number,
      certificateFingerprint:
        typeof value.certificateFingerprint === 'string'
          ? value.certificateFingerprint
          : undefined,
      hostname: typeof value.hostname === 'string' ? value.hostname : undefined,
    }
  } catch {
    return null
  }
}

/** The token is submitted once over HTTPS; only an HttpOnly session cookie persists. */
export async function authenticateDevice(token: string): Promise<void> {
  if (!globalThis.isSecureContext || location.protocol !== 'https:')
    throw new Error(
      'Open the board over trusted HTTPS before connecting. Follow its certificate setup page.',
    )
  if (token.length < 16 || token.length > 80 || /[^\x21-\x7e]/.test(token))
    throw new Error(
      'Enter the board’s 16–80 character access token from Settings → Wi-Fi → Advanced.',
    )
  let response: Response
  try {
    response = await fetch('/device/session', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    throw new Error(
      'Cannot reach the board to pair. Check its Wi-Fi connection and trusted HTTPS page.',
    )
  }
  if (response.status === 401)
    throw new Error(
      'The board access token was not accepted. Check it in Settings → Wi-Fi → Advanced using USB or Bluetooth.',
    )
  if (!response.ok)
    throw new Error(
      'The board could not start a browser session. Reopen its HTTPS page and try again.',
    )
}
