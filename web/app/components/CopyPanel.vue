<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Copy box: drag a rectangle over the live picture, crop that region out of the
// video frame and run OCR on it. Ported from copy-box.js.
//
// Tesseract is vendored under public/vendor/tesseract so English works with no
// network at all; workerPath/corePath/langPath are all pointed at that folder.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useCapture } from '~/composables/useCapture'
import { usePanels } from '~/composables/usePanels'
import { useSettings } from '~/composables/useSettings'
import { useToasts } from '~/composables/useToasts'

const props = defineProps<{ video: HTMLVideoElement | null }>()

const panels = usePanels()
const toasts = useToasts()
const capture = useCapture()
const { settings } = useSettings()

/* ------------------------------------------------------------------ tesseract */

interface OcrLog {
  status?: string
  progress?: number
}
interface OcrOptions {
  logger?: (m: OcrLog) => void
  errorHandler?: (e: unknown) => void
  workerPath?: string
  corePath?: string
  langPath?: string
  legacyCore?: boolean
}
interface OcrResult {
  data: { text: string }
}
interface TesseractNamespace {
  recognize(
    image: HTMLCanvasElement,
    langs: string,
    options?: OcrOptions,
  ): Promise<OcrResult>
}

const baseURL = useRuntimeConfig().app.baseURL

/**
 * Absolute URLs into public/vendor/tesseract. They have to be absolute: the
 * worker is spawned from a blob: URL that runs `importScripts(workerPath)`, and
 * a blob: base cannot resolve a root-relative path.
 */
function vendorUrl(file = ''): string {
  const dir = `${baseURL.replace(/\/*$/, '/')}vendor/tesseract/`
  return new URL(dir + file, window.location.href).href
}

/**
 * Only eng.traineddata.gz is vendored. Every other language is downloaded on
 * first use and cached in IndexedDB by the worker.
 */
const REMOTE_LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0'

const LANGUAGES: { value: string; label: string }[] = [
  { value: 'chi_sim', label: 'Chinese (Simplified)' },
  { value: 'chi_tra', label: 'Chinese (Traditional)' },
  { value: 'jpn', label: 'Japanese' },
  { value: 'kor', label: 'Korean' },
  { value: 'fra', label: 'French' },
  { value: 'deu', label: 'German' },
  { value: 'spa', label: 'Spanish' },
  { value: 'por', label: 'Portuguese' },
  { value: 'ita', label: 'Italian' },
  { value: 'rus', label: 'Russian' },
  { value: 'ara', label: 'Arabic' },
  { value: 'hin', label: 'Hindi' },
  { value: 'tha', label: 'Thai' },
  { value: 'vie', label: 'Vietnamese' },
  { value: 'nld', label: 'Dutch' },
  { value: 'pol', label: 'Polish' },
  { value: 'tur', label: 'Turkish' },
  { value: 'ukr', label: 'Ukrainian' },
  { value: 'swe', label: 'Swedish' },
]

function loadTesseract(): Promise<TesseractNamespace> {
  const w = window as unknown as { Tesseract?: TesseractNamespace }
  if (w.Tesseract) return Promise.resolve(w.Tesseract)
  const src = vendorUrl('tesseract.min.js')
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script')
    tag.src = src
    tag.async = true
    tag.onload = () => {
      if (w.Tesseract) resolve(w.Tesseract)
      else reject(new Error('tesseract.min.js loaded but exported nothing'))
    }
    tag.onerror = () => reject(new Error(`could not load ${src}`))
    document.head.appendChild(tag)
  })
}

/* ------------------------------------------------------------------ selection */

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

type Phase = 'select' | 'result'

const phase = ref<Phase>('select')
const canvasEl = ref<HTMLCanvasElement | null>(null)
const dragging = ref(false)
const hasRect = ref(false)
let startX = 0
let startY = 0
let curX = 0
let curY = 0

/** The captured frame, kept so a language change can re-read the same crop. */
const cropCanvas = shallowRef<HTMLCanvasElement | null>(null)

function currentRect(): Rect {
  return {
    x: Math.min(startX, curX),
    y: Math.min(startY, curY),
    w: Math.abs(curX - startX),
    h: Math.abs(curY - startY),
  }
}

function sizeCanvas() {
  const c = canvasEl.value
  if (!c) return
  // 1:1 with the viewport: the marquee is drawn straight from clientX/clientY,
  // so any scaling here would make it drift away from the cursor.
  c.width = window.innerWidth
  c.height = window.innerHeight
  paint()
}

