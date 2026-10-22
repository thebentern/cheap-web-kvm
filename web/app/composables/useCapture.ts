// SPDX-License-Identifier: GPL-3.0-or-later
import { ref, shallowRef } from 'vue'

/**
 * HDMI capture stick discovery and video/audio streaming.
 *
 * The capture device is an ordinary UVC device on a separate USB path — the
 * firmware has nothing to do with video.
 *
 * Once started, capture is supervised: a stream that ends, stays muted or stops
 * delivering frames is reopened with backoff, and every such event is logged so
 * a dropout can be diagnosed on a device with no console (an iPad).
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

/**
 * Cameras that ship inside the host. Safari labels devices by product name
 * alone, so when nothing carries a USB id these are what to rule out.
 */
const BUILT_IN_CAMERA = /^(front|back) |facetime|macbook|built-?in|integrated|desk view|iphone|ipad|virtual/i

/** How Chrome suffixes a USB device's label. Safari never does. */
const LABEL_USB_ID = /\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i

/** Microphone labels worth trusting as the stick's own audio. */
const CAPTURE_AUDIO = /usb|hdmi|capture|ms21/i

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

const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 10_000
/** A track muted this long while the page is in front is treated as lost. */
const MUTE_GRACE_MS = 5000
/** No new frame for this long, with the page in front, counts as a stall. */
const STALL_MS = 6000
/** A stream that stays up, unmuted, this long is healthy: the backoff resets. */
const HEALTHY_MS = 20_000
/**
 * After this many streams in a row die before they are healthy, stop reopening
 * and ask for a tap. Repeated opens can wedge a USB camera on iPadOS, and
 * WebKit only re-prompts for the camera inside a gesture anyway.
 */
const MAX_SHORT_LIVED = 4
/** How long a visible page waits on getUserMedia before giving up on it. */
const OPEN_TIMEOUT_MS = 15_000
/**
 * The colour-bar check samples a small fixed-size copy of the picture. Resizing
 * a full-resolution canvas every second has leaked GPU memory on iPadOS.
 */
const ANALYSIS_W = 320
const ANALYSIS_H = 180
const EVENT_LOG_SIZE = 40

const stream = shallowRef<MediaStream | null>(null)
const active = ref(false)
const deviceName = ref<string | null>(null)
const fuzzyMatch = ref(false)
const lastError = ref<string | null>(null)
const resolution = ref<{ width: number; height: number; frameRate: number } | null>(null)
/** True when the card is streaming its "nothing plugged in" colour bars. */
const testPattern = ref(false)

/**
 * idle: not started. live: streaming. paused: the system muted the track, as
 * iPadOS does for interruptions. reconnecting: lost and being reopened.
 * failed: could not start, or gave up reopening; it needs a tap.
 */
export type CaptureStatus = 'idle' | 'live' | 'paused' | 'reconnecting' | 'failed'
export interface CaptureEvent {
  at: string
  what: string
}
const status = ref<CaptureStatus>('idle')
/** Recent capture events, oldest first. */
const events = ref<CaptureEvent[]>([])

type Resolution = { width: number; height: number; frameRate: number }

/** Capture was asked for and not stopped or refused, so a lost stream is retried. */
let wanted = false
/** Camera access was refused; only an explicit Start or Restart asks again. */
let refused = false
/** The live audio setting, from watchDevices(); read again on every (re)open. */
let audioSetting: (() => boolean) | null = null
/** What start() was last told, for callers that never set up the watcher. */
let startAudio = true
const wantAudio = () => (audioSetting ? audioSetting() : startAudio)
/** One open at a time: on iOS a second capture mutes or ends the first. */
let opening: Promise<boolean> | null = null
/** Bumped by every open and by stop(); work from an older generation is dropped. */
let generation = 0
/** The video track being supervised; events from older tracks are ignored. */
let liveTrack: MediaStreamTrack | null = null
/** The stick's audio, held apart from the video so it can fail on its own. */
let audioTrack: MediaStreamTrack | null = null
/** What last produced a picture, tried first on every reopen. */
let lastGood: { video: MediaTrackConstraints; audioId: string | null; res: Resolution } | null =
  null
/** A getUserMedia call that timed out but may still answer, e.g. a prompt still up. */
let stuck: Promise<MediaStream> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let muteTimer: ReturnType<typeof setTimeout> | null = null
let healthyTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = RETRY_MIN_MS
let adoptedAt = 0
/** Streams in a row that died before HEALTHY_MS. */
let shortLived = 0

/**
 * Errors that end an open outright rather than moving on to the next mode: a
 * request that never answers or one still waiting will not answer for another
 * mode either, and a refusal applies to every mode (each further try could
 * prompt again).
 */
