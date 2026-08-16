// SPDX-License-Identifier: GPL-3.0-or-later
import { ref, shallowRef } from 'vue'

/**
 * HDMI capture stick discovery and video/audio streaming.
 *
 * The capture device is an ordinary UVC device on a separate USB path — the
 * firmware has nothing to do with video.
 */

export interface CaptureCandidate {
  vid: string
  pid: string
  product: string
}

/** MS2130 first: 1080p60 and cleaner descriptors than the MS2109. */
export const SUPPORTED_CAPTURE: CaptureCandidate[] = [
  { vid: '534d', pid: '2130', product: 'MS2130' },
  { vid: '345f', pid: '2130', product: 'MS2130 (rebadged)' },
  { vid: '534d', pid: '2109', product: 'MS2109' },
  { vid: '345f', pid: '2109', product: 'MS2109 (gen2)' },
]

export const MODE_LIST = [
  { width: 1920, height: 1080, frameRate: 60 },
  { width: 1920, height: 1080, frameRate: 30 },
  { width: 1920, height: 1080, frameRate: 25 },
]

/**
 * These capture cards emit a seven-stripe colour-bar pattern when no HDMI
 * source is attached. The stream stays "active", so the only way to tell that
 * the target is dark is to look at the pixels.
 */
const TEST_PATTERN_COLORS = [
  { r: 255, g: 255, b: 255 },
  { r: 255, g: 255, b: 0 },
  { r: 0, g: 234, b: 255 },
  { r: 0, g: 234, b: 0 },
  { r: 255, g: 32, b: 255 },
  { r: 255, g: 32, b: 0 },
  { r: 0, g: 24, b: 255 },
]
const COLOR_TOLERANCE = 45
const BLACK_THRESHOLD = 30
const CHECK_INTERVAL_MS = 1000

const stream = shallowRef<MediaStream | null>(null)
const active = ref(false)
const deviceName = ref<string | null>(null)
const fuzzyMatch = ref(false)
const lastError = ref<string | null>(null)
const resolution = ref<{ width: number; height: number; frameRate: number } | null>(null)
/** True when the card is streaming its "nothing plugged in" colour bars. */
const testPattern = ref(false)