function paint() {
  const c = canvasEl.value
  const ctx = c?.getContext('2d')
  if (!c || !ctx) return

  ctx.clearRect(0, 0, c.width, c.height)
  ctx.fillStyle = 'rgba(7, 9, 12, 0.55)'
  ctx.fillRect(0, 0, c.width, c.height)
  if (!hasRect.value) return

  const r = currentRect()
  if (r.w < 1 || r.h < 1) return

  // Punch the selection out of the mask so the live picture shows through.
  ctx.clearRect(r.x, r.y, r.w, r.h)
  ctx.strokeStyle = '#22d3ee'
  ctx.lineWidth = 2
  ctx.setLineDash([6, 3])
  ctx.strokeRect(r.x, r.y, r.w, r.h)
  ctx.setLineDash([])

  const label = `${Math.round(r.w)} × ${Math.round(r.h)}`
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace'
  const tw = ctx.measureText(label).width
  const bx = Math.max(4, Math.min(r.x, c.width - tw - 16))
  const by = r.y > 26 ? r.y - 8 : Math.min(c.height - 6, r.y + r.h + 20)
  ctx.fillStyle = 'rgba(7, 9, 12, 0.85)'
  ctx.fillRect(bx - 5, by - 13, tw + 10, 18)
  ctx.fillStyle = '#22d3ee'
  ctx.fillText(label, bx, by)
}

/** Pointer capture throws if the pointer is already gone; never fatal. */
function capturePointer(el: HTMLElement | null, id: number) {
  try {
    el?.setPointerCapture(id)
  } catch {
    // Fall back to plain event bubbling.
  }
}

function onSelectDown(e: PointerEvent) {
  if (e.button !== 0) return
  dragging.value = true
  hasRect.value = true
  startX = curX = e.clientX
  startY = curY = e.clientY
  capturePointer(canvasEl.value, e.pointerId)
  paint()
}

function onSelectMove(e: PointerEvent) {
  if (!dragging.value) return
  curX = e.clientX
  curY = e.clientY
  paint()
}

function onSelectUp(e: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  if (canvasEl.value?.hasPointerCapture(e.pointerId)) {
    canvasEl.value.releasePointerCapture(e.pointerId)
  }
  curX = e.clientX
  curY = e.clientY

  const r = currentRect()
  if (r.w < 10 || r.h < 10) {
    // A stray click, not a selection - stay in the overlay and let them retry.
    hasRect.value = false
    paint()
    return
  }
  void capturePhase(r)
}

/* --------------------------------------------------------------------- crop */

function cropFromVideo(r: Rect): HTMLCanvasElement | null {
  const video = props.video
  if (!video || !video.srcObject) return null

  const box = video.getBoundingClientRect()
  const res = capture.resolution.value
  const vidW = video.videoWidth || res?.width || 0
  const vidH = video.videoHeight || res?.height || 0
  if (!vidW || !vidH || box.width < 1 || box.height < 1) return null

  // The picture is letterboxed or pillarboxed inside the element, so map only
  // the part of the box that actually shows video.
  const aspect = vidW / vidH
  let dispW = box.width
  let dispH = box.height
  let offX = 0
  let offY = 0
  if (box.width / box.height > aspect) {
    dispW = box.height * aspect
    offX = (box.width - dispW) / 2
  } else {
    dispH = box.width / aspect
    offY = (box.height - dispH) / 2
  }

  const sx = Math.max(0, Math.round(((r.x - box.left - offX) / dispW) * vidW))
  const sy = Math.max(0, Math.round(((r.y - box.top - offY) / dispH) * vidH))
  const sw = Math.min(vidW - sx, Math.round((r.w / dispW) * vidW))
  const sh = Math.min(vidH - sy, Math.round((r.h / dispH) * vidH))
  if (sw <= 0 || sh <= 0) return null

  const out = document.createElement('canvas')
  out.width = sw
  out.height = sh
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)
  return out
}

async function capturePhase(r: Rect) {
  const crop = cropFromVideo(r)
  if (!crop) {
    toasts.warn('Could not capture the selected area')
    panels.hide('copy')
    return
  }
  cropCanvas.value = crop
  cropSize.value = { w: crop.width, h: crop.height }
  phase.value = 'result'
  placePanel()
  await runOcr()
}

/* ---------------------------------------------------------------------- OCR */

const busy = ref(false)
const status = ref('')
const progress = ref(0)
const rawText = ref('')
const cropSize = ref<{ w: number; h: number } | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
let ocrRun = 0

const language = computed(() => settings.ocrLanguage || 'eng')
const needsNetwork = computed(() => language.value !== 'eng')

const displayText = computed(() =>
  settings.ocrTrimSpaces ? rawText.value.replace(/ /g, '') : rawText.value,
)

