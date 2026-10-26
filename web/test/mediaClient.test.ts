// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaConnection } from '../app/utils/media/client'
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
