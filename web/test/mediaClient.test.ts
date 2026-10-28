// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaConnection, type MediaReadStats } from '../app/utils/media/client'
import { encode, decode, MAX_IO, LEGACY_WIFI_MAX_IO, SERIAL_MAX_IO, OP, type Message } from '../app/utils/media/protocol'
import { websocketTransport } from '../app/utils/media/transport'
class Socket {
  static OPEN = 1
  static all: Socket[] = []
  readyState = 1
  binaryType = ''
  onopen?: () => void
  onerror?: () => void
  onclose?: (event?: { code: number; reason?: string }) => void
  onmessage?: (e: { data: ArrayBufferLike }) => void
  sent: Message[] = []
  constructor(_url: string) {
    Socket.all.push(this)
    queueMicrotask(() => this.onopen?.())
  }
  send(b: Uint8Array) {
    const m = decode(b)
    this.sent.push(m)
    if (m.op === OP.HELLO)
      this.receive({
        ...m,
        op: m.op | 128,
        session: 123,
        length: 8,
        data: new Uint8Array([1, 1, 0, 2, 0, 32, 1, 0]),
      })
    if ([OP.ECHO, OP.HEARTBEAT, OP.EJECT].includes(m.op as 4 | 5 | 3))
      this.receive({ ...m, op: m.op | 128 })
  }
  receive(m: Message) {
    queueMicrotask(() => this.onmessage?.({ data: encode(m).buffer }))
  }
  close() {
    this.readyState = 3
  }
}
class StalledHeartbeatSocket extends Socket {
  send(bytes: Uint8Array) {
    const m = decode(bytes)
    if (m.op === OP.HEARTBEAT) this.sent.push(m)
    else super.send(bytes)
  }
}
function capabilitySocket(data: Uint8Array) {
  return class extends Socket {
    send(bytes: Uint8Array) {
      const m = decode(bytes)
      if (m.op !== OP.HELLO) return super.send(bytes)
      this.sent.push(m)
      this.receive({ ...m, op: m.op | 128, session: 123, length: data.length, data })
    }
  }
}
const capabilities = (ceiling = MAX_IO, window = 1) => {
  const units = ceiling > 65535 ? ceiling / 512 : ceiling
  return new Uint8Array([1, window, 0, 2, units & 255, units >>> 8, ceiling > 65535 ? 3 : 1, 0])
}
const connections: MediaConnection[] = []
afterEach(() => {
  for (const c of connections) c.close()
  connections.length = 0
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function connect(
  storage = {
    read: async (_o: number, n: number) => new Uint8Array(n).fill(42),
    write: async (_o: number, _d: Uint8Array) => {},
  },
  socket = Socket,
) {
  vi.stubGlobal('WebSocket', socket)
  const c = new MediaConnection(storage)
  connections.push(c)
  await c.connect('wss://example/media')
  return { c, ws: Socket.all.at(-1)! }
}
const request = (op: number, id = 50): Message => ({
  op,
  id,
  session: 123,
  offset: 4096,
  length: 512,
  flags: 0,
  data: op === OP.WRITE ? new Uint8Array(512).fill(3) : new Uint8Array(),
})
describe('client media flow and durability', () => {
  it('keeps one heartbeat pending through a reply stall and resumes without disconnecting', async () => {
    vi.useFakeTimers()
    const { c, ws } = await connect(undefined, StalledHeartbeatSocket)
    const errors = vi.fn(), state = vi.fn()
    c.onError = errors
    c.onState = state
    await vi.advanceTimersByTimeAsync(6000)
    const heartbeats = ws.sent.filter((m) => m.op === OP.HEARTBEAT)
    expect(heartbeats).toHaveLength(1)
    expect(c.live).toBe(true)
    expect(errors).not.toHaveBeenCalled()
    ws.receive({ ...heartbeats[0]!, op: OP.HEARTBEAT | 128, length: 1, data: new Uint8Array([4]) })
    await vi.advanceTimersByTimeAsync(0)
    expect(state).toHaveBeenCalledExactlyOnceWith(4)
    await vi.advanceTimersByTimeAsync(1000)
    expect(ws.sent.filter((m) => m.op === OP.HEARTBEAT)).toHaveLength(2)
    expect(c.live).toBe(true)
    expect(errors).not.toHaveBeenCalled()
  })
  it('bounds heartbeat response waits at twelve seconds without extending user controls', async () => {
    vi.useFakeTimers()
    const { c } = await connect(undefined, StalledHeartbeatSocket)
    const errors = vi.fn()
    c.onError = errors
    const control = expect(c.request(OP.STATUS)).rejects.toThrow(/Media control timed out/)
    await vi.advanceTimersByTimeAsync(4000)
    await control
    expect(c.live).toBe(true)
    await vi.advanceTimersByTimeAsync(8999) // Heartbeat started at 1 s, expires at 13 s.
    expect(c.live).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.live).toBe(false)
    expect(errors).toHaveBeenCalledExactlyOnceWith('Media heartbeat timed out; synchronize before changing media')
  })
  it('waits for a control slot rather than failing the connection when the window is full', async () => {
    vi.useFakeTimers()
    const { c, ws } = await connect()
    const controls = Array.from({ length: 4 }, () => c.request(OP.STATUS))
    const errors = vi.fn()
    c.onError = errors
    await vi.advanceTimersByTimeAsync(1000)
    expect(ws.sent.filter((m) => m.op === OP.HEARTBEAT)).toHaveLength(0)
    expect(errors).not.toHaveBeenCalled()
    for (const m of ws.sent.filter((m) => m.op === OP.STATUS)) ws.receive({ ...m, op: m.op | 128 })
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all(controls)
    await vi.advanceTimersByTimeAsync(1000)
    expect(ws.sent.filter((m) => m.op === OP.HEARTBEAT)).toHaveLength(1)
    expect(c.live).toBe(true)
  })
  it('does not let a late old heartbeat clear or update a replacement session', async () => {
    vi.useFakeTimers()
    const { c } = await connect()
    const actual = c.request.bind(c)
    const waiting: ((reply: Message) => void)[] = []
    vi.spyOn(c, 'request').mockImplementation((op, data, offset, flags) =>
      op === OP.HEARTBEAT
        ? new Promise<Message>((resolve) => waiting.push(resolve))
        : actual(op, data, offset, flags),
    )
    const state = vi.fn(), errors = vi.fn()
    c.onState = state
    c.onError = errors
    await vi.advanceTimersByTimeAsync(1000)
    await c.connect('wss://replacement/media')
    await vi.advanceTimersByTimeAsync(1000)
    expect(waiting).toHaveLength(2)
    const reply = (flag: number): Message => ({ op: OP.HEARTBEAT | 128, flags: 0, session: 123, id: 1, offset: 0, length: 1, data: new Uint8Array([flag]) })
    waiting[0]!(reply(8))
    await vi.advanceTimersByTimeAsync(0)
    expect(state).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(waiting).toHaveLength(2) // Old finally must not release the new pending slot.
    waiting[1]!(reply(4))
    await vi.advanceTimersByTimeAsync(0)
    expect(state).toHaveBeenCalledExactlyOnceWith(4)
    expect(errors).not.toHaveBeenCalled()
    expect(c.live).toBe(true)
  })
  it('preserves the server close cause through an outstanding HELLO without echoing its private reason', async () => {
    class ClosingSocket extends Socket {
      send(_bytes: Uint8Array) {
        queueMicrotask(() =>
          this.onclose?.({
            code: 4009,
            reason: 'private-token-must-not-appear',
          }),
        )
      }
    }
    vi.stubGlobal('WebSocket', ClosingSocket)
    const c = new MediaConnection({
      read: async (_offset, length) => new Uint8Array(length),
      write: async () => {},
    })
    connections.push(c)
    const errors: string[] = []
    c.onError = (error) => errors.push(error)
    const failure = await c
      .connect('wss://example/media')
      .catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(errors[0])
    expect(errors[0]).toMatch(/Another connection.*WebSocket 4009/)
    expect(errors[0]).not.toContain('private-token-must-not-appear')
    expect(errors[0]).not.toContain('Eject/unmount')
    expect(c.live).toBe(false)
  })
  it('preserves a corrupt HELLO reply cause instead of replacing it with a generic close error', async () => {
    class CorruptSocket extends Socket {
      send(bytes: Uint8Array) {
        const m = decode(bytes)
        const reply = encode({ ...m, op: m.op | 128 })
        reply[28]! ^= 1
        queueMicrotask(() => this.onmessage?.({ data: reply.buffer }))
      }
    }
    vi.stubGlobal('WebSocket', CorruptSocket)
    const c = new MediaConnection({
      read: async (_offset, length) => new Uint8Array(length),
      write: async () => {},
    })
    connections.push(c)
    await expect(c.connect('wss://example/media')).rejects.toThrow(
      'Media integrity check failed',
    )
  })
  it('preserves send failures for pending controls and keeps explicit close generic', async () => {
    const { c, ws } = await connect()
    ws.send = () => {
      throw new Error('Test cable failure')
    }
    await expect(c.request(OP.STATUS)).rejects.toThrow(
      'Media send failed: Test cable failure',
    )
    const explicit = await connect()
    const pending = expect(explicit.c.request(OP.STATUS)).rejects.toThrow(
      /^Media connection closed$/,
    )
    explicit.c.close()
    await pending
  })
  it.each([
    [4001, /session expired/],
    [4003, /refused this browser/],
    [4009, /Another connection/],
    [1006, /interrupted/],
  ])(
    'reports actionable safe WebSocket close status %s',
    async (code, expected) => {
      vi.stubGlobal('WebSocket', Socket)
      const transport = await websocketTransport('wss://example/media')
      const closed = vi.fn()
      transport.onclose = closed
      Socket.all
        .at(-1)!
        .onclose?.({
          code: code as number,
          reason: 'private-reason-not-for-display',
        })
      const reason = closed.mock.calls[0]![0] as string
      expect(reason).toMatch(expected as RegExp)
      expect(reason).toContain(`WebSocket ${code}`)
      expect(reason).not.toContain('private-reason-not-for-display')
      transport.close()
    },
  )
  it('serves exact random-access reads and verifies round-trip benchmark contents', async () => {
    const { c, ws } = await connect()
    ws.receive(request(OP.READ))
    await tick()
    await tick()
    expect(ws.sent.at(-1)?.op).toBe(OP.READ | 128)
    expect(ws.sent.at(-1)?.data).toEqual(new Uint8Array(512).fill(42))
    expect((await c.benchmark(0)).count).toBe(1)
  })
  it('measures successful browser read response handoff, excludes writes and resets for a new disk', async () => {
    let now = 1000
    const durations = [10, 40]
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { c, ws } = await connect({
      read: async (_offset, length) => {
        now += durations.shift()!
        return new Uint8Array(length)
      },
      write: async () => {
        now += 100
      },
    })
    const stats: MediaReadStats[] = []
    c.onReadResponse = (sample) => stats.push(sample)
    const send = ws.send.bind(ws)
    ws.send = (data) => {
      if (decode(data).op === (OP.READ | 128)) now += 5
      send(data)
    }
    ws.receive(request(OP.READ))
    await tick()
    expect(stats).toEqual([{ requests: 1, totalMs: 15, maxMs: 15 }])
    ws.receive(request(OP.WRITE, 51))
    await tick()
    expect(stats).toHaveLength(1)
    ws.receive(request(OP.READ, 52))
    await tick()
    expect(stats).toEqual([
      { requests: 1, totalMs: 15, maxMs: 15 },
      { requests: 2, totalMs: 60, maxMs: 45 },
    ])
    c.resetReadStats()
    expect(stats.at(-1)).toEqual({ requests: 0, totalMs: 0, maxMs: 0 })
  })
  it('does not count failed reads, failed sends or a response completed after disconnect', async () => {
    const failed = await connect({
      read: async () => new Uint8Array(1),
      write: async () => {},
    })
    const stats = vi.fn()
    failed.c.onReadResponse = stats
    failed.ws.receive(request(OP.READ))
    await tick()
    expect(failed.ws.sent.at(-1)?.flags).toBe(4)
    expect(stats).not.toHaveBeenCalled()

    const sending = await connect()
    sending.c.onReadResponse = stats
    sending.ws.send = () => {
      throw new Error('Disconnected before handoff')
    }
    sending.ws.receive(request(OP.READ))
    await tick()
    expect(sending.c.live).toBe(false)
    expect(stats).not.toHaveBeenCalled()

    let finish!: (value: Uint8Array) => void
    const late = await connect({
      read: () => new Promise<Uint8Array>((resolve) => (finish = resolve)),
      write: async () => {},
    })
    late.c.onReadResponse = stats
    late.ws.receive(request(OP.READ))
    await tick()
    late.c.close()
    finish(new Uint8Array(512))
    await tick()
    expect(late.ws.sent).toHaveLength(1)
    expect(stats).not.toHaveBeenCalled()
  })
  it('never acknowledges a write before durable storage resolves', async () => {
    let commit!: () => void
    const storage = {
      read: async (_o: number, n: number) => new Uint8Array(n),
      write: () =>
        new Promise<void>((r) => {
          commit = r
        }),
    }
    const { ws } = await connect(storage)
    ws.receive(request(OP.WRITE))
    await tick()
    expect(ws.sent).toHaveLength(1)
    commit()
    await tick()
    expect(ws.sent.at(-1)?.op).toBe(OP.WRITE | 128)
    expect(ws.sent.at(-1)?.flags).toBe(0)
  })
  it('drops late write replies after disconnect without canceling storage commit', async () => {
    let commit!: () => void,
      persisted = false
    const storage = {
      read: async (_o: number, n: number) => new Uint8Array(n),
      write: async () => {
        await new Promise<void>((r) => {
          commit = r
        })
        persisted = true
      },
    }
    const { c, ws } = await connect(storage)
    ws.receive(request(OP.WRITE))
    await tick()
    c.close()
    commit()
    await tick()
    expect(persisted).toBe(true)
    expect(ws.sent).toHaveLength(1)
  })
  it('reports quota failures and short reads as failed IO with no fabricated data', async () => {
    const { c, ws } = await connect({
      read: async () => new Uint8Array(1),
      write: async () => {
        throw new Error('Quota exceeded')
      },
    })
    const errors: string[] = []
    c.onError = (e) => errors.push(e)
    ws.receive(request(OP.WRITE))
    await tick()
    expect(ws.sent.at(-1)?.flags).toBe(4)
    ws.receive(request(OP.READ, 51))
    await tick()
    expect(ws.sent.at(-1)?.flags).toBe(4)
    expect(ws.sent.at(-1)?.data).toHaveLength(0)
    expect(errors.join(' ')).toMatch(/Quota exceeded.*Short disk read/)
  })
  it('ignores old sessions and refuses more than one outstanding disk operation', async () => {
    let commit!: () => void
    const { c, ws } = await connect({
      read: async (_o: number, n: number) => new Uint8Array(n),
      write: () =>
        new Promise<void>((r) => {
          commit = r
        }),
    })
    const errors: string[] = []
    c.onError = (e) => errors.push(e)
    ws.receive({ ...request(OP.READ), session: 122 })
    await tick()
    expect(ws.sent).toHaveLength(1)
    ws.receive(request(OP.WRITE))
    await tick()
    ws.receive(request(OP.READ, 51))
    await tick()
    expect(errors[0]).toMatch(/window/)
    expect(ws.readyState).toBe(3)
    commit()
    await tick()
    expect(ws.sent).toHaveLength(1)
  })
})

describe('negotiated media transfer ceilings', () => {
  it('retries HELLO at 32 KiB when older firmware rejects a larger ceiling', async () => {
    class LegacyFirmware extends Socket {
      send(bytes: Uint8Array) {
        const m = decode(bytes)
        if (m.op !== OP.HELLO) return super.send(bytes)
        this.sent.push(m)
        const flags = m.offset > LEGACY_WIFI_MAX_IO ? 1 : 0
        const data = flags ? new Uint8Array() : capabilities(LEGACY_WIFI_MAX_IO)
        this.receive({ ...m, op: m.op | 128, flags, session: 123, length: data.length, data })
      }
    }
    const { c, ws } = await connect(undefined, LegacyFirmware)
    expect(ws.sent.filter((m) => m.op === OP.HELLO).map((m) => m.offset)).toEqual([MAX_IO, LEGACY_WIFI_MAX_IO])
    await c.benchmark(0)
    expect(ws.sent.find((m) => m.op === OP.ECHO)?.data).toHaveLength(LEGACY_WIFI_MAX_IO)
    expect(c.live).toBe(true)
  })
  it('does not retry a refused or busy handshake as legacy negotiation', async () => {
    for (const flags of [2, 3, 4]) {
      class RefusedFirmware extends Socket {
        send(bytes: Uint8Array) {
          const m = decode(bytes)
          this.sent.push(m)
          this.receive({ ...m, op: m.op | 128, flags, session: 123, length: 0, data: new Uint8Array() })
        }
      }
      await expect(connect(undefined, RefusedFirmware)).rejects.toThrow()
      expect(Socket.all.at(-1)!.sent).toHaveLength(1)
    }
  })
  it.each([SERIAL_MAX_IO, 16384, LEGACY_WIFI_MAX_IO, 65536, MAX_IO])('requests 128 KiB and respects an advertised %s-byte ceiling', async (ceiling) => {
    const { c, ws } = await connect(undefined, capabilitySocket(capabilities(ceiling)))
    const hello = ws.sent.find((m) => m.op === OP.HELLO)!
    expect(hello.offset).toBe(MAX_IO)
    expect(hello.length).toBe(0)
    expect(hello.data).toHaveLength(0)
    await c.benchmark(0)
    expect(ws.sent.find((m) => m.op === OP.ECHO)?.data).toHaveLength(ceiling)
    expect(c.live).toBe(true)
  })
  it.each([0, 4096, SERIAL_MAX_IO + 1, MAX_IO + 512, 65535])('rejects an invalid %s-byte capability', async (ceiling) => {
    await expect(connect(undefined, capabilitySocket(capabilities(ceiling)))).rejects.toThrow(/Incompatible media capabilities/)
    expect(Socket.all.at(-1)!.readyState).toBe(3)
  })
  it('requires the one-request contract, complete capabilities and 512-byte blocks', async () => {
    const wrongBlock = capabilities()
    wrongBlock[3] = 1
    for (const data of [capabilities(MAX_IO, 2), capabilities().subarray(0, 7), wrongBlock])
      await expect(connect(undefined, capabilitySocket(data))).rejects.toThrow(/Incompatible media capabilities/)
    const unknownUnits = capabilities(LEGACY_WIFI_MAX_IO)
    unknownUnits[6] = 5
    await expect(connect(undefined, capabilitySocket(unknownUnits))).rejects.toThrow(/Incompatible media capabilities/)
  })
  it('serves 128 KiB random reads and waits for durable 128 KiB writes before ACK', async () => {
    vi.useFakeTimers()
    let commit!: () => void
    const content = Uint8Array.from({ length: MAX_IO }, (_, i) => (i * 17) & 255)
    const read = vi.fn(async () => content.slice())
    const write = vi.fn(() => new Promise<void>((resolve) => { commit = resolve }))
    const { c, ws } = await connect({ read, write }, capabilitySocket(capabilities()))
    const offset = 8 * 1073741824 + 65530
    ws.receive({ ...request(OP.READ), offset, length: MAX_IO })
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledWith(offset, MAX_IO)
    const readReply = ws.sent.find((m) => m.op === (OP.READ | 128))
    expect(readReply).toMatchObject({ id: 50, session: 123, flags: 0, offset, length: MAX_IO })
    expect(readReply?.data).toEqual(content)
    const writeReplies = () => ws.sent.filter((m) => m.op === (OP.WRITE | 128))
    ws.receive({ ...request(OP.WRITE, 51), offset, length: MAX_IO, data: content })
    await vi.advanceTimersByTimeAsync(0)
    expect(write).toHaveBeenCalledWith(offset, content)
    expect(writeReplies()).toHaveLength(0)
    // A keepalive may be the newest frame while storage is still committing.
    await vi.advanceTimersByTimeAsync(1000)
    expect(ws.sent.at(-1)?.op).toBe(OP.HEARTBEAT)
    expect(writeReplies()).toHaveLength(0)
    commit()
    await vi.advanceTimersByTimeAsync(0)
    // And another heartbeat may follow the ACK before the assertion runs.
    await vi.advanceTimersByTimeAsync(1000)
    expect(ws.sent.at(-1)?.op).toBe(OP.HEARTBEAT)
    expect(writeReplies()).toHaveLength(1)
    expect(writeReplies()[0]).toMatchObject({ id: 51, session: 123, flags: 0, offset, length: MAX_IO })
    expect(writeReplies()[0]?.data).toHaveLength(0)
    expect(c.live).toBe(true)
  })
  it('refuses disk requests and outgoing controls above a legacy ceiling without accessing storage', async () => {
    const read = vi.fn(async (_offset: number, length: number) => new Uint8Array(length)),
      write = vi.fn(async () => {})
    const { c, ws } = await connect({ read, write })
    ws.receive({ ...request(OP.READ), length: SERIAL_MAX_IO + 512 })
    await tick()
    expect(read).not.toHaveBeenCalled()
    expect(ws.sent.at(-1)?.flags).toBe(4)
    ws.receive({ ...request(OP.WRITE, 51), length: SERIAL_MAX_IO + 512, data: new Uint8Array(SERIAL_MAX_IO + 512) })
    await tick()
    expect(write).not.toHaveBeenCalled()
    expect(ws.sent.at(-1)?.flags).toBe(4)
    const before = ws.sent.length
    await expect(c.request(OP.ECHO, new Uint8Array(SERIAL_MAX_IO + 1))).rejects.toThrow(/negotiated 8192-byte/)
    await expect(c.request(OP.HID, new Uint8Array(SERIAL_MAX_IO + 1))).rejects.toThrow(/negotiated 8192-byte/)
    expect(ws.sent).toHaveLength(before)
    expect(c.live).toBe(true)
  })
  it('rejects an oversized control reply instead of accepting data above the negotiated ceiling', async () => {
    class OversizedReplySocket extends Socket {
      send(bytes: Uint8Array) {
        const m = decode(bytes)
        if (m.op !== OP.ECHO) return super.send(bytes)
        this.sent.push(m)
        this.receive({ ...m, op: m.op | 128, length: MAX_IO, data: new Uint8Array(MAX_IO) })
      }
    }
    const { c } = await connect(undefined, OversizedReplySocket)
    await expect(c.request(OP.ECHO, new Uint8Array(512))).rejects.toThrow(/Invalid control reply length/)
    expect(c.live).toBe(false)
  })
  it('resets the ceiling when reconnecting from a faster board to legacy firmware', async () => {
    const { c } = await connect(undefined, capabilitySocket(capabilities()))
    await c.benchmark(0)
    vi.stubGlobal('WebSocket', Socket)
    await c.connect('wss://legacy/media')
    await c.benchmark(0)
    expect(Socket.all.at(-1)!.sent.find((m) => m.op === OP.ECHO)?.data).toHaveLength(SERIAL_MAX_IO)
    await expect(c.request(OP.ECHO, new Uint8Array(MAX_IO))).rejects.toThrow(/negotiated 8192-byte/)
  })
})
