// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, readonly, ref, shallowRef } from 'vue'
import { parseReply } from '~/utils/ch9329'
import { SerialDemux, serialMediaFrame } from '~/utils/media/serial'
import type { MediaTransport } from '~/utils/media/transport'

export const DEFAULT_SERIAL_BAUD_RATE = 921600
export const SERIAL_BAUD_RATES = [115200, 460800, 921600, 2000000] as const
const BAUD_STORAGE_KEY = 'kvm.serialBaudRate'
const selectedBaudRate = ref<number>(DEFAULT_SERIAL_BAUD_RATE)
let baudLoaded = false
function loadBaudRate() {
  if (baudLoaded || typeof window === 'undefined') return
  baudLoaded = true
  try {
    const saved = Number(window.localStorage.getItem(BAUD_STORAGE_KEY))
    if (SERIAL_BAUD_RATES.some((value) => value === saved))
      selectedBaudRate.value = saved
  } catch {
    // Storage is optional; the current tab can still choose a connection rate.
  }
}

const REPLY_TIMEOUT_MS = 300
const MEDIA_REPLY_TIMEOUT_MS = 2000
const port = shallowRef<SerialPort | null>(null)
const reader = shallowRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
const writer = shallowRef<WritableStreamDefaultWriter<Uint8Array> | null>(null)
const connected = ref(false)
const connecting = ref(false)
const portLabel = ref('Not connected')
const lastError = ref<string | null>(null)
let readLoopRunning = false
let generation = 0
let baud = DEFAULT_SERIAL_BAUD_RATE
let media: MediaTransport | null = null
let mediaReleasePending = false
let release: {
  promise: Promise<void>
  error: unknown
  acknowledge: () => void
} | null = null
let hid: {
  cmd: number
  resolve: (r: SendResult) => void
  timer: ReturnType<typeof setTimeout>
} | null = null
function queue() {
  return { tail: Promise.resolve(), queued: 0, bytes: 0 }
}
let writes = queue(),
  commands = queue()
const failed = (): SendResult => ({ ok: false, timeout: false, payload: null })
const demux = new SerialDemux(
  (packet) => {
    if (!hid) return
    const match = parseReply([...packet], hid.cmd)
    if (!match) return
    clearTimeout(hid.timer)
    const resolve = hid.resolve
    hid = null
    resolve({ ok: match.ok, timeout: false, payload: match.payload })
  },
  (packet) => {
    if (!packet.length) {
      if (mediaReleasePending && release) {
        release.acknowledge()
        return
      }
      // Empty envelopes acknowledge our release only. An old ACK left on
      // the wire must not close a subsequently bound media connection.
    } else media?.onmessage(packet)
  },
)

export interface SendResult {
  ok: boolean
  timeout: boolean
  payload: Uint8Array | null
}

/** Queue complete physical frames, never a transaction's wait for its reply. */
function writeFrame(frame: Uint8Array, mine = generation): Promise<void> {
  const q = writes,
    output = writer.value
  if (
    !output ||
    !connected.value ||
    q.queued >= 128 ||
    q.bytes + frame.length > 65536
  )
    return Promise.reject(
      new Error('USB serial write queue unavailable or full'),
    )
  q.queued++
  q.bytes += frame.length
  const result = q.tail.then(async () => {
    if (mine !== generation || !connected.value)
      throw new Error('USB serial disconnected')
    await output.write(frame)
  })
  q.tail = result.catch(() => {})
  return result.finally(() => {
    q.queued--
    q.bytes -= frame.length
  })
}

