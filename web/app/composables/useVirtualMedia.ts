// SPDX-License-Identifier: GPL-3.0-or-later
import { reactive, ref, shallowRef } from 'vue'
import { useSerialLink } from '~/composables/useSerialLink'
import { useDeviceHost } from '~/composables/useDeviceHost'
import { authenticateDevice } from '~/utils/deviceHost'
import { MediaConnection } from '~/utils/media/client'
import { FLAG, OP } from '~/utils/media/protocol'
import { MediaHidQueue } from '~/utils/media/hidQueue'
import { MediaReadRate } from '~/utils/media/readRate'
import { parseReply, resetFrame } from '~/utils/ch9329'
import type { Volume } from '~/utils/media/disk'
import type { Entry } from '~/utils/media/fat'
const connected = ref(false),
  connecting = ref(false),
  error = ref<string | null>(null)
const meta = shallowRef<Volume | null>(null),
  saved = shallowRef<Volume[]>([]),
  entries = shallowRef<Entry[]>([])
const inserted = ref(false),
  uncertain = ref(false),
  writeMode = ref(false),
  busy = ref(false),
  progress = ref(0),
  phase = ref('Working'),
  importing = ref(false),
  cancelingImport = ref(false),
  persistent = ref(false)
const preview = ref('')
const path = ref<string[]>([]),
  inspection = ref<string[]>([]),
  flags = ref(0)
const activity = reactive({
  read: 0,
  written: 0,
  rate: 0,
  readRequests: 0,
  readTotalMs: 0,
  readMaxMs: 0,
  last: '',
  benchmark: '',
})
const url = ref('')
const boardToken = ref('')
const transport = ref<'usb' | 'wifi'>('usb')
const deviceHost = useDeviceHost()
const hidQueue = new MediaHidQueue(transactHid)
let worker: Worker | null = null,
  connection: MediaConnection | null = null,
  next = 0
let activityTimer: ReturnType<typeof setInterval> | undefined
const readRate = new MediaReadRate()
function stopActivity() {
  if (activityTimer) clearInterval(activityTimer)
  activityTimer = undefined
  activity.rate = 0
}
function startActivity() {
  stopActivity()
  activity.read = 0
  activity.written = 0
  activity.readRequests = 0
  activity.readTotalMs = 0
  activity.readMaxMs = 0
  readRate.reset(0, performance.now())
  activityTimer = setInterval(() => {
    activity.rate = readRate.sample(activity.read, performance.now())
  }, 1000)
}
let hostDefaultsApplied = false
const pending = new Map<
  number,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>()