const FINAL_ERRORS = new Set(['TimeoutError', 'BusyError', 'NotAllowedError', 'SecurityError'])

function named(name: string, message: string) {
  const err = new Error(message)
  err.name = name
  return err
}

function errText(err: unknown) {
  const e = err as Error
  return e?.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : String(e?.message ?? err)
}

function logEvent(what: string) {
  const at = new Date().toLocaleTimeString()
  events.value = [...events.value.slice(-(EVENT_LOG_SIZE - 1)), { at, what }]
  console.info(`[capture] ${what}`)
}

function stopTracks(s: MediaStream) {
  s.getTracks().forEach((t) => t.stop())
}

/**
 * getUserMedia with a timeout, so one stuck call cannot block every retry. The
 * clock only runs while the page is visible, because WebKit holds requests from
 * a hidden page until it is shown again. A call that times out is remembered:
 * WebKit queues later requests behind it, so new ones are refused until it
 * settles, and if it answers late (a slow tap on Allow) `onLate` gets the stream.
 */
function gum(constraints: MediaStreamConstraints, onLate?: (s: MediaStream) => void) {
  if (stuck) {
    return Promise.reject(named('BusyError', 'an earlier camera request is still waiting'))
  }
  return new Promise<MediaStream>((resolve, reject) => {
    const native = navigator.mediaDevices.getUserMedia(constraints)
    let late = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const arm = () => {
      timer = setTimeout(() => {
        if (document.hidden) return arm()
        late = true
        stuck = native
        reject(named('TimeoutError', `getUserMedia gave no answer in ${OPEN_TIMEOUT_MS / 1000} s`))
      }, OPEN_TIMEOUT_MS)
    }
    arm()
    native.then(
      (s) => {
        if (timer) clearTimeout(timer)
        if (!late) return resolve(s)
        stuck = null
        if (onLate) onLate(s)
        else stopTracks(s)
      },
      (err) => {
        if (timer) clearTimeout(timer)
        if (!late) return reject(err)
        stuck = null
        logEvent(`late camera request failed: ${errText(err)}`)
      },
    )
  })
}

function clearTimer(t: ReturnType<typeof setTimeout> | null) {
  if (t) clearTimeout(t)
  return null
}

