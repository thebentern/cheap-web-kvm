// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, ref } from 'vue'
import { useRuntimeConfig } from '#imports'
import { useKvm } from '~/composables/useKvm'
import { fetchFirmwareBundle, type FirmwareBundle } from '~/utils/firmwareManifest'
import { installFirmware } from '~/utils/firmwareInstaller'

export type FirmwareStatus = 'loading' | 'ready' | 'connecting' | 'installing' | 'success' | 'error' | 'unavailable'

export function useFirmwareFlasher() {
  const kvm = useKvm()
  const config = useRuntimeConfig()
  const supported = computed(() => typeof window !== 'undefined' && window.isSecureContext && 'serial' in navigator)
  const status = ref<FirmwareStatus>('loading')
  const busy = computed(() => status.value === 'connecting' || status.value === 'installing')
  const progress = ref(0)
  const logs = ref<string[]>([])
  const error = ref<string | null>(null)
  const version = ref<string | null>(null)
  const chipName = ref<string | null>(null)
  let bundle: FirmwareBundle | null = null
  let download: AbortController | null = null
  let operation: Promise<void> | null = null
  let disposed = false

  function log(line: string) {
    const text = line.replace(/\x1b\[[0-9;]*m/g, '').trim()
    if (text) logs.value = [...logs.value.slice(-99), text]
  }

  async function loadFirmware() {
    if (busy.value || disposed) return
    download?.abort()
    const controller = new AbortController()
    download = controller
    bundle = null
    error.value = null
    version.value = null
    status.value = 'loading'
    if (!supported.value) {
      status.value = 'unavailable'
      return
    }
    try {
      const url = new URL(`${config.app.baseURL}firmware/manifest.json`, window.location.origin)
      const loaded = await fetchFirmwareBundle(url, controller.signal)
      if (disposed || download !== controller) return
      bundle = loaded
      version.value = loaded.manifest.version
      status.value = 'ready'
    } catch (cause) {
      if (disposed || download !== controller) return
      error.value = cause instanceof Error ? cause.message : 'Could not load firmware. Reload and try again.'
      status.value = 'unavailable'
    }
  }

  function install(): Promise<void> {
    if (busy.value || disposed || !supported.value || !bundle) return Promise.resolve()
    status.value = 'connecting'
    error.value = null
    chipName.value = null
    progress.value = 0
    logs.value = []
    // installFirmware reaches requestPort synchronously, before imports or
    // disconnects can consume the browser's transient user activation.
    operation = installFirmware(bundle, {
      requestPort: () => navigator.serial.requestPort(),
      async disconnectControl() {
        try {
          if (kvm.link.connected.value) await kvm.releaseAll()
        } finally {
          await kvm.link.disconnect()
        }
      },
      async createSession(port, writeLog) {
        const [{ ESPLoader, Transport }, { default: SparkMD5 }] = await Promise.all([
          import('esptool-js'), import('spark-md5'),
        ])
        const transport = new Transport(port)
        const loader = new ESPLoader({ transport, baudrate: 115200, romBaudrate: 115200,
          terminal: { clean() {}, write: writeLog, writeLine: writeLog } })
        md5 = data => SparkMD5.ArrayBuffer.hash(Uint8Array.from(data).buffer)
        return { loader, disconnect: () => transport.disconnect() }
      },
      md5: data => md5(data),
    }, { log, chip: name => { chipName.value = name }, writing: () => { status.value = 'installing' },
      progress: value => { progress.value = value } })
      .then(() => { status.value = 'success'; log('Installation complete. You can reconnect control from the console.') })
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === 'NotFoundError') {
          status.value = 'ready'
          return
        }
        error.value = cause instanceof Error ? cause.message : 'Installation failed. Check the UART cable and try again.'
        status.value = 'error'
        log(error.value)
      })
      .finally(() => { operation = null })
    return operation
  }

  let md5: (data: Uint8Array) => string = () => { throw new Error('Firmware verifier is not ready.') }

  async function dispose() {
    disposed = true
    download?.abort()
    // The route guard normally prevents this; if unmounted externally, let
    // the write finish and its finally block close the port rather than cut it.
    await operation
  }

  return { supported, status, busy, progress, logs, error, version, chipName, loadFirmware, install, dispose }
}