function rpc<T = any>(method: string, args?: unknown): Promise<T> {
  if (!worker) {
    worker = new Worker(
      new URL('../workers/media.worker.ts', import.meta.url),
      { type: 'module' },
    )
    worker.onmessage = ({ data }) => {
      if ('progress' in data) {
        progress.value = data.progress
        if (data.phase) phase.value = data.phase
        return
      }
      const p = pending.get(data.id)
      if (!p) return
      pending.delete(data.id)
      if (data.meta) meta.value = data.meta
      if (data.error) p.reject(new Error(data.error))
      else p.resolve(data.value)
    }
    worker.onerror = () => {
      error.value =
        'Storage worker failed. Eject/unmount the target before reloading; committed writes are preserved.'
      uncertain.value ||= inserted.value
      connection?.close()
      stopActivity()
      connected.value = false
      for (const p of pending.values()) p.reject(new Error(error.value!))
      pending.clear()
    }
    window.addEventListener('beforeunload', (e) => {
      if (inserted.value || uncertain.value || busy.value) {
        e.preventDefault()
        e.returnValue = ''
      }
    })
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && inserted.value)
        error.value ||=
          'Keep this tab visible. Browser suspension can disconnect the virtual disk; durable writes remain saved.'
    })
  }
  const id = ++next
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      worker!.postMessage({ id, method, args })
    } catch (e) {
      pending.delete(id)
      reject(e)
    }
  })
}
async function run<T>(
  action: () => Promise<T>,
  clearError = true,
): Promise<T | undefined> {
  if (busy.value) return
  busy.value = true
  if (clearError) error.value = null
  progress.value = 0
  phase.value = 'Working'
  try {
    return await action()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function refresh() {
  saved.value = await rpc('saved')
  if (
    meta.value?.kind === 'fat32' &&
    !inserted.value &&
    !uncertain.value &&
    !meta.value.needsCheck
  )
    entries.value = await rpc('list', { path: [...path.value] })
}
async function syncPersistent() {
  if (globalThis.isSecureContext === false || !navigator.storage)
    throw new Error(
      deviceHost.onboard.value
        ? 'Trust this board’s certificate using its setup page, then reopen the HTTPS console. Browser storage is unavailable until this page is trusted.'
        : 'Browser storage needs HTTPS or localhost. Reopen this app in a secure browser context.',
    )
  persistent.value = !!(await navigator.storage.persisted?.())
  return persistent.value
}
async function grantPersistence() {
  return run(async () => {
    persistent.value = await navigator.storage.persist()
    await rpc('persistence', { persistent: persistent.value })
    if (!persistent.value)
      throw new Error(
        'Persistent storage was not granted. Use read-only media; export client edits to preserve them outside this browser.',
      )
  })
}
async function open(args: {
  file?: File
  meta?: Volume
  size?: number
  label?: string
}) {
  return run(async () => {
    if (uncertain.value || inserted.value)
      throw new Error('Eject and synchronize before switching media')
    await syncPersistent()
    importing.value = /\.img\.xz$/i.test(args.file?.name ?? '')
    cancelingImport.value = false
    try {
      meta.value = await rpc('open', { ...args, persistent: persistent.value })
    } finally {
      importing.value = false
      cancelingImport.value = false
    }
    path.value = []
    inspection.value = []
    entries.value = []
    if (meta.value?.kind === 'boot')
      inspection.value = (await rpc('inspect')).details
    await refresh()
  })
}
function cancelImport() {
  if (!importing.value || cancelingImport.value) return
  cancelingImport.value = true
  worker?.postMessage({ method: 'cancelImport' })
}
async function selectTransport(next: 'usb' | 'wifi') {
  if (connected.value || busy.value || inserted.value || uncertain.value) return
  hostDefaultsApplied = true
  transport.value = next
  if (next === 'wifi')
    await run(async () => {
      phase.value = 'Checking board'
      await deviceHost.refresh()
    })
}
async function connect() {
  return run(async () => {
    if (inserted.value || uncertain.value)
      throw new Error('Eject or recover the existing session first')
    connecting.value = true
    try {
      hidQueue.clear()
      connection?.close()
      stopActivity()
      connection = new MediaConnection({
        read: (offset, length) => rpc('read', { offset, length }),
        write: async (offset, data) => {
          meta.value = await rpc('write', { offset, data })
        },
      })
      const current = connection
      connection.onError = (message) => {
        if (connection !== current) return
        error.value = message
        if (inserted.value) uncertain.value = true
        if (!connection?.live) {
          connected.value = false
          stopActivity()
        }
      }
      connection.onState = (state) => {
        if (connection !== current) return
        flags.value = state
        if (
          inserted.value &&
          (!(state & FLAG.PRESENT) || state & FLAG.FAILED)
        ) {
          // Target eject is also synchronized through an explicit browser action.
          uncertain.value = true
          error.value =
            'Target ejected the disk or the backend failed. Finish ejection to synchronize before editing.'
        }
      }
      connection.onActivity = (bytes, write) => {
        if (connection !== current) return
        if (write) activity.written += bytes
        else activity.read += bytes
        activity.last = `${write ? 'Committed write' : 'Read'} · ${bytes} bytes`
      }
      connection.onReadResponse = (stats) => {
        if (connection !== current) return
        activity.readRequests = stats.requests
        activity.readTotalMs = stats.totalMs
        activity.readMaxMs = stats.maxMs
      }
      if (transport.value === 'usb') {
        const serial = useSerialLink()
        if (!serial.connected.value && !(await serial.connect(undefined, true)))
          throw new Error(
            serial.lastError.value ?? 'USB connection was cancelled',
          )
        await connection.connect(serial.mediaTransport())
      } else {
        const knownBoard = deviceHost.onboard.value
        const device = await deviceHost.refresh()
        if (!device && knownBoard)
          throw new Error(
            'Cannot reach the board. Check its Wi-Fi connection and reopen this HTTPS page.',
          )
        if (device && !device.authenticated) {
          try {
            await authenticateDevice(boardToken.value)
            const paired = await deviceHost.refresh()
            if (!paired?.authenticated)
              throw new Error(
                'Pairing could not be saved. Allow cookies for this board’s HTTPS page and try again.',
              )
          } finally {
            boardToken.value = ''
          }
        }
        await connection.connect(
          url.value ||
            `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/media`,
        )
      }
      connected.value = true
      flags.value = 0
    } catch (e) {
      connection?.close()
      stopActivity()
      connected.value = false
      throw e
    } finally {
      connecting.value = false
    }
  })
}
async function insert() {
  return run(async () => {
    if (!connected.value || !connection || uncertain.value)
      throw new Error('Connect and synchronize the media backend first')
    if (writeMode.value && !persistent.value)
      throw new Error('Grant persistent storage before enabling target writes')
    await rpc('insert', { writable: writeMode.value })
    // An insert timeout is ambiguous. Keep the worker locked until confirmed ejection.
    inserted.value = true
    startActivity()
    connection.resetReadStats()
    try {
      await connection.request(
        OP.INSERT,
        undefined,
        meta.value!.size,
        writeMode.value ? FLAG.WRITABLE : 0,
      )
    } catch (e) {
      uncertain.value = true
      throw e
    }
    uncertain.value = false
  })
}
async function eject(targetUnmounted: boolean) {
  return run(async () => {
    if ((writeMode.value || uncertain.value) && !targetUnmounted)
      throw new Error(
        'Unmount/eject the disk in the target OS, then confirm it here',
      )
    if (connected.value && connection) await connection.request(OP.EJECT)
    else if (!targetUnmounted)
      throw new Error(
        'Confirm target unmount before recovering a disconnected disk',
      )
    // The worker FIFO drains any in-flight storage transaction before unlocking.
    meta.value = await rpc('eject')
    inserted.value = false
    stopActivity()
    uncertain.value = false
    flags.value = 0
    await refresh()
  })
}
async function releaseHid() {
  hidQueue.clear()
  if (connection?.live) await transactHid(resetFrame(), 0x0f).catch(() => {})
}
async function disconnect() {
  return run(async () => {
    if (inserted.value || uncertain.value)
      throw new Error('Eject and synchronize before disconnecting')
    await releaseHid()
    connection?.close()
    stopActivity()
    connection = null
    try {
      if (transport.value === 'usb') await useSerialLink().waitForMediaRelease()
    } finally {
      connected.value = false
    }
  })
}
function download(file: File, name: string) {
  const href = URL.createObjectURL(file),
    a = document.createElement('a')
  a.href = href
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(href), 60000)
}
async function saveHandle(name: string) {
  if ('showSaveFilePicker' in window)
    return (window as any).showSaveFilePicker({
      suggestedName: name,
    }) as Promise<FileSystemFileHandle>
}
async function exportDisk() {
  // Picker must be invoked during the user gesture, before any async work.
  const name = `${meta.value?.name.replace(/\.xz$/i, '').replace(/\.(img|iso)$/i, '') ?? 'disk'}-updated.img`
  let handle: FileSystemFileHandle | undefined
  try {
    handle = await saveHandle(name)
  } catch (e) {
    if ((e as Error).name !== 'AbortError') error.value = (e as Error).message
    return
  }
  return run(async () => {
    const result = await rpc('export', { handle })
    meta.value = result.meta
    if (result.file) download(result.file, name)
    await refresh()
  })
}
async function downloadFile(name: string) {
  let handle: FileSystemFileHandle | undefined
  try {
    handle = await saveHandle(name)
  } catch {
    return
  }
  return run(async () => {
    const file = await rpc('download', { path: [...path.value], name, handle })
    if (file) download(file, name)
  })
}
async function edit(method: string, args: unknown) {
  return run(async () => {
    meta.value = await rpc(method, args)
    await refresh()
  })
}
async function navigate(name?: string) {
  return run(async () => {
    const previous = [...path.value]
    if (name) path.value.push(name)
    else path.value.pop()
    try {
      await refresh()
    } catch (e) {
      path.value = previous
      throw e
    }
  })
}
async function transactHid(frame: Uint8Array, cmd: number) {
  const m = await connection!.request(OP.HID, frame),
    reply = parseReply(m.data, cmd)
  return {
    ok: reply?.ok ?? false,
    timeout: false,
    payload: reply?.payload ?? null,
  }
}
export function useVirtualMedia() {
  return {
    connected,
    connecting,
    error,
    meta,
    saved,
    entries,
    inserted,
    uncertain,
    writeMode,
    busy,
    progress,
    phase,
    importing,
    cancelingImport,
    persistent,
    path,
    inspection,
    flags,
    activity,
    url,
    boardToken,
    onboard: deviceHost.onboard,
    deviceInfo: deviceHost.info,
    transport,
    preview,
    inspectFile: (name: string) =>
      run(async () => {
        const p = await rpc('preview', { path: [...path.value], name })
        preview.value = `${name}${p.truncated ? ' (first 64 KiB)' : ''}\n\n${p.text}`
      }),
    initialize: () =>
      run(
        async () => {
          const device = await deviceHost.initialize()
          if (
            device &&
            !hostDefaultsApplied &&
            !connected.value &&
            !inserted.value &&
            !uncertain.value
          )
            transport.value = 'wifi'
          if (device) hostDefaultsApplied = true
          await syncPersistent()
          await refresh()
        },
        false, // Reopening the panel must preserve the session's failure reason.
      ),
    grantPersistence,
    open,
    cancelImport,
    selectTransport,
    connect,
    disconnect,
    insert,
    eject,
    exportDisk,
    downloadFile,
    navigate,
    add: (file: File) =>
      edit('add', { path: [...path.value], name: file.name, file }),
    mkdir: (name: string) => edit('add', { path: [...path.value], name }),
    remove: (name: string) => edit('remove', { path: [...path.value], name }),
    markExported: () => edit('markExported', {}),
    benchmark: () =>
      run(async () => {
        if (!connection || inserted.value)
          throw new Error('Connect and eject before benchmarking')
        const b = await connection.benchmark()
        activity.benchmark = `${(b.bytesPerSecond / 1048576).toFixed(2)} MiB/s round-trip aggregate · max RTT ${b.maxMs.toFixed(1)} ms · ${b.count} verified echoes · ${b.measuredAt}`
      }),
    releaseHid,
    sendAndWait: (frame: Uint8Array, cmd: number) => hidQueue.send(frame, cmd),
  }
}
