// SPDX-License-Identifier: GPL-3.0-or-later
/** A message-oriented connection. Serial adapters supply the packet framing. */
export interface MediaTransport {
  readonly label: string
  /** Read-only HELLO may be retried while a USB-open reset finishes booting. */
  readonly startupRetries?: number
  send(data: Uint8Array): void | Promise<void>
  close(): void
  onmessage: (data: Uint8Array) => void
  onclose: () => void
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
    ws.onclose = () => {
      clearTimeout(timeout)
      reject(new Error('Connection closed'))
      transport.onclose()
    }
  })
  ws.onmessage = (event) => transport.onmessage(new Uint8Array(event.data))
  ws.onclose = () => transport.onclose()
  return transport
}
