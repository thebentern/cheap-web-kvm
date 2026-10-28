// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest'
import { frame } from '../app/utils/ch9329'
import { MediaConnection, type MediaTransport } from '../app/utils/media/client'
import {
  decode,
  encode,
  HEADER,
  MAX_IO,
  LEGACY_WIFI_MAX_IO,
  SERIAL_MAX_IO,
  OP,
  type Message,
} from '../app/utils/media/protocol'
import { SerialDemux, serialMediaFrame } from '../app/utils/media/serial'
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const packet = (op = OP.WRITE, id = 9): Message => ({
  op,
  id,
  session: 123,
  offset: 4096,
  flags: 0,
  length: 512,
  data: op === OP.WRITE ? new Uint8Array(512).fill(42) : new Uint8Array(),
})
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('bounded USB serial framing', () => {
  it('handles fragmented media and CH replies without interpreting embedded magic', () => {
    const controls: Uint8Array[] = [],
      media: Uint8Array[] = []
    const parser = new SerialDemux(
      (b) => controls.push(b),
      (b) => media.push(b),
    )
    cleanup.push(() => parser.reset())
    const m = packet()
    m.data.set(frame(0xb5, [1, 1, 2, 1]))
    m.data.set([75, 86, 83, 49, 0, 0], 32)
    const wire = serialMediaFrame(encode(m))
    parser.feed(new TextEncoder().encode('boot log noise\n'))
    for (let at = 0; at < wire.length; at += 7)
      parser.feed(wire.slice(at, at + 7))
    parser.feed(frame(0xb5, [75, 86, 83, 49, 0, 0]))
    expect(media).toEqual([encode(m)])
    expect(controls).toEqual([frame(0xb5, [75, 86, 83, 49, 0, 0])])
  })
  it('bounds invalid lengths and expires a truncated packet before accepting the next reply', () => {
    vi.useFakeTimers()
    const controls: Uint8Array[] = [],
      media: Uint8Array[] = []
    const parser = new SerialDemux(
      (b) => controls.push(b),
      (b) => media.push(b),
    )
    cleanup.push(() => parser.reset())
    expect(() => serialMediaFrame(new Uint8Array(HEADER + SERIAL_MAX_IO + 1))).toThrow(
      /length/,
    )
    parser.feed(new Uint8Array([75, 86, 83, 49, 255, 255]))
    parser.feed(serialMediaFrame(encode(packet())).slice(0, 20))
    vi.advanceTimersByTime(2001)
    parser.feed(frame(0x82, [0]))
    expect(controls).toEqual([frame(0x82, [0])])
    expect(media).toHaveLength(0)
  })
  it('keeps UART framing at 8 KiB while the network protocol permits 128 KiB', () => {
    const media: Uint8Array[] = [], controls: Uint8Array[] = []
    const parser = new SerialDemux((bytes) => controls.push(bytes), (bytes) => media.push(bytes))
    cleanup.push(() => parser.reset())
    const full = encode({ ...packet(), length: SERIAL_MAX_IO, data: new Uint8Array(SERIAL_MAX_IO).fill(42) })
    parser.feed(serialMediaFrame(full))
    expect(media).toEqual([full])
    const larger = encode({ ...packet(), length: MAX_IO, data: new Uint8Array(MAX_IO).fill(42) })
    expect(() => serialMediaFrame(larger)).toThrow(/length/)
    // The serial wire length itself is 16-bit: use an actually representable
    // oversized packet rather than wrapping a 128 KiB length back to 32.
    const serialOversize = encode({ ...packet(), length: LEGACY_WIFI_MAX_IO, data: new Uint8Array(LEGACY_WIFI_MAX_IO).fill(42) })
    const oversized = new Uint8Array(6 + serialOversize.length)
    oversized.set([75, 86, 83, 49, serialOversize.length & 255, serialOversize.length >>> 8])
    oversized.set(serialOversize, 6)
    parser.feed(oversized)
    parser.feed(frame(0x82, [0]))
    expect(media).toEqual([full])
    expect(controls).toEqual([frame(0x82, [0])])
  })
})

