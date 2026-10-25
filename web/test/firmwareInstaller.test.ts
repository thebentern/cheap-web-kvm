// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest'
import type { FlashOptions } from 'esptool-js'
import { installFirmware, type FlashSession, type InstallerDependencies, type InstallerEvents } from '../app/utils/firmwareInstaller'
import type { FirmwareBundle } from '../app/utils/firmwareManifest'

function fixture(): FirmwareBundle {
  const files = [4, 8, 12].map((length, index) => ({ address: [0, 0x8000, 0x10000][index]!, data: new Uint8Array(length).fill(index) }))
  return {
    manifest: {
      schemaVersion: 1, name: '$KVM', version: 'abc1234', board: 'ESP32-S3-DevKitC-1-N8R8',
      chipFamily: 'ESP32-S3', flashSize: '8MB', flashMode: 'dio', flashFreq: '80m',
      parts: files.map((file, index) => ({ path: ['bootloader.bin', 'partition-table.bin', 'cheap-web-kvm.bin'][index]!,
        offset: file.address, size: file.data.length, sha256: 'a'.repeat(64) })),
    }, files,
  }
}

function harness(chip = 'ESP32-S3', size: string | undefined = '8MB') {
  const calls: string[] = []
  const portClose = vi.fn(async () => { calls.push('port.close') })
  const port = { close: portClose } as unknown as SerialPort
  const session = {
    loader: {
      chip: { CHIP_NAME: chip },
      main: vi.fn(async () => { calls.push('main'); return 'ESP32-S3 (QFN56) (revision v0.2)' }),
      detectFlashSize: vi.fn(async () => { calls.push('detect'); return size }),
      writeFlash: vi.fn(async (_options: FlashOptions) => { calls.push('write') }),
      after: vi.fn(async (_mode: 'hard_reset') => { calls.push('reset') }),
    },
    disconnect: vi.fn(async () => { calls.push('disconnect') }),
  } satisfies FlashSession
  const dependencies = {
    requestPort: vi.fn(async () => { calls.push('picker'); return port }),
    disconnectControl: vi.fn(async () => { calls.push('control.disconnect') }),
    createSession: vi.fn(async (_port: SerialPort, _log: (line: string) => void) => { calls.push('session'); return session }),
    md5: vi.fn((_data: Uint8Array) => '0123456789abcdef0123456789abcdef'),
  } satisfies InstallerDependencies
  const events = {
    log: vi.fn((_line: string) => {}), chip: vi.fn((_name: string) => {}),
    writing: vi.fn(() => { calls.push('writing') }), progress: vi.fn((_percent: number) => {}),
  } satisfies InstallerEvents
  return { calls, port, portClose, session, dependencies, events, bundle: fixture() }
}

