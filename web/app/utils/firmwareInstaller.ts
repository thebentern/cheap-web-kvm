// SPDX-License-Identifier: GPL-3.0-or-later
import type { FlashOptions } from 'esptool-js'
import type { FirmwareBundle } from './firmwareManifest'

export interface FlashSession {
  loader: {
    chip: { CHIP_NAME: string }
    main(): Promise<string>
    detectFlashSize(): Promise<string | undefined>
    writeFlash(options: FlashOptions): Promise<void>
    after(mode: 'hard_reset'): Promise<void>
  }
  disconnect(): Promise<void>
}

export interface InstallerDependencies {
  requestPort(): Promise<SerialPort>
  disconnectControl(): Promise<void>
  createSession(port: SerialPort, log: (line: string) => void): Promise<FlashSession>
  md5(data: Uint8Array): string
}

export interface InstallerEvents {
  log(line: string): void
  chip(name: string): void
  writing(): void
  progress(percent: number): void
}

/** Request the port before the first await, while the install click is active. */
export async function installFirmware(bundle: FirmwareBundle, dependencies: InstallerDependencies, events: InstallerEvents) {
  const port = await dependencies.requestPort()
  let session: FlashSession | null = null
  let restarted = false
  try {
    // The console may still own this UART port after navigating to /flash.
    await dependencies.disconnectControl()
    session = await dependencies.createSession(port, events.log)
    await session.loader.main()
    const chip = session.loader.chip.CHIP_NAME
    events.chip(chip)
    if (chip !== 'ESP32-S3') throw new Error(`This installer needs an ESP32-S3. The selected device is ${chip}.`)
    const flashSize = await session.loader.detectFlashSize()
    const megabytes = /^(\d+)MB$/.exec(flashSize ?? '')
    if (!megabytes || Number(megabytes[1]) < 8) {
      throw new Error('The selected board must have at least 8 MB of flash. No firmware was written.')
    }
    events.log(`ESP32-S3 detected with ${flashSize} flash.`)
    events.writing()
    const totalBytes = bundle.files.reduce((sum, file) => sum + file.data.length, 0)
    const fractions = bundle.files.map(() => 0)
    await session.loader.writeFlash({
      fileArray: bundle.files,
      // These packaged headers already match the fixed board. Keeping them
      // also lets MD5 verify exactly the image written, including any padding.
      flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep',
      eraseAll: false,
      compress: true,
      calculateMD5Hash: dependencies.md5,
      reportProgress(index, written, total) {
        if (index < 0 || index >= fractions.length || total <= 0) return
        fractions[index] = Math.min(1, Math.max(fractions[index]!, written / total))
        const bytes = bundle.files.reduce((sum, file, i) => sum + file.data.length * fractions[i]!, 0)
        events.progress(Math.min(99, Math.floor(bytes / totalBytes * 100)))
      },
    })
    events.log('Firmware written and verified. Restarting the dev kit…')
    await session.loader.after('hard_reset')
    restarted = true
    events.progress(100)
  } finally {
    if (session) {
      // main() can fail after resetting into ROM or loading the RAM stub.
      // Always try to return the board to its application before closing.
      if (!restarted) {
        await session.loader.after('hard_reset').catch(() => {})
      }
      await session.disconnect().catch(() => events.log('Unplug and reconnect the UART cable if the port remains busy.'))
    } else {
      // No session owns the port yet. It may still be closed; close is best effort.
      await port.close().catch(() => {})
    }
  }
}
