// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, effectScope, ref, watch } from 'vue'
import { useVirtualMedia } from '~/composables/useVirtualMedia'
import { useBleLink } from '~/composables/useBleLink'
import { useSerialLink, type SendResult } from '~/composables/useSerialLink'

/**
 * HID over USB serial, Bluetooth or the existing Wi-Fi media connection.
 * Each carries identical CH9329 frames. One control transport is active at a
 * time; available Wi-Fi media supplies control when the selected link is idle.
 */

export type LinkKind = 'serial' | 'ble' | 'wifi'

const kind = ref<LinkKind>('serial')
const wifiHidEnabled = ref(false)
let followingMedia = false,
  selecting = 0,
  wifiPaused = false

export function useLink() {
  const serial = useSerialLink()
  const ble = useBleLink()
  const media = useVirtualMedia()
  const wifi = {
    connected: computed(
      () =>
        media.connected.value &&
        media.transport.value === 'wifi' &&
        wifiHidEnabled.value,
    ),
    connecting: media.connecting,
    portLabel: computed(() => 'Wi-Fi media link'),
    lastError: media.error,
    connect: async () => {
      if (media.connected.value && media.transport.value !== 'wifi') {
        media.error.value =
          'Eject and disconnect USB media before switching to Wi-Fi control.'
        return false
      }
      if (!media.connected.value) {
        media.transport.value = 'wifi'
        await media.connect()
      }
      wifiHidEnabled.value = media.connected.value
      return media.connected.value
    },
    // Switching HID transport must not eject a disk owned by the media panel.
    disconnect: async () => {
      await media.releaseHid()
      wifiHidEnabled.value = false
    },
    sendAndWait: media.sendAndWait,
  }
  const active = computed(() =>
    kind.value === 'wifi' ? wifi : kind.value === 'ble' ? ble : serial,
  )

  function adoptWifi() {
    if (
      !selecting &&
      !wifiPaused &&
      media.connected.value &&
      media.transport.value === 'wifi' &&
      !active.value.connected.value
    ) {
      kind.value = 'wifi'
      wifiHidEnabled.value = true
    }
  }

  if (!followingMedia) {
    followingMedia = true
    // The transport is shared by every panel and outlives any one component.
    // A media connection already carries HID; adopt it when control is idle.
    effectScope(true).run(() =>
      watch(
        [media.connected, media.transport, serial.connected, ble.connected],
        ([connected, transport], previous) => {
          const ready = connected && transport === 'wifi'
          if (ready && !(previous?.[0] && previous[1] === 'wifi'))
            wifiPaused = false
          if (!ready) wifiHidEnabled.value = false
          adoptWifi()
        },
        { immediate: true, flush: 'sync' },
      ),
    )
  }

  async function connect(which: LinkKind) {
    if (which === kind.value && active.value.connected.value) return true
    if (
      which === 'wifi' &&
      media.connected.value &&
      media.transport.value === 'usb'
    ) {
      media.error.value =
        'Eject and disconnect USB media before switching to Wi-Fi control.'
      return false
    }
    const previous = kind.value,
      previousWifiEnabled = wifiHidEnabled.value
    const keepUsb =
      previous === 'serial' &&
      media.connected.value &&
      media.transport.value === 'usb'
    selecting++
    try {
      if (active.value.connected.value && !keepUsb && !(await disconnect()))
        return false
      kind.value = which
      const ok =
        which === 'serial' && serial.connected.value
          ? true
          : await active.value.connect()
      if (!ok) {
        kind.value = previous
        wifiHidEnabled.value = previousWifiEnabled
      }
      wifiPaused = false
      return ok
    } finally {
      selecting--
      adoptWifi()
    }
  }

  async function disconnect() {
    if (
      kind.value === 'serial' &&
      media.connected.value &&
      media.transport.value === 'usb'
    ) {
      if (media.inserted.value || media.uncertain.value || media.busy.value) {
        media.error.value =
          'Eject and synchronize USB media before disconnecting its cable.'
        return false
      }
      await media.disconnect()
      if (media.connected.value) return false
    }
    // An explicit pause lasts for this media session. It must neither eject
    // the disk nor immediately trigger automatic fallback to the same socket.
    wifiPaused = true
    await active.value.disconnect()
    return true
  }

  return {
    kind,
    serialSupported: serial.supported,
    bleSupported: ble.supported,
    wifiAvailable: computed(
      () => media.connected.value && media.transport.value === 'wifi',
    ),
    supported: computed(
      () =>
        serial.supported.value || ble.supported.value || media.connected.value,
    ),
    connected: computed(() => active.value.connected.value),
    connecting: computed(() => active.value.connecting.value),
    portLabel: computed(() => active.value.portLabel.value),
    lastError: computed(() => active.value.lastError.value),
    connect,
    disconnect,
    sendAndWait: (frame: Uint8Array, cmd: number): Promise<SendResult> =>
      active.value.sendAndWait(frame, cmd),
  }
}
