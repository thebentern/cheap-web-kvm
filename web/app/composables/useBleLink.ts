// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, ref, shallowRef } from 'vue'
import { CMD, coalesceMove, getInfoFrame, parseReply } from '~/utils/ch9329'
import type { SendResult } from '~/composables/useSerialLink'

/**
 * Web Bluetooth transport to the KVM, for hosts with no Web Serial — an iPad
 * running a Web Bluetooth browser such as Bluefy.
 *
 * The firmware carries the same CH9329 frames over one GATT service: requests
 * are written to RX, replies come back as notifications on TX
 * (docs/PROTOCOL.md §1). Only the cost differs. Each round trip is a
 * connection interval or two (15–30 ms), and GATT allows one write at a time,
 * so frames go through a queue — and a pointer move or scroll still waiting in
 * it is merged with the next rather than sent late.
 */

/** Must match firmware/main/kvm_ble.c. */
export const BLE_SERVICE = 'a1340001-d6af-4060-9ae5-7254073b70b8'
const BLE_RX = 'a1340002-d6af-4060-9ae5-7254073b70b8'
const BLE_TX = 'a1340003-d6af-4060-9ae5-7254073b70b8'

/** Measured from when the write completes, so the radio's share is not in it. */
const REPLY_TIMEOUT_MS = 300

const FAILED: SendResult = { ok: false, timeout: false, payload: null }

/* The slice of Web Bluetooth used here; TypeScript's DOM library has none. */
interface GattCharacteristic extends EventTarget {
  value?: DataView
  writeValue(data: Uint8Array): Promise<void>
  writeValueWithResponse?(data: Uint8Array): Promise<void>
  startNotifications(): Promise<GattCharacteristic>
}
interface GattService {
  getCharacteristic(uuid: string): Promise<GattCharacteristic>
}
interface GattServer {
  connect(): Promise<GattServer>
  disconnect(): void
  getPrimaryService(uuid: string): Promise<GattService>
}
interface BleDevice extends EventTarget {
  name?: string
  gatt?: GattServer
}
interface BluetoothApi {
  requestDevice(options: { filters: { services: string[] }[] }): Promise<BleDevice>
}

interface Pending {
  frame: Uint8Array
  cmd: number
  resolve: (r: SendResult) => void
  /**
   * Changes the button state. Later moves must not merge into it: the target
   * would see the release land where the pointer ended up, and a click would
   * turn into a drag.
   */
  pinned: boolean
}

const device = shallowRef<BleDevice | null>(null)
const rxChar = shallowRef<GattCharacteristic | null>(null)
const txChar = shallowRef<GattCharacteristic | null>(null)

const connected = ref(false)
const connecting = ref(false)
const portLabel = ref('Not connected')
const lastError = ref<string | null>(null)

/** Bytes notified since the current command was written. */
let rxBuffer: number[] = []
let queue: Pending[] = []
let pumping = false
/** Buttons byte of the last pointer frame queued, to spot presses and releases. */
let lastButtons = 0

function bluetooth(): BluetoothApi | undefined {
  return typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { bluetooth?: BluetoothApi }).bluetooth
}

function onNotify(e: Event) {
  const v = (e.target as GattCharacteristic).value
  if (!v) return
  for (let i = 0; i < v.byteLength; i++) rxBuffer.push(v.getUint8(i))
}

/** Clear all link state. Safe to call twice, and whatever half-connected. */
function teardown() {
  for (const p of queue.splice(0)) p.resolve(FAILED)
  txChar.value?.removeEventListener('characteristicvaluechanged', onNotify)
  device.value?.removeEventListener('gattserverdisconnected', onDisconnected)
  device.value = null
  rxChar.value = null
  txChar.value = null
  connected.value = false
  portLabel.value = 'Not connected'
  rxBuffer = []
  lastButtons = 0
}

function onDisconnected() {
  if (connected.value) lastError.value = 'Bluetooth link lost'
  teardown()
}

/**
 * Always a write with response. The firmware refuses unpaired writes, and that
 * refusal is what makes the OS ask for the passkey; a write without response
 * would be dropped silently instead.
 */
async function write(frame: Uint8Array) {
  const c = rxChar.value
  if (!c) throw new Error('Not connected')
  await (c.writeValueWithResponse ? c.writeValueWithResponse(frame) : c.writeValue(frame))
}

async function waitReply(cmd: number): Promise<SendResult> {
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

async function transact(frame: Uint8Array, cmd: number): Promise<SendResult> {
  rxBuffer = []
  try {
    await write(frame)
  } catch (err) {
    lastError.value = (err as Error).message
    return FAILED
  }
  return waitReply(cmd)
}

async function pump() {
  if (pumping) return
  pumping = true
  try {
    while (queue.length && rxChar.value) {
      const next = queue.shift()!
      next.resolve(await transact(next.frame, next.cmd))
    }
  } finally {
    pumping = false
  }
}

export function useBleLink() {
  const supported = computed(() => !!bluetooth())

  async function connect() {
    const bt = bluetooth()
    if (!bt) {
      lastError.value = 'Web Bluetooth is not available in this browser'
      return false
    }
    if (device.value) await disconnect()

    connecting.value = true
    lastError.value = null
    try {
      const d = await bt.requestDevice({ filters: [{ services: [BLE_SERVICE] }] })
      device.value = d
      d.addEventListener('gattserverdisconnected', onDisconnected)

      const server = await d.gatt!.connect()
      const service = await server.getPrimaryService(BLE_SERVICE)
      rxChar.value = await service.getCharacteristic(BLE_RX)
      txChar.value = await service.getCharacteristic(BLE_TX)
      txChar.value.addEventListener('characteristicvaluechanged', onNotify)
      await txChar.value.startNotifications()

      // The first write is the one that pairs, so it may sit behind the OS
      // passkey prompt for as long as the user takes. Its reply also proves
      // the far end is the KVM firmware and not just something advertising
      // the same service.
      rxBuffer = []
      await write(getInfoFrame())
      const info = await waitReply(CMD.GET_INFO)
      if (!info.ok) throw new Error('The KVM did not answer over Bluetooth')

      connected.value = true
      portLabel.value = d.name ?? 'Bluetooth'
      return true
    } catch (err) {
      const e = err as Error
      // A cancelled picker is a normal outcome, not a failure worth reporting.
      if (e.name !== 'NotFoundError') lastError.value = e.message
      await disconnect()
      return false
    } finally {
      connecting.value = false
    }
  }

  async function disconnect() {
    const d = device.value
    teardown()
    try {
      d?.gatt?.disconnect()
    } catch {
      // Already gone.
    }
  }

  /** Queue a frame and wait for its acknowledgement. */
  function sendAndWait(frame: Uint8Array, cmd: number): Promise<SendResult> {
    if (!rxChar.value) return Promise.resolve(FAILED)
    const pointer = cmd === CMD.MOUSE_ABS || cmd === CMD.MOUSE_REL
    const pinned = pointer && frame[6] !== lastButtons
    if (pointer) lastButtons = frame[6]!

    return new Promise((resolve) => {
      const last = queue[queue.length - 1]
      const merged = last && !last.pinned ? coalesceMove(last.frame, frame) : null
      if (last && merged) {
        // The older move was overtaken, which is what the user asked for.
        last.resolve({ ok: true, timeout: false, payload: null })
        last.frame = merged
        last.resolve = resolve
      } else {
        queue.push({ frame, cmd, resolve, pinned })
      }
      void pump()
    })
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
  }
}
