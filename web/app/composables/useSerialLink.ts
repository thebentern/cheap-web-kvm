// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, ref, shallowRef } from 'vue'
import { parseReply } from '~/utils/ch9329'

/**
 * Web Serial transport to the KVM.
 *
 * Timing matches the reference client because the firmware was tuned against
 * it: each command waits up to 300 ms for its acknowledgement and resolves
 * rather than throwing on timeout, so a device that stops answering degrades to
 * slow instead of breaking.
 */

const REPLY_TIMEOUT_MS = 300

const port = shallowRef<SerialPort | null>(null)
const reader = shallowRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
const writer = shallowRef<WritableStreamDefaultWriter<Uint8Array> | null>(null)

const connected = ref(false)
const connecting = ref(false)
const portLabel = ref('Not connected')
const lastError = ref<string | null>(null)

/** Bytes received since the last command was sent. */
let rxBuffer: number[] = []
let readLoopRunning = false

export interface SendResult {
  ok: boolean
  timeout: boolean
  payload: Uint8Array | null
}

export function useSerialLink() {
  const supported = computed(
    () => typeof navigator !== 'undefined' && 'serial' in navigator,
  )

  async function readLoop() {
    readLoopRunning = true
    try {
      while (port.value && reader.value) {
        const { value, done } = await reader.value.read()
        if (done) break
        if (value) for (const b of value) rxBuffer.push(b)
      }
    } catch {
      // Port closed underneath us; disconnect() handles the state.
    } finally {
      readLoopRunning = false
    }
  }

  async function connect(baudRate = 115200) {
    if (!supported.value) {
      lastError.value = 'Web Serial is not available in this browser'
      return false
    }
    if (port.value) await disconnect()

    connecting.value = true
    lastError.value = null
    try {
      const p = await navigator.serial.requestPort()
      await p.open({ baudRate })
      port.value = p
      reader.value = p.readable!.getReader()
      writer.value = p.writable!.getWriter()
      connected.value = true

      const info = p.getInfo?.()
      portLabel.value = info?.usbVendorId
        ? `${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0)
            .toString(16)
            .padStart(4, '0')}`
        : 'Connected'

      void readLoop()
      return true
    } catch (err) {
      const e = err as Error
      // A cancelled picker is a normal outcome, not a failure worth reporting.
      if (e.name !== 'NotFoundError') lastError.value = e.message
      portLabel.value = 'Not connected'
      return false
    } finally {
      connecting.value = false
    }
  }

  async function disconnect() {
    try {
      if (reader.value) {
        await reader.value.cancel().catch(() => {})
        reader.value.releaseLock()
      }
      writer.value?.releaseLock()
      await port.value?.close()
    } catch {
      // Already gone.
    }
    reader.value = null
    writer.value = null
    port.value = null
    connected.value = false
    portLabel.value = 'Not connected'
    rxBuffer = []
  }

  /** Write a frame and wait for its acknowledgement. */
  async function sendAndWait(frame: Uint8Array, cmd: number): Promise<SendResult> {
    if (!writer.value) return { ok: false, timeout: false, payload: null }

    rxBuffer = []
    await writer.value.write(frame)

    const deadline = Date.now() + REPLY_TIMEOUT_MS
    while (Date.now() < deadline) {
      const match = parseReply(rxBuffer, cmd)
      if (match) {
        rxBuffer = rxBuffer.slice(match.end)
        return { ok: match.ok, timeout: false, payload: match.payload }
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    rxBuffer = []
    return { ok: false, timeout: true, payload: null }
  }

  return {
    supported,
    connected,
    connecting,
    portLabel,
    lastError,
    connect,
    disconnect,
    sendAndWait,
    isReading: () => readLoopRunning,
  }
}
