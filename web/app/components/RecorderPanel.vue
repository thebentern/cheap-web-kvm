<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Screen recorder — encodes the live capture to a file entirely in the browser.
 *
 * Full-frame mode records `video.captureStream()` directly. Region mode maps the
 * viewport-space selection onto source pixels, blits that sub-rectangle into an
 * off-screen canvas every animation frame and records `canvas.captureStream(30)`,
 * so the output file is exactly the size of the selected area.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useCapture } from '~/composables/useCapture'
import { usePanels } from '~/composables/usePanels'
import { useToasts } from '~/composables/useToasts'

const props = defineProps<{ video: HTMLVideoElement | null }>()

const panels = usePanels()
const toasts = useToasts()
const capture = useCapture()

/* Media element capture is not in the DOM lib typings. */
interface StreamSource {
  captureStream?: (frameRate?: number) => MediaStream
  mozCaptureStream?: (frameRate?: number) => MediaStream
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

type RecState = 'idle' | 'recording' | 'processing' | 'done'
type Mode = 'full' | 'region'

/* Smallest selection that still produces a usable recording, in viewport px. */
const MIN_W = 120
const MIN_H = 80

/* ------------------------------------------------------------------ state -- */
const state = ref<RecState>('idle')
const mode = ref<Mode>('full')
const activeMode = ref<Mode>('full')
const elapsed = ref(0)
const bytes = ref(0)
const blob = ref<Blob | null>(null)
const mimeType = ref('video/webm')

let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let timerId: ReturnType<typeof setInterval> | null = null
let startedAt = 0
let rafId = 0
let canvasStream: MediaStream | null = null
let resizeWatcher: (() => void) | null = null

const busy = computed(() => state.value === 'recording' || state.value === 'processing')
const container = computed(() => (mimeType.value.includes('mp4') ? 'MP4' : 'WebM'))
const fileExt = computed(() => (mimeType.value.includes('mp4') ? 'mp4' : 'webm'))

const modeLabel = computed(() => (activeMode.value === 'region' ? 'Region' : 'Full frame'))
const badgeText = computed(() => {
  if (state.value === 'recording') return `${modeLabel.value} recording`
  if (state.value === 'processing') return 'Finishing up'
  if (state.value === 'done') return `${modeLabel.value} — ready to save`
  return mode.value === 'region' ? 'Region — pick an area' : 'Full frame'
})

function pad(n: number) {
  return String(n).padStart(2, '0')
}

const timerText = computed(() => {
  const total = elapsed.value
  const mins = Math.floor(total / 60)
  const secs = total % 60
  if (mins < 60) return `${pad(mins)}:${pad(secs)}`
  return `${Math.floor(mins / 60)}:${pad(mins % 60)}:${pad(secs)}`
})

const sizeText = computed(() => `~${(bytes.value / (1024 * 1024)).toFixed(2)} MB`)

/* ------------------------------------------------------------- mime type -- */
/* Ordered best-first; VP9 is markedly smaller, VP8 is the safest fallback. */
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
]

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      mimeType.value = candidate
      return
    }
  }
}

/* -------------------------------------------------------------- panel drag -- */
const panelEl = ref<HTMLElement | null>(null)
const pos = reactive({ x: 0, y: 0 })
const placed = ref(false)
let dragOff = { x: 0, y: 0 }
let dragging = false

const panelStyle = computed(() =>
  placed.value
    ? { left: `${pos.x}px`, top: `${pos.y}px` }
    : { right: '1.25rem', top: '4.25rem' },
)

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(v, hi))
}

function onDragStart(e: PointerEvent) {
  if ((e.target as HTMLElement | null)?.closest('button')) return
  const el = panelEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  dragOff = { x: e.clientX - r.left, y: e.clientY - r.top }
  dragging = true
  placed.value = true
  pos.x = r.left
  pos.y = r.top
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
}

function onDragMove(e: PointerEvent) {
  const el = panelEl.value
  if (!dragging || !el) return
  pos.x = clamp(e.clientX - dragOff.x, 0, window.innerWidth - el.offsetWidth)
  pos.y = clamp(e.clientY - dragOff.y, 0, window.innerHeight - el.offsetHeight)
}

function onDragEnd(e: PointerEvent) {
  if (!dragging) return
  dragging = false
  const el = e.currentTarget as HTMLElement
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
}