function prettyStatus(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

async function runOcr() {
  const crop = cropCanvas.value
  if (!crop) return

  const run = ++ocrRun
  busy.value = true
  progress.value = 0
  rawText.value = ''
  status.value = 'Loading OCR engine…'

  try {
    const tesseract = await loadTesseract()
    if (run !== ocrRun) return

    const lang = language.value
    const result = await tesseract.recognize(crop, lang, {
      logger: (m: OcrLog) => {
        if (run !== ocrRun || !m.status) return
        status.value = prettyStatus(m.status)
        if (typeof m.progress === 'number') progress.value = m.progress
      },
      workerPath: vendorUrl('worker.min.js'),
      // A directory: the worker appends the SIMD or plain core filename itself.
      corePath: vendorUrl(),
      // Load-bearing: without it tesseract.js 5 asks for
      // tesseract-core-simd-lstm.wasm.js, which is not one of the two cores we
      // vendored. Verified against the vendored build.
      legacyCore: true,
      langPath: lang === 'eng' ? vendorUrl() : REMOTE_LANG_PATH,
    })
    if (run !== ocrRun) return

    rawText.value = result.data.text
    busy.value = false
    if (!result.data.text.trim()) toasts.info('No text detected in the selected area')
  } catch (err) {
    if (run !== ocrRun) return
    busy.value = false
    rawText.value = ''
    const message = err instanceof Error ? err.message : String(err)
    toasts.error(`OCR failed: ${message}`)
  }
}

watch(
  () => settings.ocrLanguage,
  () => {
    if (phase.value === 'result' && cropCanvas.value) void runOcr()
  },
)

/* ---------------------------------------------------------------- clipboard */

async function copyToClipboard() {
  const text = displayText.value
  if (!text) {
    toasts.info('Nothing to copy')
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    toasts.success('Copied to clipboard')
  } catch {
    // Clipboard permission denied or an insecure context: fall back to the
    // selection-based copy the pre-Vue client used.
    const ta = textareaEl.value
    if (ta) {
      ta.select()
      const ok = document.execCommand('copy')
      ta.setSelectionRange(0, 0)
      if (ok) {
        toasts.success('Copied to clipboard')
        return
      }
    }
    toasts.error('Could not write to the clipboard')
  }
}

/* -------------------------------------------------------- draggable result */

const pos = ref({ x: 0, y: 0 })
const panelWidth = ref(560)
let panelDragging = false
let dragOffX = 0
let dragOffY = 0

function placePanel() {
  panelWidth.value = Math.min(560, window.innerWidth - 32)
  pos.value = {
    x: Math.max(16, Math.round((window.innerWidth - panelWidth.value) / 2)),
    y: Math.max(16, Math.round(window.innerHeight * 0.12)),
  }
}

function clampPanel(x: number, y: number) {
  const maxX = Math.max(8, window.innerWidth - panelWidth.value - 8)
  const maxY = Math.max(8, window.innerHeight - 80)
  return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) }
}

function onPanelDown(e: PointerEvent) {
  if (e.button !== 0) return
  panelDragging = true
  dragOffX = e.clientX - pos.value.x
  dragOffY = e.clientY - pos.value.y
  capturePointer(e.currentTarget as HTMLElement, e.pointerId)
}

function onPanelMove(e: PointerEvent) {
  if (!panelDragging) return
  pos.value = clampPanel(e.clientX - dragOffX, e.clientY - dragOffY)
}

function onPanelUp(e: PointerEvent) {
  if (!panelDragging) return
  panelDragging = false
  const el = e.currentTarget as HTMLElement
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
}

/* ------------------------------------------------------------------ chrome */

function close() {
  ocrRun += 1
  panels.hide('copy')
}

function reselect() {
  ocrRun += 1
  busy.value = false
  rawText.value = ''
  cropCanvas.value = null
  cropSize.value = null
  hasRect.value = false
  dragging.value = false
  phase.value = 'select'
  void nextTick(sizeCanvas)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  // Swallow it: the page-level handler would otherwise forward Escape to the
  // target machine while the overlay is up.
  e.preventDefault()
  e.stopPropagation()
  close()
}

function onResize() {
  if (phase.value === 'select') sizeCanvas()
  else pos.value = clampPanel(pos.value.x, pos.value.y)
}

