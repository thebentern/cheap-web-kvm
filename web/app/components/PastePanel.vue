<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Paste box — types text into the target as real USB HID keystrokes.
 *
 * Ported from paste-box.js. The character table, the press-shift/press/release/
 * release-shift ordering and the 30 ms inter-character delay are reproduced
 * verbatim: the target sees a physical keyboard, so anything faster gets dropped
 * by slow BIOS and KVM firmware.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useKvm } from '~/composables/useKvm'
import { usePanels } from '~/composables/usePanels'
import { useSettings } from '~/composables/useSettings'
import { useToasts } from '~/composables/useToasts'

const kvm = useKvm()
const panels = usePanels()
const toasts = useToasts()
const { settings } = useSettings()

const MAX_CHARS = 1000
/** Per-character pacing, from the reference client. */
const CHAR_DELAY_MS = 30
/** Runs longer than this ask first, even when "ask on paste" is off. */
const CONFIRM_THRESHOLD_MS = 10_000

type CharMapping = number | { keycode: number; shift: boolean }

/** Verbatim from paste-box.js — US layout, JS keyCodes. */
const CHAR_TO_KEYCODE: Record<string, CharMapping> = {
  '0': 48, '1': 49, '2': 50, '3': 51, '4': 52,
  '5': 53, '6': 54, '7': 55, '8': 56, '9': 57,
  'a': 65, 'b': 66, 'c': 67, 'd': 68, 'e': 69,
  'f': 70, 'g': 71, 'h': 72, 'i': 73, 'j': 74,
  'k': 75, 'l': 76, 'm': 77, 'n': 78, 'o': 79,
  'p': 80, 'q': 81, 'r': 82, 's': 83, 't': 84,
  'u': 85, 'v': 86, 'w': 87, 'x': 88, 'y': 89, 'z': 90,
  '!': { keycode: 49, shift: true }, '@': { keycode: 50, shift: true },
  '#': { keycode: 51, shift: true }, '$': { keycode: 52, shift: true },
  '%': { keycode: 53, shift: true }, '^': { keycode: 54, shift: true },
  '&': { keycode: 55, shift: true }, '*': { keycode: 56, shift: true },
  '(': { keycode: 57, shift: true }, ')': { keycode: 48, shift: true },
  ' ': 32, '-': 189, '_': { keycode: 189, shift: true },
  '=': 187, '+': { keycode: 187, shift: true },
  '[': 219, '{': { keycode: 219, shift: true },
  ']': 221, '}': { keycode: 221, shift: true },
  '\\': 220, '|': { keycode: 220, shift: true },
  ';': 186, ':': { keycode: 186, shift: true },
  "'": 222, '"': { keycode: 222, shift: true },
  ',': 188, '<': { keycode: 188, shift: true },
  '.': 190, '>': { keycode: 190, shift: true },
  '/': 191, '?': { keycode: 191, shift: true },
  '`': 192, '~': { keycode: 192, shift: true },
  '\n': 13, '\t': 9,
}

/* --------------------------------------------------------------------- state */
const text = ref('')
const sending = ref(false)
const cancelling = ref(false)
const confirming = ref(false)
const progress = ref(0)
const sentCount = ref(0)
const skippedCount = ref(0)

const textareaEl = ref<HTMLTextAreaElement | null>(null)
const confirmBtn = ref<HTMLButtonElement | null>(null)

/** Read by the send loop between characters; not rendered, so a plain flag. */
let cancelled = false

const charCount = computed(() => text.value.length)
const estimateMs = computed(() => charCount.value * CHAR_DELAY_MS)
const estimateLabel = computed(() => `${(estimateMs.value / 1000).toFixed(1)} s`)
const needsConfirm = computed(() => settings.askOnPaste || estimateMs.value > CONFIRM_THRESHOLD_MS)

const counterClass = computed(() => {
  if (charCount.value >= MAX_CHARS) return 'text-alert-400'
  if (charCount.value >= MAX_CHARS * 0.9) return 'text-warn-400'
  return ''
})

/* ---------------------------------------------------------------- key output */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Shift is pressed as an ordinary key (keyCode 16 → usage 0xE1) exactly as the
 * reference does; the firmware folds usages 0xE0..0xE7 into the modifier byte.
 */
async function sendKeyPress(keycode: number, needsShift = false) {
  if (needsShift) await kvm.pressKey(16)
  await kvm.pressKey(keycode)
  await kvm.releaseKey(keycode)
  if (needsShift) await kvm.releaseKey(16)
}