async function serialBoard(
  storage?: ConstructorParameters<typeof MediaConnection>[0],
  acknowledgeRelease = true,
) {
  const { useSerialLink } = await import('../app/composables/useSerialLink')
  let incoming!: ReadableStreamDefaultController<Uint8Array>
  const mediaSent: Message[] = [],
    wireSent: Uint8Array[] = []
  const port = {
    readable: new ReadableStream<Uint8Array>({
      start(c) {
        incoming = c
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(bytes) {
        wireSent.push(bytes)
        if (bytes[0] === 0x57) {
          incoming.enqueue(frame(bytes[3]! | 128, [0]))
          return
        }
        if (bytes.length === 6) {
          if (acknowledgeRelease)
            incoming.enqueue(serialMediaFrame(new Uint8Array()))
          return
        }
        const m = decode(bytes.slice(6))
        mediaSent.push(m)
        if (m.op === OP.HELLO) {
          const reply = serialMediaFrame(
            encode({
              ...m,
              op: m.op | 128,
              session: 123,
              length: 8,
              data: new Uint8Array([1, 1, 0, 2, 0, 32, 1, 0]),
            }),
          )
          // The real port may split a header or packet at any byte boundary.
          incoming.enqueue(reply.slice(0, 3))
          incoming.enqueue(reply.slice(3, 17))
          incoming.enqueue(reply.slice(17))
        } else if (m.op === OP.ECHO || m.op === OP.HEARTBEAT) {
          incoming.enqueue(serialMediaFrame(encode({ ...m, op: m.op | 128 })))
        }
      },
    }),
    async open() {},
    async close() {},
    getInfo() {
      return { usbVendorId: 0x303a }
    },
  }
  vi.stubGlobal('navigator', {
    serial: {
      async requestPort() {
        return port
      },
    },
  })
  const link = useSerialLink()
  cleanup.push(() => link.disconnect())
  expect(await link.connect()).toBe(true)
  const transport = link.mediaTransport()
  const c = new MediaConnection(
    storage ?? {
      read: async (_o, n) => new Uint8Array(n).fill(42),
      write: async () => {},
    },
  )
  cleanup.push(() => c.close())
  await c.connect(transport)
  return { link, c, transport, incoming, mediaSent, wireSent }
}

describe('USB media on the real serial composable', () => {
  it('requests faster negotiation but benchmarks only the advertised 8 KiB serial ceiling', async () => {
    const { c, mediaSent } = await serialBoard()
    const hello = mediaSent.find((m) => m.op === OP.HELLO)!
    expect(hello.offset).toBe(MAX_IO)
    expect(hello.data).toHaveLength(0)
    await c.benchmark(0)
    expect(mediaSent.find((m) => m.op === OP.ECHO)?.data).toHaveLength(SERIAL_MAX_IO)
  })
  it('serves durable media writes while HID transactions remain independent, and releases only media', async () => {
    let commit!: () => void
    const { link, c, incoming, mediaSent, wireSent } = await serialBoard({
      read: async (_o, n) => new Uint8Array(n),
      write: () =>
        new Promise<void>((r) => {
          commit = r
        }),
    })
    const request = packet()
    request.data.set(frame(0x82, [0]))
    const wire = serialMediaFrame(encode(request))
    for (let at = 0; at < wire.length; at += 11)
      incoming.enqueue(wire.slice(at, at + 11))
    await tick()
    expect(mediaSent).toHaveLength(1)
    expect((await link.sendAndWait(frame(2, new Array(8).fill(0)), 2)).ok).toBe(
      true,
    )
    expect(mediaSent).toHaveLength(1) // no successful WRITE reply before storage commit
    commit()
    await tick()
    await tick()
    expect(mediaSent.at(-1)?.op).toBe(OP.WRITE | 128)
    expect(mediaSent.at(-1)?.flags).toBe(0)
    expect((await c.benchmark(0)).transport).toBe('USB serial')
    c.close()
    await link.waitForMediaRelease()
    expect(wireSent.at(-1)).toEqual(serialMediaFrame(new Uint8Array()))
    expect(link.connected.value).toBe(true)
    expect((await link.sendAndWait(frame(1), 1)).ok).toBe(true)
  })
  it('fails the media session on cable removal and never sends a stale write acknowledgement', async () => {
    let commit!: () => void
    const { link, c, incoming, mediaSent } = await serialBoard({
      read: async (_o, n) => new Uint8Array(n),
      write: () =>
        new Promise<void>((r) => {
          commit = r
        }),
    })
    const errors: string[] = []
    c.onError = (e) => errors.push(e)
    incoming.enqueue(serialMediaFrame(encode(packet())))
    await tick()
    incoming.close()
    await tick()
    expect(link.connected.value).toBe(false)
    expect(c.live).toBe(false)
    expect(errors.join()).toMatch(/connection lost/)
    commit()
    await tick()
    await tick()
    expect(mediaSent).toHaveLength(1)
    expect((await link.sendAndWait(frame(1), 1)).ok).toBe(false)
  })
  it('waits for the board’s release acknowledgement before allowing another media session', async () => {
    const { link, c, incoming } = await serialBoard(undefined, false)
    c.close()
    let released = false
    const releasing = link.waitForMediaRelease().then(() => {
      released = true
    })
    await tick()
    expect(released).toBe(false)
    expect(() => link.mediaTransport()).toThrow(/closing/)
    incoming.enqueue(serialMediaFrame(new Uint8Array()))
    await releasing
    expect(released).toBe(true)
    expect(link.connected.value).toBe(true)
    const next = link.mediaTransport()
    expect(next.label).toBe('USB serial')
    next.close()
    incoming.enqueue(serialMediaFrame(new Uint8Array()))
    await link.waitForMediaRelease()
  })
  it('ignores a stale release ACK when a new media session is active', async () => {
    const { c, incoming } = await serialBoard()
    const errors: string[] = []
    c.onError = (e) => errors.push(e)
    incoming.enqueue(serialMediaFrame(new Uint8Array()))
    await tick()
    expect(c.live).toBe(true)
    expect(errors).toEqual([])
  })
  it('does not lose asynchronous media packets while a CH reply is pending', async () => {
    const { link, c, incoming, mediaSent } = await serialBoard()
    const promise = link.sendAndWait(frame(0x35), 0x35)
    incoming.enqueue(serialMediaFrame(encode(packet(OP.READ))))
    expect((await promise).ok).toBe(true)
    await tick()
    await tick()
    expect(mediaSent.at(-1)?.op).toBe(OP.READ | 128)
    expect(mediaSent.at(-1)?.data).toEqual(new Uint8Array(512).fill(42))
    expect(c.live).toBe(true)
  })
})

it('retries a read-only HELLO timeout after a USB-open reset and fails a rejected send', async () => {
  vi.useFakeTimers()
  let hello = 0
  const transport: MediaTransport = {
    label: 'USB test',
    startupRetries: 1,
    onmessage: () => {},
    onclose: () => {},
    close() {},
    send(bytes) {
      const m = decode(bytes)
      if (m.op === OP.HELLO && ++hello === 2)
        queueMicrotask(() =>
          transport.onmessage(
            encode({
              ...m,
              op: m.op | 128,
              session: 123,
              length: 8,
              data: new Uint8Array([1, 1, 0, 2, 0, 32, 1, 0]),
            }),
          ),
        )
      else if (m.op !== OP.HELLO)
        return Promise.reject(new Error('cable failed'))
    },
  }
  const c = new MediaConnection({
    read: async (_o, n) => new Uint8Array(n),
    write: async () => {},
  })
  cleanup.push(() => c.close())
  const connecting = c.connect(transport)
  await vi.advanceTimersByTimeAsync(4001)
  await connecting
  expect(hello).toBe(2)
  const errors: string[] = []
  c.onError = (e) => errors.push(e)
  await expect(c.request(OP.STATUS)).rejects.toThrow(/Media send failed: cable failed/)
  expect(c.live).toBe(false)
  expect(errors.join()).toMatch(/cable failed/)
})

function controlledTransport(): MediaTransport {
  const transport: MediaTransport = {
    label: 'Test USB',
    onmessage: () => {},
    onclose: () => {},
    close() {},
    send(bytes) {
      const m = decode(bytes)
      if (m.op === OP.HELLO)
        queueMicrotask(() =>
          transport.onmessage(
            encode({
              ...m,
              op: m.op | 128,
              session: 123,
              length: 8,
              data: new Uint8Array([1, 1, 0, 2, 0, 32, 1, 0]),
            }),
          ),
        )
    },
  }
  return transport
}
it('does not let a rejected old heartbeat close a replacement transport', async () => {
  vi.useFakeTimers()
  const first = controlledTransport(),
    second = controlledTransport()
  const c = new MediaConnection({
    read: async (_o, n) => new Uint8Array(n),
    write: async () => {},
  })
  cleanup.push(() => c.close())
  const errors: string[] = []
  c.onError = (e) => errors.push(e)
  await c.connect(first)
  await vi.advanceTimersByTimeAsync(1001) // first heartbeat remains pending
  await c.connect(second)
  await Promise.resolve()
  expect(c.live).toBe(true)
  expect(errors).toEqual([])
})
it('does not report a late old storage failure into a replacement connection', async () => {
  let rejectCommit!: (error: Error) => void
  const first = controlledTransport(),
    second = controlledTransport()
  const c = new MediaConnection({
    read: async (_o, n) => new Uint8Array(n),
    write: () =>
      new Promise<void>((_resolve, reject) => {
        rejectCommit = reject
      }),
  })
  cleanup.push(() => c.close())
  const errors: string[] = []
  c.onError = (e) => errors.push(e)
  await c.connect(first)
  first.onmessage(encode(packet()))
  await Promise.resolve()
  await c.connect(second)
  rejectCommit(new Error('old storage failed'))
  await tick()
  expect(c.live).toBe(true)
  expect(errors).toEqual([])
})
