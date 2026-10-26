// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, ref } from 'vue'
import { useVirtualMedia } from '~/composables/useVirtualMedia'
import { useBleLink } from '~/composables/useBleLink'
import { useSerialLink, type SendResult } from '~/composables/useSerialLink'

/**
 * The HID link, over whichever transport is in use. Both carry identical
 * CH9329 frames, so everything above this is transport-blind; only connecting
 * differs. One transport is active at a time.
 */

export type LinkKind = 'serial' | 'ble' | 'wifi'

const kind = ref<LinkKind>('serial')
const wifiHidEnabled = ref(false)

export function useLink() {
  const serial = useSerialLink()
  const ble = useBleLink()
  const media = useVirtualMedia()
  const wifi = {
    connected: computed(() => media.connected.value && wifiHidEnabled.value), connecting: media.connecting,
    portLabel: computed(() => 'Wi-Fi media link'), lastError: media.error,
    connect: async () => { if (!media.connected.value) await media.connect(); wifiHidEnabled.value = media.connected.value; return media.connected.value },
    // Switching HID transport must not eject a disk owned by the media panel.
    disconnect: async () => { await media.releaseHid(); wifiHidEnabled.value = false }, sendAndWait: media.sendAndWait,
  }
  const active = computed(() => (kind.value === 'wifi' ? wifi : kind.value === 'ble' ? ble : serial))

  async function connect(which: LinkKind) {
    if (active.value.connected.value) await active.value.disconnect()
    kind.value = which
    return active.value.connect()
  }

  return {
    kind,
    serialSupported: serial.supported,
    bleSupported: ble.supported,
    wifiAvailable: media.connected,
    supported: computed(() => serial.supported.value || ble.supported.value || media.connected.value),
    connected: computed(() => active.value.connected.value),
    connecting: computed(() => active.value.connecting.value),
    portLabel: computed(() => active.value.portLabel.value),
    lastError: computed(() => active.value.lastError.value),
    connect,
    disconnect: () => active.value.disconnect(),
    sendAndWait: (frame: Uint8Array, cmd: number): Promise<SendResult> =>
      active.value.sendAndWait(frame, cmd),
  }
}
