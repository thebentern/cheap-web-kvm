// SPDX-License-Identifier: GPL-3.0-or-later
import type { DeviceHostInfo } from './deviceHost'
import { WIFI_FIELD, type WifiClient } from './wifi'

/** Read the secret only after physical control and HTTPS identify the same board. */
export async function readPhysicalPairingToken(
  client: Pick<WifiClient, 'ready' | 'certificateFingerprint' | 'field'>,
  identify: () => Promise<DeviceHostInfo | null>,
) {
  await client.ready() // USB-open resets may need a bounded firmware startup wait.
  const deadline = Date.now() + 5000
  let fingerprint: string
  for (;;) {
    try {
      fingerprint = await client.certificateFingerprint()
      break
    } catch (error) {
      if (
        Date.now() >= deadline ||
        !/certificate is not ready/i.test((error as Error).message)
      )
        throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  const device = await identify()
  if (!device)
    throw new Error(
      'Cannot reach this board over HTTPS. Check its Wi-Fi connection and try pairing again.',
    )
  if (!/^[0-9a-f]{64}$/.test(device.certificateFingerprint ?? ''))
    throw new Error(
      'This board cannot confirm its identity for automatic pairing. Enter its access token manually instead.',
    )
  if (fingerprint !== device.certificateFingerprint)
    throw new Error(
      'The selected device does not match this HTTPS page. Choose the board serving this page, then try again.',
    )
  let token = ''
  try {
    token = await client.field(WIFI_FIELD.TOKEN)
    // A toolbar action can replace the physical singleton between commands.
    // Do not submit a token obtained after its original identity changed.
    if ((await client.certificateFingerprint()) !== fingerprint)
      throw new Error(
        'The selected device changed while pairing. Choose the board serving this page, then try again.',
      )
    return token
  } finally {
    token = ''
  }
}