/* ------------------------------------------------------------------ sending */
function requestSend() {
  if (sending.value) return

  if (!text.value) {
    toasts.warn('No text to send')
    return
  }
  if (!kvm.link.connected.value) {
    toasts.error('HID not connected')
    return
  }

  if (needsConfirm.value) {
    confirming.value = true
    void nextTick(() => confirmBtn.value?.focus())
    return
  }
  void run()
}

async function run() {
  confirming.value = false
  const source = text.value

  cancelled = false
  cancelling.value = false
  sending.value = true
  progress.value = 0
  sentCount.value = 0
  skippedCount.value = 0

  let linkLost = false

  for (let i = 0; i < source.length; i++) {
    if (cancelled) break
    // The reference assumed the port stayed up; bail out instead of silently
    // dropping hundreds of keystrokes into a closed port.
    if (!kvm.link.connected.value) {
      linkLost = true
      break
    }

    const char = source.charAt(i)

    if (char >= 'A' && char <= 'Z') {
      await sendKeyPress(char.charCodeAt(0), true)
      sentCount.value++
    } else if (char >= 'a' && char <= 'z') {
      await sendKeyPress(char.toUpperCase().charCodeAt(0), false)
      sentCount.value++
    } else {
      const mapping: CharMapping | undefined = CHAR_TO_KEYCODE[char]
      if (mapping === undefined) {
        skippedCount.value++
      } else if (typeof mapping === 'object') {
        await sendKeyPress(mapping.keycode, mapping.shift)
        sentCount.value++
      } else {
        await sendKeyPress(mapping, false)
        sentCount.value++
      }
    }

    progress.value = ((i + 1) / source.length) * 100
    await sleep(CHAR_DELAY_MS)
  }

  sending.value = false
  cancelling.value = false

  if (linkLost) {
    toasts.error(`Serial link dropped after ${sentCount.value} characters`)
    return
  }
  // A cancel already announced itself, and the text stays put so it can be
  // retried or trimmed.
  if (cancelled) return

  const plural = sentCount.value === 1 ? '' : 's'
  let message = `Sent ${sentCount.value} character${plural}`
  if (skippedCount.value > 0) message += `, skipped ${skippedCount.value} unsupported`
  toasts.success(message)

  text.value = ''
  panels.hide('paste')
}

function cancelSend() {
  if (!sending.value || cancelling.value) return
  cancelled = true
  cancelling.value = true
  toasts.warn('Paste operation cancelled')
}

function clearText() {
  text.value = ''
  textareaEl.value?.focus()
}

function close() {
  // Closing mid-run stops the loop rather than leaving it typing invisibly.
  if (sending.value) cancelled = true
  panels.hide('paste')
}

/* -------------------------------------------------------------------- input */
/**
 * A real paste lands here first so the clipboard text can be capped at
 * MAX_CHARS and its CRLFs normalised — the table has no mapping for '\r', so
 * Windows clipboards would otherwise report every newline as unsupported.
 */
function onPaste(e: ClipboardEvent) {
  const clip = e.clipboardData?.getData('text')
  if (!clip) return

  e.preventDefault()
  const el = e.target as HTMLTextAreaElement
  const start = el.selectionStart ?? text.value.length
  const end = el.selectionEnd ?? start
  const insert = clip.replace(/\r\n?/g, '\n')

  text.value = (text.value.slice(0, start) + insert + text.value.slice(end)).slice(0, MAX_CHARS)

  const caret = Math.min(start + insert.length, MAX_CHARS)
  void nextTick(() => el.setSelectionRange(caret, caret))
}

function onPanelKeydown(e: KeyboardEvent) {
  // Keep panel typing local: index.vue listens on window and would otherwise
  // forward these keystrokes to the target.
  e.stopPropagation()
  if (e.key !== 'Escape') return
  e.preventDefault()
  if (sending.value) cancelSend()
  else if (confirming.value) confirming.value = false
  else close()
}

/* --------------------------------------------------------------- dragging */
const pos = reactive({ x: 0, y: 0 })
let dragging = false
let dragStart = { x: 0, y: 0, originX: 0, originY: 0 }