export function useCapture() {
  function findDevice(devices: MediaDeviceInfo[], kind: MediaDeviceKind, vid: string, pid: string) {
    // Chrome appends "(vid:pid)" to the device label; there is no spec API for it.
    const exact = new RegExp(`\\(${vid}:${pid}\\)\\s*$`, 'i')
    const hit = devices.find((d) => d.kind === kind && exact.test(d.label))
    if (hit) return { device: hit, exact: true }

    // Some host drivers never surface the vid:pid, labelling the device as just
    // "2109 (V4L2)". Fall back to matching the product id alone.
    const loose = devices.find((d) => d.kind === kind && new RegExp(pid, 'i').test(d.label))
    return loose ? { device: loose, exact: false } : null
  }

  async function start(enableAudio = true) {
    lastError.value = null
    try {
      // Only getUserMedia prompts for permission; enumerateDevices does not, and
      // without permission the labels we match on are blank.
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      probe.getTracks().forEach((t) => t.stop())

      const devices = await navigator.mediaDevices.enumerateDevices()
      let video: MediaDeviceInfo | null = null
      let audio: MediaDeviceInfo | null = null
      fuzzyMatch.value = false

      for (const cand of SUPPORTED_CAPTURE) {
        const v = findDevice(devices, 'videoinput', cand.vid, cand.pid)
        const a = findDevice(devices, 'audioinput', cand.vid, cand.pid)
        if (v) {
          video = v.device
          audio = a?.device ?? null
          fuzzyMatch.value = !v.exact || (a ? !a.exact : false)
          deviceName.value = cand.product
          break
        }
      }

      if (!video) {
        lastError.value = 'No HDMI capture device found (MS2130 / MS2109)'
        return false
      }

      for (const mode of MODE_LIST) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: { exact: video.deviceId },
              width: { exact: mode.width },
              height: { exact: mode.height },
              frameRate: { exact: mode.frameRate },
            },
            audio:
              enableAudio && audio ? { deviceId: { exact: audio.deviceId } } : false,
          })
          stream.value = s
          active.value = true
          resolution.value = mode
          return true
        } catch {
          // Try the next mode; MS2109 behind a hub often only manages 25 fps.
        }
      }

      lastError.value = 'Capture device found but no supported video mode worked'
      return false
    } catch (err) {
      lastError.value = (err as Error).message
      return false
    }
  }

  function stop() {
    stream.value?.getTracks().forEach((t) => t.stop())
    stream.value = null
    active.value = false
    resolution.value = null
    testPattern.value = false
  }

  /* --------------------------------------------------- test-pattern detection */

  function colorMatch(r: number, g: number, b: number, want: { r: number; g: number; b: number }) {
    return (
      Math.abs(r - want.r) <= COLOR_TOLERANCE &&
      Math.abs(g - want.g) <= COLOR_TOLERANCE &&
      Math.abs(b - want.b) <= COLOR_TOLERANCE
    )
  }

  /** Scan inward from both edges to skip pillarboxing before sampling stripes. */
  function contentBounds(row: Uint8ClampedArray, width: number) {
    let left = 0
    let right = width - 1
    for (let x = 0; x < width; x++) {
      const i = x * 4
      if (row[i]! > BLACK_THRESHOLD || row[i + 1]! > BLACK_THRESHOLD || row[i + 2]! > BLACK_THRESHOLD) {
        left = x
        break
      }
    }
    for (let x = width - 1; x >= left; x--) {
      const i = x * 4
      if (row[i]! > BLACK_THRESHOLD || row[i + 1]! > BLACK_THRESHOLD || row[i + 2]! > BLACK_THRESHOLD) {
        right = x
        break
      }
    }
    return { left, right }
  }

  function isTestPattern(video: HTMLVideoElement, ctx: CanvasRenderingContext2D): boolean {
    if (!video.srcObject || !video.videoWidth || !video.videoHeight) return false

    const canvas = ctx.canvas
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    const rows = [canvas.height * 0.25, canvas.height * 0.5, canvas.height * 0.75].map(Math.floor)

    for (const y of rows) {
      const row = ctx.getImageData(0, y, canvas.width, 1).data
      const { left, right } = contentBounds(row, canvas.width)
      const width = right - left + 1
      // Too little content to judge; treat as a real picture rather than bars.
      if (width < canvas.width * 0.25) return false

      const stripe = width / TEST_PATTERN_COLORS.length
      for (let i = 0; i < TEST_PATTERN_COLORS.length; i++) {
        const x = Math.floor(left + stripe * i + stripe / 2)
        const p = x * 4
        if (!colorMatch(row[p]!, row[p + 1]!, row[p + 2]!, TEST_PATTERN_COLORS[i]!)) return false
      }
    }
    return true
  }

  /** Poll the picture for the colour-bar pattern. Returns a stop function. */
  function watchSignal(getVideo: () => HTMLVideoElement | null) {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return () => {}

    const timer = setInterval(() => {
      const video = getVideo()
      if (!video || !active.value) {
        testPattern.value = false
        return
      }
      try {
        testPattern.value = isTestPattern(video, ctx)
      } catch {
        // A tainted or not-yet-ready frame; leave the last verdict alone.
      }
    }, CHECK_INTERVAL_MS)

    return () => clearInterval(timer)
  }

  /** Re-run discovery when the capture stick is plugged or unplugged. */
  function watchDevices(enableAudio: () => boolean) {
    const onChange = () => {
      if (!active.value) void start(enableAudio())
    }
    navigator.mediaDevices.addEventListener('devicechange', onChange)
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange)
  }

  return {
    stream,
    active,
    deviceName,
    fuzzyMatch,
    lastError,
    resolution,
    testPattern,
    start,
    stop,
    watchSignal,
    watchDevices,
  }
}
