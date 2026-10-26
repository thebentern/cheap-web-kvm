// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, shallowRef } from 'vue'
import {
  HOSTED_FIRMWARE,
  probeDeviceHost,
  type DeviceHostInfo,
} from '~/utils/deviceHost'

const info = shallowRef<DeviceHostInfo | null>(null)
let probe: Promise<DeviceHostInfo | null> | null = null
function initialize() {
  return (probe ??= probeDeviceHost().then((value) => {
    info.value = value
    return value
  }))
}
async function refresh() {
  const current = await probeDeviceHost()
  if (current) info.value = current
  return current
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