/* ------------------------------------------------------------ video geometry */
/** The picture's rect in viewport px, discounting letter/pillarboxing. */
function videoRect(): Rect | null {
  const v = props.video
  if (!v) return null
  const r = v.getBoundingClientRect()
  if (!r.width || !r.height) return null
  const aspect = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9
  if (r.width / r.height > aspect) {
    const h = r.height
    const w = h * aspect
    return { x: r.left + (r.width - w) / 2, y: r.top, w, h }
  }
  const w = r.width
  const h = w / aspect
  return { x: r.left, y: r.top + (r.height - h) / 2, w, h }
}

function streamReady() {
  return capture.active.value && !!props.video?.srcObject
}

/* --------------------------------------------------------- region selector -- */
const overlayEl = ref<HTMLElement | null>(null)
const selecting = ref(false)
const sel = reactive<Rect>({ x: 0, y: 0, w: 0, h: 0 })
const viewport = reactive({ w: 0, h: 0 })

type SelDrag =
  | { type: 'move'; sx: number; sy: number; base: Rect }
  | { type: 'resize'; handle: string; sx: number; sy: number; base: Rect }
  | { type: 'draw'; ax: number; ay: number }

let selDrag: SelDrag | null = null

const HANDLES: { id: string; cls: string }[] = [
  { id: 'nw', cls: 'top-0 left-0 -translate-x-1/2 -translate-y-1/2 cursor-nw-resize' },
  { id: 'n', cls: 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-n-resize' },
  { id: 'ne', cls: 'top-0 right-0 translate-x-1/2 -translate-y-1/2 cursor-ne-resize' },
  { id: 'e', cls: 'top-1/2 right-0 translate-x-1/2 -translate-y-1/2 cursor-e-resize' },
  { id: 'se', cls: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-se-resize' },
  { id: 's', cls: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-s-resize' },
  { id: 'sw', cls: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-sw-resize' },
  { id: 'w', cls: 'top-1/2 left-0 -translate-x-1/2 -translate-y-1/2 cursor-w-resize' },
]

/** Selection size in *source* pixels — what the saved file will measure. */
const selSize = computed(() => {
  const v = props.video
  const vr = videoRect()
  if (!v || !vr || !v.videoWidth || !v.videoHeight) {
    return { w: Math.round(sel.w), h: Math.round(sel.h) }
  }
  return {
    w: Math.round((sel.w * v.videoWidth) / vr.w),
    h: Math.round((sel.h * v.videoHeight) / vr.h),
  }
})

/* Toolbar sits under the selection, or above it when there is no room. */
const TOOLBAR_H = 46
const TOOLBAR_HALF_W = 140

const toolbarStyle = computed(() => {
  let top = sel.y + sel.h + 12
  if (top + TOOLBAR_H > viewport.h - 8) top = sel.y - TOOLBAR_H - 12
  if (top < 4) top = sel.y + 8
  const left = clamp(sel.x + sel.w / 2, TOOLBAR_HALF_W + 4, viewport.w - TOOLBAR_HALF_W - 4)
  return { left: `${left}px`, top: `${top}px` }
})

function syncViewport() {
  viewport.w = window.innerWidth
  viewport.h = window.innerHeight
}

function openSelector() {
  const vr = videoRect()
  if (!vr) {
    toasts.warn('No picture to select from yet')
    return
  }
  syncViewport()
  /* Default to the middle 70% of the picture, as the reference client did. */
  const padFrac = 0.15
  sel.x = vr.x + vr.w * padFrac
  sel.y = vr.y + vr.h * padFrac
  sel.w = vr.w * (1 - padFrac * 2)
  sel.h = vr.h * (1 - padFrac * 2)
  selecting.value = true
  window.addEventListener('keydown', onSelectorKey, { capture: true })
}

function closeSelector() {
  selecting.value = false
  selDrag = null
  window.removeEventListener('keydown', onSelectorKey, { capture: true })
}

/* Swallow the key so the page-level handler does not forward it to the target. */
function onSelectorKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  closeSelector()
}

function capturePointer(e: PointerEvent) {
  overlayEl.value?.setPointerCapture(e.pointerId)
}

function startMove(e: PointerEvent) {
  selDrag = { type: 'move', sx: e.clientX, sy: e.clientY, base: { ...sel } }
  capturePointer(e)
  e.preventDefault()
}

function startResize(handle: string, e: PointerEvent) {
  selDrag = { type: 'resize', handle, sx: e.clientX, sy: e.clientY, base: { ...sel } }
  capturePointer(e)
  e.preventDefault()
}

/** Pointerdown on the dimmed backdrop draws a fresh rectangle. */
function startDraw(e: PointerEvent) {
  if (e.target !== overlayEl.value) return
  const vr = videoRect()
  if (!vr) return
  const ax = clamp(e.clientX, vr.x, vr.x + vr.w)
  const ay = clamp(e.clientY, vr.y, vr.y + vr.h)
  selDrag = { type: 'draw', ax, ay }
  sel.x = ax
  sel.y = ay
  sel.w = 0
  sel.h = 0
  capturePointer(e)
  e.preventDefault()
}

function onSelPointerMove(e: PointerEvent) {
  if (!selDrag) return
  const vr = videoRect() ?? { x: 0, y: 0, w: viewport.w, h: viewport.h }

  if (selDrag.type === 'draw') {
    const cx = clamp(e.clientX, vr.x, vr.x + vr.w)
    const cy = clamp(e.clientY, vr.y, vr.y + vr.h)
    sel.x = Math.min(selDrag.ax, cx)
    sel.y = Math.min(selDrag.ay, cy)
    sel.w = Math.abs(cx - selDrag.ax)
    sel.h = Math.abs(cy - selDrag.ay)
    return
  }

  const base = selDrag.base
  const dx = e.clientX - selDrag.sx
  const dy = e.clientY - selDrag.sy
  let { x, y, w, h } = base

  if (selDrag.type === 'move') {
    x = clamp(base.x + dx, vr.x, vr.x + vr.w - w)
    y = clamp(base.y + dy, vr.y, vr.y + vr.h - h)
  } else {
    const hnd = selDrag.handle
    if (hnd.includes('e')) w = Math.max(MIN_W, base.w + dx)
    if (hnd.includes('s')) h = Math.max(MIN_H, base.h + dy)
    if (hnd.includes('w')) {
      const nw = Math.max(MIN_W, base.w - dx)
      x = base.x + base.w - nw
      w = nw
    }
    if (hnd.includes('n')) {
      const nh = Math.max(MIN_H, base.h - dy)
      y = base.y + base.h - nh
      h = nh
    }
    /* Keep the box inside the picture, then re-apply the minimum. */
    if (x < vr.x) {
      w -= vr.x - x
      x = vr.x
    }
    if (y < vr.y) {
      h -= vr.y - y
      y = vr.y
    }
    if (x + w > vr.x + vr.w) w = vr.x + vr.w - x
    if (y + h > vr.y + vr.h) h = vr.y + vr.h - y
    w = Math.max(MIN_W, w)
    h = Math.max(MIN_H, h)
  }

  sel.x = x
  sel.y = y
  sel.w = w
  sel.h = h
}

function onSelPointerUp(e: PointerEvent) {
  if (!selDrag) return
  const wasDraw = selDrag.type === 'draw'
  selDrag = null
  if (overlayEl.value?.hasPointerCapture(e.pointerId)) {
    overlayEl.value.releasePointerCapture(e.pointerId)
  }
  if (!wasDraw) return

  /* A flick rather than a drag: grow the box to the usable minimum. */
  const vr = videoRect()
  if (!vr) return
  sel.w = Math.max(sel.w, MIN_W)
  sel.h = Math.max(sel.h, MIN_H)
  sel.x = clamp(sel.x, vr.x, Math.max(vr.x, vr.x + vr.w - sel.w))
  sel.y = clamp(sel.y, vr.y, Math.max(vr.y, vr.y + vr.h - sel.h))
  sel.w = Math.min(sel.w, vr.x + vr.w - sel.x)
  sel.h = Math.min(sel.h, vr.y + vr.h - sel.y)
}

/* ------------------------------------------------------------- recording --- */
function stopTimer() {
  if (timerId !== null) {
    clearInterval(timerId)
    timerId = null
  }
}

function stopResizeWatch() {
  if (resizeWatcher) {
    window.removeEventListener('resize', resizeWatcher)
    resizeWatcher = null
  }
}

function stopDrawLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  canvasStream?.getTracks().forEach((t) => t.stop())
  canvasStream = null
}

function begin(stream: MediaStream, m: Mode): boolean {
  chunks = []
  blob.value = null
  bytes.value = 0
  elapsed.value = 0

  let rec: MediaRecorder
  try {
    rec = new MediaRecorder(stream, { mimeType: mimeType.value })
  } catch {
    /* Some builds reject the codec string but accept the default. */
    try {
      rec = new MediaRecorder(stream)
    } catch (err) {
      toasts.error(`Cannot start recorder: ${(err as Error).message}`)
      return false
    }
  }

  recorder = rec
  rec.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data)
      bytes.value += e.data.size
    }
  }
  rec.onstop = () => {
    stopTimer()
    stopResizeWatch()
    stopDrawLoop()
    recorder = null
    state.value = 'processing'
    /* Let the panel repaint before assembling what may be a large blob. */
    setTimeout(() => {
      const type = mimeType.value.split(';')[0] || 'video/webm'
      const out = new Blob(chunks, { type })
      chunks = []
      if (out.size > 0) {
        blob.value = out
        state.value = 'done'
        toasts.success('Recording ready — click Save to download it')
      } else {
        blob.value = null
        state.value = 'idle'
        toasts.warn('Recording produced no data')
      }
    }, 50)
  }

  try {
    rec.start(200) /* one chunk every 200 ms, so the size readout moves */
  } catch (err) {
    recorder = null
    toasts.error(`Cannot start recorder: ${(err as Error).message}`)
    return false
  }

  activeMode.value = m
  state.value = 'recording'
  startedAt = Date.now()
  timerId = setInterval(() => {
    elapsed.value = Math.floor((Date.now() - startedAt) / 1000)
  }, 500)

  /* A window resize re-lays out the picture, which would desync a region
   * recording; the reference client stops rather than produce a broken file. */
  const iw = window.innerWidth
  const ih = window.innerHeight
  resizeWatcher = () => {
    if (state.value === 'recording' && (window.innerWidth !== iw || window.innerHeight !== ih)) {
      toasts.warn('Window resized — recording stopped automatically', 5000)
      stop()
    }
  }
  window.addEventListener('resize', resizeWatcher)

  toasts.info('Recording started', 2000)
  return true
}