describe('firmware installation boundaries', () => {
  it('opens the picker synchronously, then releases control before creating the flash session', async () => {
    const h = harness()
    let selectPort!: (port: SerialPort) => void
    h.dependencies.requestPort.mockImplementation(() => {
      h.calls.push('picker')
      return new Promise<SerialPort>(resolve => { selectPort = resolve })
    })
    const operation = installFirmware(h.bundle, h.dependencies, h.events)
    expect(h.calls).toEqual(['picker'])
    expect(h.dependencies.disconnectControl).not.toHaveBeenCalled()
    expect(h.dependencies.createSession).not.toHaveBeenCalled()
    selectPort(h.port)
    await operation
    expect(h.calls).toEqual(['picker', 'control.disconnect', 'session', 'main', 'detect', 'writing', 'write', 'reset', 'disconnect'])
    expect(h.dependencies.createSession).toHaveBeenCalledWith(h.port, h.events.log)
    expect(h.events.chip).toHaveBeenCalledWith('ESP32-S3')
  })

  it('uses only the packaged regions, keeps headers, preserves NVS, and enables MD5 verification', async () => {
    const h = harness()
    await installFirmware(h.bundle, h.dependencies, h.events)
    const options = h.session.loader.writeFlash.mock.calls[0]![0]
    expect(options.fileArray).toBe(h.bundle.files)
    expect(options).toMatchObject({ flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep', eraseAll: false, compress: true })
    expect(options.calculateMD5Hash).toBe(h.dependencies.md5)
    const paddedBytes = Uint8Array.from([1, 2, 3, 0xff])
    expect(options.calculateMD5Hash!(paddedBytes)).toBe('0123456789abcdef0123456789abcdef')
    expect(h.dependencies.md5).toHaveBeenCalledWith(paddedBytes)
    expect(h.session.loader.after).toHaveBeenCalledExactlyOnceWith('hard_reset')
    expect(h.session.disconnect).toHaveBeenCalledTimes(1)
    expect(h.events.progress).toHaveBeenLastCalledWith(100)
  })

  it.each(['ESP32', 'ESP32-C3', 'ESP32-S2', 'unknown'])('does not write to %s', async (chip) => {
    const h = harness(chip)
    await expect(installFirmware(h.bundle, h.dependencies, h.events)).rejects.toThrow(/needs an ESP32-S3/)
    expect(h.session.loader.detectFlashSize).not.toHaveBeenCalled()
    expect(h.events.writing).not.toHaveBeenCalled()
    expect(h.session.loader.writeFlash).not.toHaveBeenCalled()
    expect(h.session.loader.after).toHaveBeenCalledWith('hard_reset')
    expect(h.session.disconnect).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, '2MB', '4MB', '8mb', '8 MB', 'unknown'])('does not write with unverified or insufficient flash size %s', async (size) => {
    const h = harness('ESP32-S3', size)
    // An explicit undefined value must not use the fixture's default.
    h.session.loader.detectFlashSize.mockResolvedValue(size)
    await expect(installFirmware(h.bundle, h.dependencies, h.events)).rejects.toThrow(/at least 8 MB/)
    expect(h.events.writing).not.toHaveBeenCalled()
    expect(h.session.loader.writeFlash).not.toHaveBeenCalled()
    expect(h.session.disconnect).toHaveBeenCalledTimes(1)
  })

  it.each(['8MB', '16MB', '32MB'])('accepts sufficient physical flash capacity %s', async (size) => {
    const h = harness('ESP32-S3', size)
    await installFirmware(h.bundle, h.dependencies, h.events)
    expect(h.session.loader.writeFlash).toHaveBeenCalledTimes(1)
  })

  it('treats a cancelled picker as no selected port and opens no session', async () => {
    const h = harness()
    const failure = new DOMException('No port selected', 'NotFoundError')
    h.dependencies.requestPort.mockRejectedValue(failure)
    await expect(installFirmware(h.bundle, h.dependencies, h.events)).rejects.toBe(failure)
    expect(h.dependencies.disconnectControl).not.toHaveBeenCalled()
    expect(h.dependencies.createSession).not.toHaveBeenCalled()
    expect(h.portClose).not.toHaveBeenCalled()
    expect(h.session.loader.writeFlash).not.toHaveBeenCalled()
  })

  it.each(['control disconnect', 'session creation'])('closes the unowned selected port after %s failure', async (stage) => {
    const h = harness()
    const failure = new Error(stage)
    if (stage === 'control disconnect') h.dependencies.disconnectControl.mockRejectedValue(failure)
    else h.dependencies.createSession.mockRejectedValue(failure)
    await expect(installFirmware(h.bundle, h.dependencies, h.events)).rejects.toBe(failure)
    expect(h.portClose).toHaveBeenCalledTimes(1)
    expect(h.session.disconnect).not.toHaveBeenCalled()
    expect(h.session.loader.writeFlash).not.toHaveBeenCalled()
  })

  it.each(['main', 'detectFlashSize', 'writeFlash'])('resets and releases a created session after %s failure', async (stage) => {
    const h = harness()
    const failure = new Error(`${stage} failed`)
    h.session.loader[stage as 'main' | 'detectFlashSize' | 'writeFlash'].mockRejectedValue(failure)
    await expect(installFirmware(h.bundle, h.dependencies, h.events)).rejects.toBe(failure)
    expect(h.session.loader.after).toHaveBeenCalledExactlyOnceWith('hard_reset')
    expect(h.session.disconnect).toHaveBeenCalledTimes(1)
    expect(h.events.progress).not.toHaveBeenCalledWith(100)
  })

  it('preserves a flash verification failure even when reset and disconnect also fail', async () => {
    const h = harness()
    const failure = new Error('MD5 of file does not match data in flash!')
    h.session.loader.writeFlash.mockRejectedValue(failure)
    h.session.loader.after.mockRejectedValue(new Error('Reset unavailable'))
    h.session.disconnect.mockRejectedValue(new Error('Cable lost'))
    await expect(installFirmware(h.bundle, h.dependencies, h.events)).rejects.toBe(failure)
    expect(h.session.loader.after).toHaveBeenCalledWith('hard_reset')
    expect(h.session.disconnect).toHaveBeenCalledTimes(1)
    expect(h.events.log).toHaveBeenCalledWith(expect.stringContaining('port remains busy'))
    expect(h.events.progress).not.toHaveBeenCalledWith(100)
  })

  it('retries reset in cleanup and closes the transport when the final restart fails', async () => {
    const h = harness()
    const failure = new Error('Reset failed')
    h.session.loader.after.mockRejectedValue(failure)
    await expect(installFirmware(h.bundle, h.dependencies, h.events)).rejects.toBe(failure)
    expect(h.session.loader.after).toHaveBeenCalledTimes(2)
    expect(h.session.disconnect).toHaveBeenCalledTimes(1)
    expect(h.events.progress).not.toHaveBeenCalledWith(100)
  })

  it('weights compressed per-file progress by uncompressed image size and reserves 100% for reset', async () => {
    const h = harness()
    h.session.loader.writeFlash.mockImplementation(async (options) => {
      const progress = options.reportProgress!
      progress(-1, 1, 2)
      progress(99, 1, 2)
      progress(0, 1, 0)
      expect(h.events.progress).not.toHaveBeenCalled()
      progress(0, 50, 100)
      progress(0, 25, 100) // A retransmitted block must not move progress back.
      progress(0, 100, 100)
      progress(1, 40, 80)
      progress(2, 20, 80)
      progress(2, 160, 80) // Bound any overshooting transport report.
      progress(1, 80, 80)
      expect(h.events.progress.mock.calls.map(call => call[0])).toEqual([8, 8, 16, 33, 45, 83, 99])
      expect(h.session.loader.after).not.toHaveBeenCalled()
    })
    await installFirmware(h.bundle, h.dependencies, h.events)
    expect(h.events.progress).toHaveBeenLastCalledWith(100)
  })
})
