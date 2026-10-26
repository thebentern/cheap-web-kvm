// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, shallowRef } from 'vue'
import {
  HOSTED_FIRMWARE,
  probeDeviceHost,
  type DeviceHostInfo,
} from '~/utils/deviceHost'

const info = shallowRef<DeviceHostInfo | null>(null)
let probe: Promise<DeviceHostInfo | null> | null = null
function refresh() {
  if (!probe)
    probe = probeDeviceHost()
      .then((current) => {
        if (current) info.value = current
        return current
      })
      .finally(() => {
        probe = null
      })
  return probe
}
function initialize() {
  // A successful identity is stable. A failed/ordinary-host probe must remain
  // retryable when the user opens media or chooses Wi-Fi after startup.
  return info.value ? Promise.resolve(info.value) : refresh()
}
export function useDeviceHost() {
  return {
    info,
    onboard: computed(() => info.value?.device === true),
    firmwareUrl: computed(() => (info.value ? HOSTED_FIRMWARE : '/flash')),
    initialize,
    refresh,
  }
}