function startFull() {
  const v = props.video
  if (!v) return
  const src = v as unknown as StreamSource
  const grab = src.captureStream ?? src.mozCaptureStream
  if (!grab) {
    toasts.error('This browser cannot capture a stream from the video element')
    return
  }
  let stream: MediaStream
  try {
    stream = grab.call(src)
  } catch (err) {
    toasts.error(`Cannot capture stream: ${(err as Error).message}`)
    return
  }
  begin(stream, 'full')
}

function startRegion() {
  const v = props.video
  const vr = videoRect()
  if (!v || !vr) return

  /* Viewport px -> source px. */
  const frameW = v.videoWidth || Math.round(vr.w)
  const frameH = v.videoHeight || Math.round(vr.h)
  const scaleX = frameW / vr.w
  const scaleY = frameH / vr.h
  const srcX = clamp(Math.round((sel.x - vr.x) * scaleX), 0, Math.max(0, frameW - 2))
  const srcY = clamp(Math.round((sel.y - vr.y) * scaleY), 0, Math.max(0, frameH - 2))
  /* Even dimensions keep every encoder happy, and the rect has to stay inside
   * the frame or drawImage would rescale what it does find. */
  const srcW = clamp(Math.round((sel.w * scaleX) / 2) * 2, 2, Math.floor((frameW - srcX) / 2) * 2)
  const srcH = clamp(Math.round((sel.h * scaleY) / 2) * 2, 2, Math.floor((frameH - srcY) / 2) * 2)

  const canvas = document.createElement('canvas')
  canvas.width = srcW
  canvas.height = srcH
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    toasts.error('Cannot create the region canvas')
    return
  }

  let stream: MediaStream
  try {
    stream = canvas.captureStream(30)
  } catch (err) {
    toasts.error(`Cannot capture canvas: ${(err as Error).message}`)
    return
  }
  canvasStream = stream

  if (!begin(stream, 'region')) {
    stopDrawLoop()
    return
  }

  const draw = () => {
    if (state.value !== 'recording') return
    try {
      ctx.drawImage(v, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH)
    } catch {
      /* A frame can be unavailable mid-teardown; skip it rather than die. */
    }
    rafId = requestAnimationFrame(draw)
  }
  rafId = requestAnimationFrame(draw)
}

