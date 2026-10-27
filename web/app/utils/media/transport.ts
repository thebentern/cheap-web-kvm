// SPDX-License-Identifier: GPL-3.0-or-later
/** A message-oriented connection. Serial adapters supply the packet framing. */
export interface MediaTransport {
  readonly label: string
  /** Read-only HELLO may be retried while a USB-open reset finishes booting. */
  readonly startupRetries?: number
  send(data: Uint8Array): void | Promise<void>
  close(): void
  onmessage: (data: Uint8Array) => void
  onclose: (reason?: string) => void
}

function websocketCloseReason(event?: Pick<CloseEvent, 'code'>) {
  const code = event?.code
  const known: Record<number, string> = {
    1000: 'The board closed the media connection',
    1002: 'The board closed media because of a protocol error',
    1006: 'The media connection was interrupted; check the board and Wi-Fi',
    1008: 'The board refused media access; pair this browser again',
    1009: 'The board rejected a media message as too large',
    1011: 'The board closed media because of a server error',
    1013: 'The board is temporarily busy; wait before reconnecting',
    4001: 'This browser session expired; pair this browser again',
    4003: 'The board refused this browser’s access; pair this browser again',
    4009: 'Another connection is using this board; disconnect it there first',
  }
  // Do not display arbitrary server reason text: it may contain private data.
  return Number.isInteger(code) && code! >= 1000 && code! <= 4999
    ? `${known[code!] ?? 'The board closed the media connection'} (WebSocket ${code}).`
    : 'The media connection closed without a WebSocket status.'
}

export async function websocketTransport(url: string): Promise<MediaTransport> {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const transport: MediaTransport = {
    label: 'Wi-Fi WebSocket',
    send(data) {
      if (ws.readyState !== WebSocket.OPEN)
        throw new Error('Media connection closed')
      ws.send(data)
    },
    close: () => ws.close(),
    onmessage: () => {},
    onclose: () => {},
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close()
      reject(
        new Error(
          'Media connection timed out. Check Wi-Fi, the access token, and the HTTPS certificate.',
        ),
      )
    }, 5000)
    ws.onopen = () => {
      clearTimeout(timeout)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timeout)
      reject(
        new Error(
          'Cannot connect. Open the board or helper over trusted HTTPS, and check its access token.',
        ),
      )
    }
    ws.onclose = (event) => {
      clearTimeout(timeout)
      const reason = websocketCloseReason(event)
      reject(new Error(reason))
      transport.onclose(reason)
    }
  })
  ws.onmessage = (event) => transport.onmessage(new Uint8Array(event.data))
  ws.onclose = (event) => transport.onclose(websocketCloseReason(event))
  return transport
}
