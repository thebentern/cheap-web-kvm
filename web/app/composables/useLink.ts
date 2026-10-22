// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, ref } from 'vue'
import { useBleLink } from '~/composables/useBleLink'
import { useSerialLink, type SendResult } from '~/composables/useSerialLink'

/**
 * The HID link, over whichever transport is in use. Both carry identical
 * CH9329 frames, so everything above this is transport-blind; only connecting
 * differs. One transport is active at a time.
 */

export type LinkKind = 'serial' | 'ble'

const kind = ref<LinkKind>('serial')

export function useLink() {
  const serial = useSerialLink()
  const ble = useBleLink()
  const active = computed(() => (kind.value === 'ble' ? ble : serial))

  async function connect(which: LinkKind) {
    if (active.value.connected.value) await active.value.disconnect()
    kind.value = which
    return active.value.connect()
  }

  return {
    kind,
    serialSupported: serial.supported,
    bleSupported: ble.supported,
    supported: computed(() => serial.supported.value || ble.supported.value),
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
