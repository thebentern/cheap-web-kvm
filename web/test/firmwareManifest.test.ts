// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchFirmwareBundle, validateFirmwareManifest, type FirmwareManifest } from '../app/utils/firmwareManifest'

const manifestUrl = new URL('https://example.test/cheap-web-kvm/firmware/manifest.json')
const binaries = [Uint8Array.from([0xe9, 1, 2, 3]), Uint8Array.from([4, 5, 6, 7]), Uint8Array.from([0xe9, 8, 9, 10, 11, 12, 13, 14])]

function fixture(): FirmwareManifest {
  return {
    schemaVersion: 1, name: '$KVM', version: 'abc1234', board: 'ESP32-S3-DevKitC-1-N8R8',
    chipFamily: 'ESP32-S3', flashSize: '8MB', flashMode: 'dio', flashFreq: '80m',
    parts: ['bootloader.bin', 'partition-table.bin', 'cheap-web-kvm.bin'].map((path, index) => ({
      path, offset: [0, 0x8000, 0x10000][index]!, size: binaries[index]!.length,
      sha256: createHash('sha256').update(binaries[index]!).digest('hex'),
    })),
  }
}

function serve(manifest: unknown = fixture(), images: Uint8Array[] = binaries) {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
    const url = String(input)
    if (url === manifestUrl.href) return new Response(JSON.stringify(manifest))
    const index = fixture().parts.findIndex(part => new URL(part.path, manifestUrl).href === url)
    if (index === -1) return new Response('', { status: 404 })
    return new Response(Uint8Array.from(images[index]!).buffer)
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('crypto', webcrypto)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('the fixed ESP32-S3 firmware manifest', () => {
  it('accepts the supported board and three separate image regions', () => {
    const manifest = fixture()
    expect(validateFirmwareManifest(manifest)).toEqual(manifest)
  })

  it('accepts both legacy firmware and the larger app with the on-board UI', () => {
    for (const size of [0x100000, 0x180000, 0x3f0000]) {
      const manifest = fixture()
      manifest.parts[2]!.size = size
      expect(validateFirmwareManifest(manifest)).toEqual(manifest)
    }
  })

  it.each([
    ['schemaVersion', 2], ['name', 'another product'], ['board', 'ESP32-DevKitC'],
    ['chipFamily', 'ESP32'], ['flashSize', '4MB'], ['flashMode', 'qio'], ['flashFreq', '40m'],
    ['version', ' '], ['version', 'x'.repeat(81)], ['parts', []],
  ])('rejects incompatible %s metadata (%s)', (key, value) => {
    expect(() => validateFirmwareManifest({ ...fixture(), [key]: value })).toThrow()
  })

  it.each([null, undefined, {}, 'firmware', []])('rejects malformed manifest %j', (value) => {
    expect(() => validateFirmwareManifest(value)).toThrow()
  })

  it.each([
    ['path', '../other.bin'], ['path', 'https://other.test/bootloader.bin'],
    ['offset', 0x9000], ['size', 0], ['size', -1], ['size', 2.5], ['size', Number.MAX_SAFE_INTEGER + 1],
    ['sha256', 'not-a-hash'], ['sha256', 'A'.repeat(64)],
  ])('rejects an unsafe image %s (%s)', (key, value) => {
    const manifest = fixture()
    Object.assign(manifest.parts[0]!, { [key]: value })
    expect(() => validateFirmwareManifest(manifest)).toThrow(/layout/)
  })

  it.each([[0, 0x8000], [1, 0x1000], [2, 0x3f0000]])('keeps image %i erases within its reserved region', (index, maxSize) => {
    const manifest = fixture()
    manifest.parts[index]!.size = maxSize
    expect(() => validateFirmwareManifest(manifest)).not.toThrow()
    // One extra byte erases a further 4 KB sector, including NVS for the table.
    manifest.parts[index]!.size = maxSize + 1
    expect(() => validateFirmwareManifest(manifest)).toThrow(/layout/)
  })

  it('rejects missing, extra, duplicate, or reordered images', () => {
    const manifest = fixture()
    for (const parts of [manifest.parts.slice(1), [...manifest.parts, manifest.parts[0]],
      [manifest.parts[0], manifest.parts[0], manifest.parts[2]], [...manifest.parts].reverse()]) {
      expect(() => validateFirmwareManifest({ ...manifest, parts })).toThrow()
    }
  })
})

describe('firmware download integrity', () => {
  it('checks every SHA-256 and length before returning bytes, using the Pages base path', async () => {
    const fetchMock = serve()
    const controller = new AbortController()
    const bundle = await fetchFirmwareBundle(manifestUrl, controller.signal)
    expect(bundle.manifest).toEqual(fixture())
    expect(bundle.files).toEqual(binaries.map((data, index) => ({ address: [0, 0x8000, 0x10000][index], data })))
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      manifestUrl.href, ...fixture().parts.map(part => new URL(part.path, manifestUrl).href),
    ])
    for (const call of fetchMock.mock.calls) expect(call[1]).toEqual({ cache: 'no-store', signal: controller.signal })
  })

  it('does not fetch binaries from an invalid manifest', async () => {
    const fetchMock = serve({ ...fixture(), chipFamily: 'ESP8266' })
    await expect(fetchFirmwareBundle(manifestUrl)).rejects.toThrow(/supported/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports an unavailable bundle without parsing a 404 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchFirmwareBundle(manifestUrl)).rejects.toThrow(/not available/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a truncated image even if its response status is successful', async () => {
    serve(fixture(), [binaries[0]!.subarray(1), ...binaries.slice(1)])
    await expect(fetchFirmwareBundle(manifestUrl)).rejects.toThrow(/Incomplete.*bootloader/)
  })

  it('rejects a same-length corrupted image', async () => {
    const corrupted = Uint8Array.from(binaries[2]!)
    corrupted[3] = corrupted[3]! ^ 0xff
    serve(fixture(), [...binaries.slice(0, 2), corrupted])
    await expect(fetchFirmwareBundle(manifestUrl)).rejects.toThrow(/checksum failed.*cheap-web-kvm/)
  })

  it('reports a failed image request', async () => {
    const fetchMock = serve()
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(fixture())))
      .mockImplementationOnce(async () => new Response('', { status: 404 }))
    await expect(fetchFirmwareBundle(manifestUrl)).rejects.toThrow(/Could not download bootloader/)
  })

  it('passes cancellation through without returning a partial bundle', async () => {
    const controller = new AbortController()
    controller.abort()
    const failure = new DOMException('Download aborted', 'AbortError')
    const fetchMock = vi.fn().mockRejectedValue(failure)
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchFirmwareBundle(manifestUrl, controller.signal)).rejects.toBe(failure)
    expect(fetchMock).toHaveBeenCalledWith(manifestUrl, { cache: 'no-store', signal: controller.signal })
  })
})