/** Let go of the current stream without giving up on capture. */
function release() {
  muteTimer = clearTimer(muteTimer)
  healthyTimer = clearTimer(healthyTimer)
  liveTrack = null
  audioTrack = null
  if (stream.value) stopTracks(stream.value)
  stream.value = null
  active.value = false
  testPattern.value = false
}

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

  /* --------------------------------------------------------- supervision */

  function adopt(s: MediaStream, res: Resolution) {
    const track = s.getVideoTracks()[0] ?? null
    stream.value = s
    active.value = true
    resolution.value = res
    liveTrack = track
    status.value = 'live'
    adoptedAt = Date.now()
    const withAudio = s.getAudioTracks().length ? ', with audio' : ''
    logEvent(`live: ${res.width}x${res.height} at ${res.frameRate} fps${withAudio}`)
    if (!track) return

    // The backoff only resets once a stream proves itself; one that opens and
    // dies again straight away must not reopen at the fastest rate forever.
    healthyTimer = setTimeout(() => {
      healthyTimer = null
      if (track === liveTrack && track.readyState === 'live' && !track.muted) {
        retryDelay = RETRY_MIN_MS
        shortLived = 0
      }
    }, HEALTHY_MS)

    track.addEventListener('ended', () => lost(track, 'track ended'))
    track.addEventListener('mute', () => {
      if (track !== liveTrack) return
      status.value = 'paused'
      logEvent(document.hidden ? 'paused: page hidden' : 'paused by the system (track muted)')
      armMuteTimer(track)
    })
    track.addEventListener('unmute', () => {
      if (track !== liveTrack) return
      muteTimer = clearTimer(muteTimer)
      status.value = 'live'
      logEvent('resumed (track unmuted)')
    })
  }

  /** Give a muted track a few seconds to come back before reopening it. */
  function armMuteTimer(track: MediaStreamTrack) {
    muteTimer = clearTimer(muteTimer)
    muteTimer = setTimeout(() => {
      muteTimer = null
      if (track !== liveTrack || !track.muted || document.hidden) return
      // On iOS an audio interruption (a call, Siri, an alarm) mutes the camera
      // as well, and reopening during one only comes back muted. Wait it out;
      // the overlay offers a restart.
      if (audioTrack?.muted) {
        logEvent('camera and microphone both muted: an audio interruption, waiting for it to end')
        return
      }
      lost(track, 'stayed muted')
    }, MUTE_GRACE_MS)
  }

  function lost(track: MediaStreamTrack | null, why: string) {
    if (!track || track !== liveTrack) return
    shortLived = Date.now() - adoptedAt < HEALTHY_MS ? shortLived + 1 : 0
    logEvent(`lost: ${why}`)
    release()
    status.value = wanted ? 'reconnecting' : 'idle'
    scheduleRetry()
  }

  function giveUp(why: string) {
    retryTimer = clearTimer(retryTimer)
    status.value = 'failed'
    logEvent(`stopped reopening: ${why}; tap Restart video`)
  }

  function scheduleRetry() {
    if (!wanted || retryTimer || active.value) return
    if (shortLived >= MAX_SHORT_LIVED) {
      giveUp(`${shortLived} streams in a row died within ${HEALTHY_MS / 1000} s`)
      return
    }
    // iPadOS refuses capture in the background; the visibility watcher picks
    // the chain up again when the page is back in front.
    if (document.hidden) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!wanted || active.value || opening || document.hidden) return
      kick('reconnecting')
    }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
  }

  function launch() {
    const p = open(wantAudio())
    opening = p
    void p.finally(() => {
      if (opening === p) opening = null
    })
    return p
  }

  /** An automatic (re)open that keeps the backoff chain going if it fails. */
  function kick(why: string) {
    if (active.value || opening) return
    logEvent(why)
    void launch().then((ok) => {
      if (!ok) scheduleRetry()
    })
  }

  /** Start capture, or join a start already under way. */
  function start(enableAudio = true): Promise<boolean> {
    wanted = true
    refused = false
    startAudio = enableAudio
    return (opening ?? launch()).then((ok) => {
      if (!ok && !active.value && status.value === 'idle') status.value = 'failed'
      return ok
    })
  }

  /**
   * Reopen from a tap. WebKit only re-prompts for the camera inside a user
   * gesture, so this is the way out when automatic retries cannot get through.
   * It supersedes any open still waiting.
   */
  function restart(): Promise<boolean> {
    logEvent('restart requested')
    retryTimer = clearTimer(retryTimer)
    retryDelay = RETRY_MIN_MS
    shortLived = 0
    wanted = true
    refused = false
    release()
    status.value = 'reconnecting'
    return launch().then((ok) => {
      if (!ok) scheduleRetry()
      return ok
    })
  }

  function stop() {
    // Anything still opening belongs to a page that no longer wants it.
    generation++
    opening = null
    wanted = false
    retryTimer = clearTimer(retryTimer)
    release()
    resolution.value = null
    status.value = 'idle'
  }

  /* ---------------------------------------------------------------- open */

  /** Record what worked and start streaming it, unless a newer open has begun. */
  function take(
    gen: number,
    s: MediaStream,
    video: MediaTrackConstraints,
    res: Resolution,
    audioId: string | null,
    enableAudio: boolean,
  ) {
    if (gen !== generation) {
      stopTracks(s)
      return false
    }
    lastGood = { video, audioId, res }
    adopt(s, res)
    if (enableAudio && audioId) void attachAudio(s, audioId)
    return true
  }

  /** A video request that timed out answered after all: use it if still wanted. */
  function lateVideo(
    video: MediaTrackConstraints,
    res: Resolution,
    audioId: string | null,
    enableAudio: boolean,
  ) {
    return (s: MediaStream) => {
      if (!wanted || active.value) {
        stopTracks(s)
        return
      }
      logEvent('the camera answered late; using it')
      retryTimer = clearTimer(retryTimer)
      take(++generation, s, video, res, audioId, enableAudio)
    }
  }

  async function open(enableAudio: boolean): Promise<boolean> {
    // Already streaming: opening again would only fight ourselves for the camera.
    if (active.value && liveTrack?.readyState === 'live' && !liveTrack.muted) return true
    release()
    lastError.value = null
    const gen = ++generation
    const stale = () => gen !== generation
    try {
      // Reopen with what worked last time before anything else. That is one
      // camera open instead of a probe and a run of failing modes (repeated
      // opens can wedge a USB camera on iPadOS), and from a tap it keeps
      // getUserMedia inside the gesture. The stick may have a new id after a
      // replug, so fall through to discovery if it fails.
      if (lastGood) {
        const { video, audioId, res } = lastGood
        try {
          const s = await gum({ video, audio: false }, lateVideo(video, res, audioId, enableAudio))
          return take(gen, s, video, res, audioId, enableAudio)
        } catch (err) {
          if (FINAL_ERRORS.has((err as Error).name)) throw err
          logEvent(`reopen with the last settings failed: ${errText(err)}`)
        }
        if (stale()) return false
      }

      // Labels, which the matching below needs, only appear once camera access
      // is granted, and only getUserMedia asks for it. Probe only when they are
      // missing: on iPadOS the probe opens the iPad's own camera, and a second
      // camera ends the first. No timeout here: it waits on the user's answer.
      let devices = await navigator.mediaDevices.enumerateDevices()
      if (stale()) return false
      if (!devices.some((d) => d.kind === 'videoinput' && d.label)) {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        stopTracks(probe)
        if (stale()) return false
        devices = await navigator.mediaDevices.enumerateDevices()
        if (stale()) return false
      }
      let video: MediaDeviceInfo | null = null
      let audio: MediaDeviceInfo | null = null
      let fuzzy = false
      let name: string | null = null

      for (const cand of SUPPORTED_CAPTURE) {
        const v = findDevice(devices, 'videoinput', cand.vid, cand.pid)
        const a = findDevice(devices, 'audioinput', cand.vid, cand.pid)
        if (v) {
          video = v.device
          audio = a?.device ?? null
          fuzzy = !v.exact || (a ? !a.exact : false)
          name = cand.product
          break
        }
      }

      // Safari: no vid:pid anywhere, and the sticks name themselves things like
      // "USB3 Video". Take the first camera that is not built in. Its
      // microphone must be grouped with it or look like capture audio — a
      // guess could open the host's own microphone instead.
      if (!video && !devices.some((d) => LABEL_USB_ID.test(d.label))) {
        video =
          devices.find((d) => d.kind === 'videoinput' && !BUILT_IN_CAMERA.test(d.label)) ?? null
        if (video) {
          const groupId = video.groupId
          audio =
            devices.find((d) => d.kind === 'audioinput' && !!groupId && d.groupId === groupId) ??
            devices.find((d) => d.kind === 'audioinput' && CAPTURE_AUDIO.test(d.label)) ??
            null
          fuzzy = true
          name = video.label || 'USB capture device'
        }
      }

      if (!video) {
        lastError.value = 'No HDMI capture device found (MS2130 / MS2109)'
        logEvent(`open failed: ${lastError.value}`)
        return false
      }
      fuzzyMatch.value = fuzzy
      deviceName.value = name
      const audioId = audio?.deviceId ?? null

      // Video first and on its own; the audio follows in a separate stream.
      for (const mode of MODE_LIST) {
        const constraints: MediaTrackConstraints = {
          deviceId: { exact: video.deviceId },
          width: { exact: mode.width },
          height: { exact: mode.height },
          frameRate: { exact: mode.frameRate },
        }
        try {
          const s = await gum(
            { video: constraints, audio: false },
            lateVideo(constraints, mode, audioId, enableAudio),
          )
          return take(gen, s, constraints, mode, audioId, enableAudio)
        } catch (err) {
          if (FINAL_ERRORS.has((err as Error).name)) throw err
          // Try the next mode; MS2109 behind a hub often only manages 25 fps.
        }
        if (stale()) return false
      }

      // Safari can refuse every exact mode, so let it choose the nearest and
      // report what it chose.
      const constraints: MediaTrackConstraints = {
        deviceId: { exact: video.deviceId },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
      }
      const s = await gum({ video: constraints, audio: false })
      const got = s.getVideoTracks()[0]?.getSettings() ?? {}
      const res = {
        width: got.width ?? 1920,
        height: got.height ?? 1080,
        frameRate: Math.round(got.frameRate ?? 30),
      }
      return take(gen, s, constraints, res, audioId, enableAudio)
    } catch (err) {
      if (stale()) return false
      lastError.value = errText(err)
      logEvent(`open failed: ${lastError.value}`)
      // A refusal is the user's answer: stop asking without a tap.
      const name = (err as Error).name
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        wanted = false
        refused = true
        retryTimer = clearTimer(retryTimer)
        status.value = 'failed'
      }
      return false
    }
  }

  /**
   * The stick's audio, opened as its own stream once the picture is up, so an
   * audio failure never takes the video with it. HDMI audio wants none of the
   * voice processing a browser applies to microphones.
   */
  async function attachAudio(s: MediaStream, audioId: string) {
    try {
      const a = await gum({
        audio: {
          deviceId: { exact: audioId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      const track = a.getAudioTracks()[0]
      if (!track || s !== stream.value) {
        stopTracks(a)
        return
      }
      s.addTrack(track)
      audioTrack = track
      logEvent('audio attached')
      track.addEventListener('mute', () => {
        if (track === audioTrack) logEvent('audio muted by the system')
      })
      track.addEventListener('unmute', () => {
        if (track === audioTrack) logEvent('audio resumed')
      })
      track.addEventListener('ended', () => {
        if (track !== audioTrack) return
        audioTrack = null
        logEvent('audio ended; video carries on')
      })
    } catch (err) {
      logEvent(`audio unavailable, video only: ${errText(err)}`)
    }
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

  /**
   * Poll the picture for the colour-bar pattern, and watch for a stream that
   * stops delivering frames without ending. Returns a stop function.
   */
  function watchSignal(getVideo: () => HTMLVideoElement | null) {
    const canvas = document.createElement('canvas')
    canvas.width = ANALYSIS_W
    canvas.height = ANALYSIS_H
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return () => {}

    // Frames are counted with requestVideoFrameCallback where it exists. The
    // stall check only arms once the count has been seen to move, so a browser
    // that never reports frames can never trigger a reconnect loop.
    let frames = 0
    let counting: HTMLVideoElement | null = null
    let lastFrames = 0
    let lastProgress = Date.now()
    let armed = false
    let resuming = false
    let watched: MediaStreamTrack | null = null
    const onFrame = () => {
      frames++
      counting?.requestVideoFrameCallback(onFrame)
    }

    const timer = setInterval(() => {
      const video = getVideo()
      if (video && video !== counting && 'requestVideoFrameCallback' in video) {
        counting = video
        video.requestVideoFrameCallback(onFrame)
      }
      if (!video || !active.value) {
        testPattern.value = false
        return
      }

      const now = Date.now()
      // A new stream starts its own clock.
      if (liveTrack !== watched) {
        watched = liveTrack
        lastFrames = frames
        lastProgress = now
      }
      // WebKit pauses an autoplaying video it decides is not visible. That is
      // the element, not the stream: play it again rather than reopening.
      if (video.paused && !document.hidden) {
        if (!resuming) logEvent('video element was paused by the browser; resuming')
        resuming = true
        lastProgress = now
        void video.play().catch(() => {})
      } else {
        resuming = false
      }
      if (frames !== lastFrames) {
        armed = true
        lastFrames = frames
        lastProgress = now
      } else if (document.hidden || status.value !== 'live') {
        lastProgress = now
      } else if (armed && now - lastProgress > STALL_MS) {
        lastProgress = now
        lost(liveTrack, `no new frames for ${STALL_MS / 1000} s`)
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

  /**
   * Start capture when the stick is plugged in, notice a stream that died
   * without saying so, and pick capture back up when the page returns to the
   * front. `enableAudio` is read on every reopen, so the setting applies to the
   * next reconnect, not just the next Start.
   */
  function watchDevices(enableAudio: () => boolean) {
    audioSetting = enableAudio

    const onChange = async () => {
      logEvent('devices changed')
      if (liveTrack?.readyState === 'ended') {
        lost(liveTrack, 'device went away')
        return
      }
      if (active.value || opening) return
      if (wanted) {
        // A replug is the usual fix for a wedged stick, so try again even
        // after giving up.
        retryDelay = RETRY_MIN_MS
        shortLived = 0
        kick('reopening after a device change')
        return
      }
      // Not started yet. Start only if the browser already shows device names,
      // so plugging the stick in never raises a camera prompt nobody asked for.
      if (refused) return
      const devices = await navigator.mediaDevices.enumerateDevices()
      if (!wanted && !opening && !refused && devices.some((d) => d.kind === 'videoinput' && d.label)) {
        void start(enableAudio())
      }
    }

    const onVisibility = () => {
      if (document.hidden) {
        logEvent('page hidden')
        return
      }
      logEvent('page visible')
      if (liveTrack?.readyState === 'ended') lost(liveTrack, 'ended while hidden')
      else if (liveTrack?.muted) armMuteTimer(liveTrack)
      // Reopen only a capture that has worked before, and not one that gave up
      // or was refused: that would re-run the permission probe on every return.
      else if (wanted && lastGood && !active.value && !opening && status.value !== 'failed') {
        retryDelay = RETRY_MIN_MS
        kick('reopening on return')
      }
    }

    navigator.mediaDevices.addEventListener('devicechange', onChange)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', onChange)
      document.removeEventListener('visibilitychange', onVisibility)
      if (audioSetting === enableAudio) audioSetting = null
    }
  }

  return {
    stream,
    active,
    deviceName,
    fuzzyMatch,
    lastError,
    resolution,
    testPattern,
    status,
    events,
    note: logEvent,
    start,
    restart,
    stop,
    watchSignal,
    watchDevices,
  }
}