function confirmRegion() {
  closeSelector()
  if (!streamReady()) {
    toasts.warn('Capture is not running — start the capture stick first')
    return
  }
  startRegion()
}

function record() {
  if (busy.value) return
  if (!streamReady()) {
    toasts.warn('Capture is not running — start the capture stick first')
    return
  }
  if (mode.value === 'region') openSelector()
  else startFull()
}

function stop() {
  if (state.value !== 'recording' || !recorder) return
  try {
    recorder.stop() /* onstop assembles the blob */
  } catch {
    /* Already inactive; fall through to the same teardown. */
    stopTimer()
    stopResizeWatch()
    stopDrawLoop()
    recorder = null
    state.value = 'idle'
  }
}

function toggleRecord() {
  if (state.value === 'recording') stop()
  else record()
}

function save() {
  const data = blob.value
  if (!data) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
  const url = URL.createObjectURL(data)
  const a = document.createElement('a')
  a.href = url
  a.download = `kvm-recording-${stamp}.${fileExt.value}`
  document.body.appendChild(a)
  a.click()
  /* Give the download a moment to latch on before the URL goes away. */
  setTimeout(() => {
    URL.revokeObjectURL(url)
    a.remove()
  }, 1000)
  toasts.success('Recording download started')
}

function discard() {
  blob.value = null
  bytes.value = 0
  elapsed.value = 0
  state.value = 'idle'
}

