// SPDX-License-Identifier: GPL-3.0-or-later
export interface FirmwarePart {
  path: string
  offset: number
  size: number
  sha256: string
}

export interface FirmwareManifest {
  schemaVersion: 1
  name: '$KVM'
  version: string
  board: 'ESP32-S3-DevKitC-1-N8R8'
  chipFamily: 'ESP32-S3'
  flashSize: '8MB'
  flashMode: 'dio'
  flashFreq: '80m'
  parts: FirmwarePart[]
}

export interface FirmwareBundle {
  manifest: FirmwareManifest
  files: { address: number; data: Uint8Array }[]
}

// The supported board's legacy and on-board UI layouts. Separate files leave NVS
// at 0x9000 and PHY data at 0xf000 untouched, including sector-rounded erases.
const REGIONS = [
  { path: 'bootloader.bin', offset: 0, limit: 0x8000 },
  { path: 'partition-table.bin', offset: 0x8000, limit: 0x9000 },
  { path: 'cheap-web-kvm.bin', offset: 0x10000, limit: 0x400000 },
]

export function validateFirmwareManifest(value: unknown): FirmwareManifest {
  const manifest = value as Partial<FirmwareManifest> | null
  if (!manifest || manifest.schemaVersion !== 1 || manifest.name !== '$KVM'
    || manifest.board !== 'ESP32-S3-DevKitC-1-N8R8' || manifest.chipFamily !== 'ESP32-S3'
    || manifest.flashSize !== '8MB' || manifest.flashMode !== 'dio' || manifest.flashFreq !== '80m'
    || typeof manifest.version !== 'string' || !manifest.version.trim() || manifest.version.length > 80
    || !Array.isArray(manifest.parts) || manifest.parts.length !== REGIONS.length) {
    throw new Error('This firmware bundle is not for the supported ESP32-S3 dev kit.')
  }
  for (const [index, region] of REGIONS.entries()) {
    const part = manifest.parts[index]
    if (!part || part.path !== region.path || part.offset !== region.offset
      || !Number.isSafeInteger(part.size) || part.size <= 0
      || region.offset + Math.ceil(part.size / 4096) * 4096 > region.limit
      || typeof part.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(part.sha256)) {
      throw new Error('The firmware bundle has an invalid image or flash layout.')
    }
  }
  return manifest as FirmwareManifest
}

export async function fetchFirmwareBundle(manifestUrl: URL, signal?: AbortSignal): Promise<FirmwareBundle> {
  const response = await fetch(manifestUrl, { cache: 'no-store', signal })
  if (!response.ok) throw new Error('Firmware is not available on this copy of the app. Try the hosted installer.')
  const manifest = validateFirmwareManifest(await response.json())
  const files = await Promise.all(manifest.parts.map(async (part) => {
    const image = await fetch(new URL(part.path, manifestUrl), { cache: 'no-store', signal })
    if (!image.ok) throw new Error(`Could not download ${part.path}. Reload and try again.`)
    const data = new Uint8Array(await image.arrayBuffer())
    if (data.length !== part.size) throw new Error(`Incomplete firmware download: ${part.path}.`)
    const digest = await crypto.subtle.digest('SHA-256', data)
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    if (hash !== part.sha256) throw new Error(`Firmware checksum failed: ${part.path}. Reload and try again.`)
    return { address: part.offset, data }
  }))
  return { manifest, files }
}
