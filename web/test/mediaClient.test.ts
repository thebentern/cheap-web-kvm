// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaConnection, type MediaReadStats } from '../app/utils/media/client'
import { encode, decode, OP, type Message } from '../app/utils/media/protocol'
class Socket {
  static OPEN = 1
  static all: Socket[] = []
  readyState = 1
  binaryType = ''
  onopen?: () => void
  onerror?: () => void
  onclose?: () => void
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
const connections: MediaConnection[] = []
afterEach(() => {
  for (const c of connections) c.close()
  connections.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function connect(
  storage = {
    read: async (_o: number, n: number) => new Uint8Array(n).fill(42),
    write: async (_o: number, _d: Uint8Array) => {},
  },
) {
  vi.stubGlobal('WebSocket', Socket)
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