function close() {
  panels.hide('recorder')
}

/* ------------------------------------------------------------- lifecycle --- */
onMounted(() => {
  pickMimeType()
  syncViewport()
  window.addEventListener('resize', syncViewport)
  const el = panelEl.value
  if (el) {
    const r = el.getBoundingClientRect()
    pos.x = r.left
    pos.y = r.top
    placed.value = true
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncViewport)
  closeSelector()
  if (state.value === 'recording' && recorder) {
    recorder.onstop = null
    try {
      recorder.stop()
    } catch {
      /* Nothing to do; the panel is going away either way. */
    }
    toasts.warn('Recorder closed while recording — the take was discarded')
  }
  recorder = null
  chunks = []
  stopTimer()
  stopResizeWatch()
  stopDrawLoop()
})
</script>

<template>
  <div>
    <!-- ------------------------------------------------------------ panel -->
    <div
      ref="panelEl"
      class="kvm-panel fixed z-[1500] flex w-[17.5rem] flex-col select-none"
      :style="panelStyle"
    >
      <div
        class="kvm-drag flex items-center gap-2 rounded-t-[calc(var(--radius-panel)_-_1px)] border-b border-ink-700 bg-ink-800/55 px-3 py-2"
        @pointerdown="onDragStart"
        @pointermove="onDragMove"
        @pointerup="onDragEnd"
        @pointercancel="onDragEnd"
      >
        <AppIcon name="film" class="text-signal-400" />
        <span class="text-[11px] font-semibold tracking-[0.12em] text-mist-400 uppercase">
          Screen recorder
        </span>
        <span class="ml-auto grid grid-cols-2 gap-[3px] px-1 opacity-50" aria-hidden="true">
          <span v-for="d in 6" :key="d" class="h-[3px] w-[3px] rounded-full bg-mist-400" />
        </span>
        <button
          class="kvm-btn kvm-btn-icon h-6 w-6 flex-none p-0 text-[11px]"
          title="Close"
          @click="close"
        >
          <AppIcon name="x" />
        </button>
      </div>

      <div class="p-3">
        <!-- Mode picker -->
        <div class="mb-2 grid grid-cols-2 gap-1.5">
          <button
            class="kvm-btn kvm-tab px-2 text-[11.5px]"
            :class="{ 'is-active': mode === 'full', disabled: busy }"
            :disabled="busy"
            @click="mode = 'full'"
          >
            <AppIcon name="monitor" /> Full frame
          </button>
          <button
            class="kvm-btn kvm-tab px-2 text-[11.5px]"
            :class="{ 'is-active': mode === 'region', disabled: busy }"
            :disabled="busy"
            @click="mode = 'region'"
          >
            <AppIcon name="crop" /> Region
          </button>
        </div>

        <!-- Mode badge -->
        <div
          class="mb-2 flex items-center gap-1.5 text-[11px] tracking-[0.08em] uppercase"
          :class="state === 'recording' ? 'text-alert-400' : 'text-mist-400'"
        >
          <span
            class="h-1.5 w-1.5 rounded-full"
            :class="state === 'recording' ? 'animate-pulse bg-alert-400' : 'bg-ink-500'"
          />
          {{ badgeText }}
        </div>

        <!-- Elapsed time and accumulated size -->
        <div
          v-if="state === 'recording' || state === 'done'"
          class="mb-2 flex items-center justify-between gap-2 rounded-[0.55rem] border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono"
        >
          <span class="text-sm font-semibold tabular-nums text-alert-400">{{ timerText }}</span>
          <span class="text-[11px] text-mist-400">{{ sizeText }}</span>
        </div>

        <div class="grid grid-cols-2 gap-1.5">
          <button
            class="kvm-btn px-2 text-[11.5px]"
            :class="[
              state === 'recording' ? 'border-alert-500/70 bg-alert-500/15 text-alert-400' : 'green',
              { disabled: state === 'processing' },
            ]"
            :disabled="state === 'processing'"
            :title="state === 'recording' ? 'Stop recording' : 'Start recording'"
            @click="toggleRecord"
          >
            <AppIcon :name="state === 'recording' ? 'stop' : 'record'" />
            {{ state === 'recording' ? 'Stop' : 'Record' }}
          </button>
          <button
            class="kvm-btn kvm-btn-primary px-2 text-[11.5px]"
            :class="{ disabled: state !== 'done' }"
            :disabled="state !== 'done'"
            title="Download the recording"
            @click="save"
          >
            <AppIcon name="download" /> Save
          </button>
        </div>

        <p v-if="state === 'processing'" class="mt-2 text-center text-[11px] text-mist-400">
          Finishing the recording…
        </p>

        <button
          v-if="state === 'done'"
          class="kvm-btn mt-1.5 w-full px-2 text-[11.5px] text-mist-400"
          title="Throw the recording away"
          @click="discard"
        >
          <AppIcon name="trash" /> Discard
        </button>

        <p class="kvm-hint mt-2.5">
          Encoded to {{ container }} in the browser — nothing leaves this machine.
          Resizing the window ends the recording.
        </p>
      </div>
    </div>

    <!-- -------------------------------------------------------- selector -->
    <div
      v-if="selecting"
      ref="overlayEl"
      class="fixed inset-0 z-[2400] cursor-crosshair select-none"
      @pointerdown="startDraw"
      @pointermove="onSelPointerMove"
      @pointerup="onSelPointerUp"
      @pointercancel="onSelPointerUp"
    >
      <!-- Dim everything but the selection -->
      <svg class="pointer-events-none absolute inset-0 h-full w-full">
        <defs>
          <mask id="recorder-region-mask">
            <rect width="100%" height="100%" fill="white" />
            <rect :x="sel.x" :y="sel.y" :width="sel.w" :height="sel.h" fill="black" />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgb(0 0 0 / 0.58)"
          mask="url(#recorder-region-mask)"
        />
      </svg>

      <!-- The selection itself -->
      <div
        class="absolute cursor-move rounded-[3px] border-2 border-signal-400"
        :style="{ left: `${sel.x}px`, top: `${sel.y}px`, width: `${sel.w}px`, height: `${sel.h}px` }"
        @pointerdown.stop="startMove"
      >
        <div
          v-for="h in HANDLES"
          :key="h.id"
          class="absolute h-2.5 w-2.5 rounded-[2px] border-2 border-signal-400 bg-mist-100"
          :class="h.cls"
          @pointerdown.stop="startResize(h.id, $event)"
        />
      </div>

      <!-- Confirm / cancel, pinned to the selection -->
      <div
        class="kvm-panel absolute flex -translate-x-1/2 items-center gap-2 rounded-xl px-2 py-1.5 whitespace-nowrap"
        :style="toolbarStyle"
        @pointerdown.stop
      >
        <span class="pl-1 font-mono text-[11px] tabular-nums text-mist-400">
          {{ selSize.w }} × {{ selSize.h }} px
        </span>
        <button class="kvm-btn green px-2 text-[11.5px]" @click="confirmRegion">
          <AppIcon name="check" /> Record region
        </button>
        <button
          class="kvm-btn kvm-btn-icon h-7 w-7 p-0 text-[11px]"
          title="Cancel"
          @click="closeSelector"
        >
          <AppIcon name="x" />
        </button>
      </div>
    </div>
  </div>
</template>
