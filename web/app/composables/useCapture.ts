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

const stream = shallowRef<MediaStream | null>(null)
const active = ref(false)
const deviceName = ref<string | null>(null)
const fuzzyMatch = ref(false)
const lastError = ref<string | null>(null)
const resolution = ref<{ width: number; height: number; frameRate: number } | null>(null)

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
  }

  return { stream, active, deviceName, fuzzyMatch, lastError, resolution, start, stop }
}
