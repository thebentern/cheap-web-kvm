// SPDX-License-Identifier: GPL-3.0-or-later
import { decode, encode, MAX_IO, OP, type Message } from './protocol'
import { websocketTransport, type MediaTransport } from './transport'
export type { MediaTransport } from './transport'
export interface MediaReadStats {
  requests: number
  totalMs: number
  maxMs: number
}
export class MediaConnection {
  private transport: MediaTransport | null = null
  private generation = 0
  private next = 0
  private session = 0
  private pending = new Map<
    number,
    {
      op: number
      resolve: (m: Message) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private heartbeat?: ReturnType<typeof setInterval>
  private serving: MediaTransport | null = null
  private reads: MediaReadStats = { requests: 0, totalMs: 0, maxMs: 0 }
  onState = (_flags: number) => {}
  onError = (_message: string) => {}
  onActivity = (_bytes: number, _write: boolean) => {}
  /** Browser receipt to response handoff; excludes Wi-Fi transit and target IO. */
  onReadResponse = (_stats: MediaReadStats) => {}
  constructor(
    private storage: {
      read(offset: number, length: number): Promise<Uint8Array>
      write(offset: number, data: Uint8Array): Promise<void>
    },
  ) {}
  async connect(target: string | MediaTransport) {
    this.close()
    this.resetReadStats()
    const mine = this.generation
    const transport =
      typeof target === 'string' ? await websocketTransport(target) : target
    if (mine !== this.generation) {
      transport.close()
      throw new Error('Media connection replaced')
    }
    this.transport = transport
    transport.onmessage = (data) => {
      void this.receive(transport, data)
    }
    transport.onclose = () => {
      if (this.transport === transport)
        this.fail(
          'Media connection lost. Target requests will fail; committed writes remain saved. Eject/unmount the target before recovery.',
        )
    }
    let hello: Message
    try {
      try {
        hello = await this.request(OP.HELLO)
      } catch (error) {
        if (
          !transport.startupRetries ||
          !/timed out/.test((error as Error).message) ||
          transport !== this.transport
        )
          throw error
        hello = await this.request(OP.HELLO)
      }
    } catch (error) {
      if (this.transport === transport) this.close()
      throw error
    }
    if (
      hello.data.length !== 8 ||
      hello.data[0] !== 1 ||
      hello.data[2] !== 0 ||
      hello.data[3] !== 2 ||
      hello.data[4] !== 0 ||
      hello.data[5] !== 32
    ) {
      this.close()
      throw new Error('Incompatible media capabilities')
    }
    this.session = hello.session
    this.heartbeat = setInterval(() => {
      void this.request(OP.HEARTBEAT)
        .then((m) => {
          if (transport === this.transport) this.onState(m.data[0] ?? 0)
        })
        .catch((e) => {
          if (transport === this.transport) this.fail(e.message)
        })
    }, 1000)
  }
  get live() {
    return this.transport !== null && this.session !== 0
  }
  resetReadStats() {
    this.reads = { requests: 0, totalMs: 0, maxMs: 0 }
    this.onReadResponse({ ...this.reads })
  }
  private fail(message: string) {
    this.close()
    this.onError(message)
  }
  close() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.generation++
    const transport = this.transport
    this.transport = null
    this.serving = null
    if (transport) {
      transport.onmessage = () => {}
      transport.onclose = () => {}
      transport.close()
    }
    this.session = 0
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('Media connection closed'))
    }
    this.pending.clear()
  }
  async request(
    op: number,
    data: Uint8Array = new Uint8Array(),
    offset = 0,
    flags = 0,
  ) {
    const transport = this.transport
    if (!transport) throw new Error('Connect the media backend first')
    if (this.pending.size >= 4)
      throw new Error('Too many pending controls; wait for the current action')
    const id = ++this.next
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            'Media control timed out; synchronize before changing media',
          ),
        )
      }, 4000)
      this.pending.set(id, { op: op | 128, resolve, reject, timer })
      Promise.resolve()
        .then(() =>
          transport.send(
            encode({
              op,
              session: this.session,
              id,
              offset,
              flags,
              length: data.length,
              data,
            }),
          ),
        )
        .catch((error) => {
          if (transport === this.transport)
            this.fail(`Media send failed: ${(error as Error).message}`)
        })
    })
  }
  private async receive(transport: MediaTransport, input: Uint8Array) {
    const receivedAt = performance.now()
    if (transport !== this.transport) return
    let m: Message
    try {
      m = decode(input)
    } catch (e) {
      this.fail((e as Error).message)
      return
    }
    if (m.op & 128) {
      const p = this.pending.get(m.id)
      if (!p || p.op !== m.op || (this.session && this.session !== m.session))
        return
      if (m.length !== m.data.length) {
        this.fail('Invalid control reply length')
        return
      }
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.flags)
        p.reject(
          new Error(
            (
              {
                1: 'Invalid media request',
                2: 'Disk is busy; wait for transfers to finish',
                3: 'Stale session; reconnect and reinsert',
                4: 'Storage error',
                5: 'Disk is read-only',
                6: 'Backend offline',
                7: 'Target has prevented removal. Unmount/eject it in the target OS first.',
              } as Record<number, string>
            )[m.flags] ?? `Media error ${m.flags}`,
          ),
        )
      else p.resolve(m)
      return
    }
    if (
      m.session !== this.session ||
      ![OP.READ, OP.WRITE].includes(m.op as 16 | 17)
    )
      return
    if (this.serving === transport) {
      this.fail('Firmware exceeded the negotiated one-request window')
      return
    }
    this.serving = transport
    let data: Uint8Array = new Uint8Array(),
      flags = 0
    try {
      if (
        !m.length ||
        m.length > MAX_IO ||
        m.data.length !== (m.op === OP.WRITE ? m.length : 0)
      )
        throw new Error('Invalid disk request length')
      if (m.op === OP.READ) {
        data = await this.storage.read(m.offset, m.length)
        if (data.length !== m.length) throw new Error('Short disk read')
      } else await this.storage.write(m.offset, m.data) // resolves only after strict storage commit
      if (transport === this.transport)
        this.onActivity(m.length, m.op === OP.WRITE)
    } catch (e) {
      flags = 4
      data = new Uint8Array()
      if (transport === this.transport)
        this.onError(`Disk request failed: ${(e as Error).message}`)
    } finally {
      if (this.serving === transport) this.serving = null
    }
    // Never send a stale response after a disconnect, replacement, or lease loss.
    if (transport === this.transport && m.session === this.session)
      try {
        await transport.send(encode({ ...m, op: m.op | 128, flags, data }))
        if (
          m.op === OP.READ &&
          !flags &&
          transport === this.transport &&
          m.session === this.session
        ) {
          const milliseconds = performance.now() - receivedAt
          this.reads.requests++
          this.reads.totalMs += milliseconds
          this.reads.maxMs = Math.max(this.reads.maxMs, milliseconds)
          this.onReadResponse({ ...this.reads })
        }
      } catch (error) {
        if (transport === this.transport)
          this.fail(`Media send failed: ${(error as Error).message}`)
      }
  }
  async benchmark(milliseconds = 2000) {
    const data = crypto.getRandomValues(new Uint8Array(MAX_IO)),
      start = performance.now()
    let bytes = 0,
      count = 0,
      maxMs = 0
    do {
      const tick = performance.now(),
        reply = await this.request(OP.ECHO, data)
      if (
        reply.data.length !== data.length ||
        reply.data.some((v, i) => v !== data[i])
      )
        throw new Error('Benchmark integrity mismatch')
      maxMs = Math.max(maxMs, performance.now() - tick)
      bytes += data.length * 2
      count++
    } while (performance.now() - start < milliseconds)
    return {
      bytesPerSecond: bytes / ((performance.now() - start) / 1000),
      maxMs,
      count,
      transport: this.transport?.label ?? 'Disconnected',
      measuredAt: new Date().toISOString(),
    }
  }
}