const panelStyle = computed(() => ({
  transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))`,
}))

function onDragStart(e: PointerEvent) {
  if (e.button !== 0) return
  // Let the close button behave like a button.
  if ((e.target as HTMLElement).closest('button')) return
  dragging = true
  dragStart = { x: e.clientX, y: e.clientY, originX: pos.x, originY: pos.y }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onDragMove(e: PointerEvent) {
  if (!dragging) return
  pos.x = dragStart.originX + (e.clientX - dragStart.x)
  pos.y = dragStart.originY + (e.clientY - dragStart.y)
}

function onDragEnd(e: PointerEvent) {
  if (!dragging) return
  dragging = false
  ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
}

/* -------------------------------------------------------------- lifecycle */
onMounted(() => {
  void nextTick(() => textareaEl.value?.focus())
})

onBeforeUnmount(() => {
  cancelled = true
})
</script>

<template>
  <div
    class="kvm-panel fixed left-1/2 top-1/2 z-[1500] w-[min(92vw,30rem)] p-4"
    :style="panelStyle"
    role="dialog"
    aria-label="Paste to target"
    @keydown="onPanelKeydown"
    @keyup.stop
  >
    <div
      class="kvm-drag flex items-start justify-between gap-3"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <div>
        <h3 class="flex items-center gap-2 text-sm font-semibold text-mist-100">
          <AppIcon name="clipboard" class="text-signal-400" /> Paste to target
        </h3>
        <p class="kvm-hint mt-1">
          Sent as keystrokes over HID, roughly 30 ms per character. Unsupported characters are
          skipped.
        </p>
      </div>
      <button
        class="kvm-btn kvm-btn-icon -mt-0.5 -mr-0.5 flex-none"
        title="Close"
        aria-label="Close"
        @click="close"
      >
        <AppIcon name="x" />
      </button>
    </div>

    <div class="mt-4 flex items-baseline justify-between gap-3">
      <span class="kvm-label">Text</span>
      <span class="paste-char-counter" :class="counterClass">{{ charCount }} / {{ MAX_CHARS }}</span>
    </div>

    <textarea
      ref="textareaEl"
      v-model="text"
      class="kvm-textarea kvm-scroll mt-1.5 h-40 leading-relaxed disabled:opacity-60"
      placeholder="Text to type into the target machine..."
      :maxlength="MAX_CHARS"
      :disabled="sending"
      spellcheck="false"
      autocomplete="off"
      @paste="onPaste"
    ></textarea>

    <!-- Confirmation, in-panel: long runs hold the target's keyboard hostage. -->
    <div
      v-if="confirming"
      class="mt-3 rounded-lg border border-warn-400/40 bg-ink-900 p-3"
      role="alertdialog"
    >
      <p class="flex items-start gap-2 text-[0.8125rem] text-mist-200">
        <AppIcon name="alert-triangle" class="mt-0.5 flex-none text-warn-400" />
        <span>
          Typing {{ charCount }} characters takes about
          <strong class="text-mist-100">{{ estimateLabel }}</strong
          >. The target has to keep keyboard focus for the whole run.
        </span>
      </p>
      <div class="mt-3 flex justify-end gap-2">
        <button class="kvm-btn" @click="confirming = false">
          <AppIcon name="x" /> Cancel
        </button>
        <button ref="confirmBtn" class="kvm-btn kvm-btn-primary" @click="run">
          <AppIcon name="send" /> Type it
        </button>
      </div>
    </div>

    <div v-if="sending" class="mt-3">
      <div class="kvm-progress">
        <span class="bar" :style="{ width: `${progress}%` }"></span>
      </div>
      <p class="kvm-hint mt-1.5 flex justify-between gap-3">
        <span>{{ cancelling ? 'Stopping...' : 'Typing into the target...' }}</span>
        <span>
          {{ sentCount }} sent<template v-if="skippedCount"> · {{ skippedCount }} skipped</template>
        </span>
      </p>
    </div>

    <div class="mt-4 flex flex-wrap items-center justify-end gap-2">
      <button v-if="sending" class="kvm-btn" :disabled="cancelling" @click="cancelSend">
        <AppIcon name="stop" class="text-warn-400" /> Cancel
      </button>
      <template v-else>
        <button class="kvm-btn" :disabled="!charCount" @click="clearText">
          <AppIcon name="trash" /> Clear
        </button>
        <button class="kvm-btn kvm-btn-primary" :disabled="!charCount" @click="requestSend">
          <AppIcon name="send" /> Send
        </button>
      </template>
    </div>
  </div>
</template>