onMounted(() => {
  placePanel()
  sizeCanvas()
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  ocrRun += 1
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <!-- Region picker -------------------------------------------------------->
  <div v-if="phase === 'select'" class="fixed inset-0 z-[2600]">
    <canvas
      ref="canvasEl"
      class="absolute left-0 top-0 cursor-crosshair touch-none"
      @pointerdown="onSelectDown"
      @pointermove="onSelectMove"
      @pointerup="onSelectUp"
      @pointercancel="onSelectUp"
      @contextmenu.prevent
    ></canvas>

    <div
      class="kvm-panel pointer-events-none absolute left-1/2 top-6 flex -translate-x-1/2 items-center gap-2.5 px-3.5 py-2"
    >
      <AppIcon name="crop" class="text-signal-400" />
      <span class="text-[13px] text-mist-200">Drag to select a region to read</span>
      <span
        class="rounded-md border border-ink-600 bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-mist-400"
      >
        Esc
      </span>
    </div>
  </div>

  <!-- Result --------------------------------------------------------------->
  <div
    v-else
    class="kvm-panel fixed z-[2700] flex flex-col p-4"
    :style="{ left: `${pos.x}px`, top: `${pos.y}px`, width: `${panelWidth}px` }"
  >
    <div
      class="-mx-4 -mt-4 flex cursor-grab touch-none items-center gap-3 px-4 py-3 active:cursor-grabbing"
      @pointerdown="onPanelDown"
      @pointermove="onPanelMove"
      @pointerup="onPanelUp"
      @pointercancel="onPanelUp"
    >
      <span
        class="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-signal-500/10 text-signal-400"
      >
        <AppIcon name="search" />
      </span>
      <div class="min-w-0 flex-1">
        <h3 class="text-sm font-semibold text-mist-100">Extracted text</h3>
        <p class="kvm-hint truncate">
          <template v-if="cropSize">Read from a {{ cropSize.w }} × {{ cropSize.h }} crop of the target</template>
          <template v-else>Recognized from the region you selected</template>
        </p>
      </div>
      <button class="kvm-btn kvm-btn-icon" title="Select another region" @click="reselect">
        <AppIcon name="crop" />
      </button>
      <button class="kvm-btn kvm-btn-icon" title="Close" @click="close">
        <AppIcon name="x" />
      </button>
    </div>

    <div
      v-if="busy"
      class="mt-4 rounded-lg border border-ink-600 bg-ink-900 px-3 py-2.5"
      aria-live="polite"
    >
      <div class="flex items-center gap-2.5">
        <AppIcon name="refresh" class="animate-spin text-signal-400" />
        <span class="flex-1 truncate text-[13px] text-mist-200">{{ status }}</span>
        <span class="font-mono text-[11px] text-mist-400">{{ Math.round(progress * 100) }}%</span>
      </div>
      <div class="kvm-progress mt-2">
        <span class="bar" :style="{ width: `${Math.round(progress * 100)}%` }"></span>
      </div>
    </div>

    <textarea
      ref="textareaEl"
      readonly
      rows="10"
      placeholder="OCR result will appear here…"
      class="kvm-textarea kvm-scroll mt-4 h-48 text-[13px] leading-relaxed"
      :value="displayText"
    ></textarea>

    <div class="mt-3 flex flex-wrap items-center gap-3">
      <label class="kvm-toggle">
        <input v-model="settings.ocrTrimSpaces" type="checkbox" />
        <span class="kvm-toggle-track"></span>
        <span class="kvm-toggle-text">Strip spaces (CJK)</span>
      </label>

      <div class="ml-auto flex items-center gap-2">
        <label for="ocr-language" class="kvm-hint">Language</label>
        <select
          id="ocr-language"
          v-model="settings.ocrLanguage"
          class="kvm-select w-44 py-1 text-[13px]"
        >
          <option value="eng">English (offline)</option>
          <optgroup label="Downloaded on first use">
            <option v-for="l in LANGUAGES" :key="l.value" :value="l.value">{{ l.label }}</option>
          </optgroup>
        </select>
      </div>
    </div>

    <p v-if="needsNetwork" class="kvm-hint mt-2 flex items-start gap-1.5">
      <AppIcon name="alert-triangle" class="mt-0.5 flex-none text-warn-400" />
      <span>
        Only English is bundled with the app. This language downloads its
        training data the first time you use it, so it needs an internet
        connection.
      </span>
    </p>

    <div class="mt-4 flex items-center justify-between gap-3">
      <span class="font-mono text-[11px] text-mist-400">{{ displayText.length }} chars</span>
      <div class="flex gap-2">
        <button class="kvm-btn" @click="close">
          <AppIcon name="x" /> Close
        </button>
        <button class="kvm-btn kvm-btn-primary" :disabled="busy" @click="copyToClipboard">
          <AppIcon name="clipboard" /> Copy to clipboard
        </button>
      </div>
    </div>
  </div>
</template>