export function useSerialLink() {
  loadBaudRate()
  const baudLocked = computed(
    () => connected.value || connecting.value || mediaReleasePending,
  )
  function setBaudRate(value: number) {
    if (baudLocked.value || !SERIAL_BAUD_RATES.some((rate) => rate === value))
      return false
    selectedBaudRate.value = value
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem(BAUD_STORAGE_KEY, String(value))
    } catch {
      // This rate remains selected even when browser storage is unavailable.
    }
    return true
  }
  const supported = computed(
    () => typeof navigator !== 'undefined' && 'serial' in navigator,
  )

  async function readLoop(
    input: ReadableStreamDefaultReader<Uint8Array>,
    mine: number,
  ) {
    readLoopRunning = true
    try {
      while (mine === generation) {
        const { value, done } = await input.read()
        if (mine !== generation || done) break
        if (value) demux.feed(value)
      }
    } catch {
      // A cable removal is reported through the shared disconnect path below.
    } finally {
      if (mine === generation) {
        readLoopRunning = false
        void disconnect()
      }
    }
  }

  async function connect(
    baudRate = selectedBaudRate.value,
    reuseGranted = false,
  ) {
    if (!supported.value) {
      lastError.value = 'Web Serial is not available in this browser'
      return false
    }
    if (port.value) await disconnect()
    connecting.value = true
    lastError.value = null
    try {
      let granted: SerialPort[] = []
      if (reuseGranted && typeof navigator.serial.getPorts === 'function') {
        try {
          granted = (await navigator.serial.getPorts()).filter(
            (p) => p.connected,
          )
        } catch {
          // If enumeration is unavailable, let the user choose explicitly.
        }
      }
      const p =
        granted.length === 1
          ? granted[0]!
          : await navigator.serial.requestPort()
      await p.open({ baudRate })
      port.value = p
      reader.value = p.readable!.getReader()
      writer.value = p.writable!.getWriter()
      baud = baudRate
      connected.value = true
      const info = p.getInfo?.()
      portLabel.value = info?.usbVendorId
        ? `${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')}`
        : 'Connected'
      void readLoop(reader.value, generation)
      return true
    } catch (err) {
      const e = err as Error
      if (e.name !== 'NotFoundError') lastError.value = e.message
      if (port.value) await disconnect()
      portLabel.value = 'Not connected'
      return false
    } finally {
      connecting.value = false
    }
  }

  async function disconnect() {
    generation++
    const input = reader.value,
      output = writer.value,
      oldPort = port.value,
      oldMedia = media
    reader.value = null
    writer.value = null
    port.value = null
    media = null
    if (release && mediaReleasePending) {
      release.error = new Error(
        'USB serial disconnected before media release was acknowledged',
      )
      release.acknowledge()
    }
    mediaReleasePending = false
    release = null
    connected.value = false
    readLoopRunning = false
    portLabel.value = 'Not connected'
    demux.reset()
    if (hid) {
      clearTimeout(hid.timer)
      hid.resolve(failed())
      hid = null
    }
    writes = queue()
    commands = queue()
    oldMedia?.onclose()
    try {
      await input?.cancel().catch(() => {})
      input?.releaseLock()
      await output?.abort().catch(() => {})
      output?.releaseLock()
      await oldPort?.close()
    } catch {
      // The OS may already have closed an unplugged port.
    }
  }

  async function transact(
    frame: Uint8Array,
    cmd: number,
    mine: number,
  ): Promise<SendResult> {
    if (mine !== generation || !connected.value) return failed()
    return new Promise<SendResult>((resolve) => {
      const pending = {
        cmd,
        resolve,
        // A full media packet ahead of an ACK takes ~0.72 s at 115200.
        // Include both directions plus bounded device scheduling time.
        timer: setTimeout(
          () => {
            if (hid === pending) hid = null
            resolve({ ok: false, timeout: true, payload: null })
          },
          (media || mediaReleasePending
            ? MEDIA_REPLY_TIMEOUT_MS
            : REPLY_TIMEOUT_MS) + Math.ceil((writes.bytes * 10000) / baud),
        ),
      }
      hid = pending
      void writeFrame(frame, mine).catch(() => {
        if (hid !== pending) return
        clearTimeout(pending.timer)
        hid = null
        resolve(failed())
      })
    })
  }

  function sendAndWait(frame: Uint8Array, cmd: number): Promise<SendResult> {
    const q = commands,
      mine = generation
    if (q.queued >= 128 || !connected.value) return Promise.resolve(failed())
    q.queued++
    const result = q.tail.then(() => transact(frame, cmd, mine))
    q.tail = result.then(
      () => {},
      () => {},
    )
    return result.finally(() => {
      q.queued--
    })
  }

  function mediaTransport(): MediaTransport {
    if (!connected.value)
      throw new Error('Connect the board’s USB serial port first')
    if (media || mediaReleasePending)
      throw new Error('USB media is already connected or closing')
    const mine = generation
    release = null
    let closed = false
    const transport: MediaTransport = {
      label: 'USB serial',
      startupRetries: 1,
      onmessage: () => {},
      onclose: () => {},
      async send(data) {
        if (closed || media !== transport || mine !== generation)
          throw new Error('USB media connection closed')
        await writeFrame(serialMediaFrame(data), mine)
      },
      close() {
        if (closed) return
        closed = true
        if (media !== transport || mine !== generation) return
        media = null
        mediaReleasePending = true
        // Keep serial available for HID. A zero-length envelope relinquishes
        // just media ownership after previously queued packets finish.
        let acknowledge!: () => void
        const ack = new Promise<void>((resolve) => {
          acknowledge = resolve
        })
        const current = {
          promise: Promise.resolve(),
          error: null as unknown,
          acknowledge,
        }
        release = current
        current.promise = writeFrame(serialMediaFrame(new Uint8Array()), mine)
          .then(() => ack)
          .catch((error) => {
            current.error = error
          })
          .finally(() => {
            if (mine === generation && release === current)
              mediaReleasePending = false
          })
      },
    }
    media = transport
    return transport
  }

  async function waitForMediaRelease(): Promise<void> {
    const current = release
    if (!current) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        current.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'USB media release timed out; reconnect the cable before switching media transport',
                ),
              ),
            MEDIA_REPLY_TIMEOUT_MS + Math.ceil((writes.bytes * 10000) / baud),
          )
        }),
      ])
      if (current.error) throw current.error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    baudRate: readonly(selectedBaudRate),
    activeBaudRate: computed(() =>
      connected.value ? baud : selectedBaudRate.value,
    ),
    baudRates: SERIAL_BAUD_RATES,
    baudLocked,
    setBaudRate,
    supported,
    connected,
    connecting,
    portLabel,
    lastError,
    connect,
    disconnect,
    sendAndWait,
    mediaTransport,
    waitForMediaRelease,
    isReading: () => readLoopRunning,
  }
}
