<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ABS_MAX } from '~/utils/ch9329'
import { MOUSE_LEFT, MOUSE_MIDDLE, MOUSE_RIGHT, useKvm } from '~/composables/useKvm'
import { useCapture } from '~/composables/useCapture'
import { useSettings } from '~/composables/useSettings'
import { usePanels } from '~/composables/usePanels'
import { useStackedKeys } from '~/composables/useStackedKeys'
import { useJiggler } from '~/composables/useJiggler'
import { useToasts } from '~/composables/useToasts'

const kvm = useKvm()
const capture = useCapture()
const panels = usePanels()
const stacked = useStackedKeys()
const jiggler = useJiggler()
const toasts = useToasts()
const { settings, startAutosave } = useSettings()

const videoEl = ref<HTMLVideoElement | null>(null)
const stageEl = ref<HTMLDivElement | null>(null)
const toolbarHidden = ref(false)
const isFullscreen = ref(false)

const serialSupported = computed(() => kvm.link.supported.value)
// Don't stack "no signal" behind the first-run prompt; the prompt already
// explains that nothing is connected yet.
const showNoSignal = computed(
  () => !capture.active.value && !panels.open.connectPrompt && serialSupported.value,
)

/* ------------------------------------------------------------------ capture */
watch(
  () => capture.stream.value,
  (s) => {
    if (videoEl.value) videoEl.value.srcObject = s
  },
)

async function startCapture() {
  const ok = await capture.start(settings.enableAudio)
  panels.hide('connectPrompt')
  if (ok) {
    toasts.success(`Capture started — ${capture.deviceName.value}`)
    if (capture.fuzzyMatch.value) {
      toasts.warn('Capture device VID:PID could not be confirmed; it may be the wrong device')
    }
  } else {
    toasts.error(capture.lastError.value ?? 'Could not start capture')
  }
}

/* ------------------------------------------------------------------- serial */
async function toggleSerial() {
  if (kvm.link.connected.value) {
    await kvm.link.disconnect()
    toasts.info('Serial link closed')
    return
  }
  const ok = await kvm.link.connect()
  if (ok) {
    toasts.success('Serial link established')
    // Put the HID device into a known state, as the reference client does.
    setTimeout(() => void kvm.softReset(), 100)
  } else if (kvm.link.lastError.value) {
    toasts.error(kvm.link.lastError.value)
  }
}

/* -------------------------------------------------------------------- mouse */
function stageMetrics() {
  const el = stageEl.value
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const res = capture.resolution.value
  const aspect = res ? res.width / res.height : 16 / 9

  // The video is letterboxed inside the stage; map only the picture area so the
  // pointer lands where the user is actually looking.
  let w = rect.width
  let h = rect.height
  let offX = rect.left
  let offY = rect.top
  if (rect.width / rect.height > aspect) {
    w = rect.height * aspect
    offX = rect.left + (rect.width - w) / 2
  } else {
    h = rect.width / aspect
    offY = rect.top + (rect.height - h) / 2
  }
  return { w, h, offX, offY }
}

async function onPointerMove(e: MouseEvent) {
  jiggler.noteActivity()
  if (!kvm.link.connected.value) return

  if (kvm.config.absoluteMode) {
    const m = stageMetrics()
    if (!m) return
    const nx = (e.clientX - m.offX) / m.w
    const ny = (e.clientY - m.offY) / m.h
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return
    await kvm.mouseMoveAbsolute(nx * ABS_MAX, ny * ABS_MAX)
  } else {
    const dx = Math.round(e.movementX * settings.relativeMouseSensitivity)
    const dy = Math.round(e.movementY * settings.relativeMouseSensitivity)
    if (!dx && !dy) return
    await kvm.mouseMoveRelative(dx, dy, 0)
  }
}

function buttonMask(button: number) {
  if (button === 0) return MOUSE_LEFT
  if (button === 2) return MOUSE_RIGHT
  if (button === 1) return MOUSE_MIDDLE
  return 0
}

async function onPointerDown(e: MouseEvent) {
  jiggler.noteActivity()
  const mask = buttonMask(e.button)
  if (mask) await kvm.mouseButtonPress(mask)
}

async function onPointerUp(e: MouseEvent) {
  const mask = buttonMask(e.button)
  if (mask) await kvm.mouseButtonRelease(mask)
}

async function onWheel(e: WheelEvent) {
  e.preventDefault()
  jiggler.noteActivity()
  await kvm.mouseScroll(e.deltaY > 0 ? settings.scrollSensitivity : -settings.scrollSensitivity)
}

function onStageClick() {
  if (!kvm.config.absoluteMode && document.pointerLockElement !== stageEl.value) {
    stageEl.value?.requestPointerLock()
  }
}

/* ----------------------------------------------------------------- keyboard */
function typingInField(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  if (!t) return false
  return (
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.isContentEditable
  )
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

async function onKeydown(e: KeyboardEvent) {
  if (typingInField(e)) return
  jiggler.noteActivity()
  if (stacked.onKeydown(e)) return
  // Let the browser's own paste event through so the paste box can read it.
  if ((e.ctrlKey || e.metaKey) && e.key === 'v') return

  e.preventDefault()
  if (!kvm.link.connected.value) return
  if (MODIFIER_KEYS.has(e.key)) await kvm.setModifierKey(e.keyCode, e.location === 2)
  else await kvm.pressKey(e.keyCode)
}

async function onKeyup(e: KeyboardEvent) {
  if (typingInField(e)) return
  if (stacked.onKeyup(e)) return
  if ((e.ctrlKey || e.metaKey) && e.key === 'v') return

  e.preventDefault()
  if (!kvm.link.connected.value) return
  if (MODIFIER_KEYS.has(e.key)) await kvm.unsetModifierKey(e.keyCode, e.location === 2)
  else await kvm.releaseKey(e.keyCode)
}

/* --------------------------------------------------------------- fullscreen */
async function toggleFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen()
  else await document.documentElement.requestFullscreen()
}
function syncFullscreen() {
  isFullscreen.value = !!document.fullscreenElement
}

/* -------------------------------------------------------------- screenshot */
async function takeScreenshot() {
  const v = videoEl.value
  if (!v?.srcObject) {
    toasts.warn('No video stream available')
    return
  }
  const canvas = document.createElement('canvas')
  canvas.width = v.videoWidth
  canvas.height = v.videoHeight
  canvas.getContext('2d')!.drawImage(v, 0, 0, canvas.width, canvas.height)
  canvas.toBlob((blob) => {
    if (!blob) {
      toasts.error('Failed to capture screenshot')
      return
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `kvm-screenshot-${stamp}.png`
    a.click()
    URL.revokeObjectURL(url)
    toasts.success('Screenshot saved')
  }, 'image/png')
}

/* ------------------------------------------------------------------ mounting */
watch(
  () => settings.relativeMouseMode,
  (rel) => (kvm.config.absoluteMode = !rel),
  { immediate: true },
)
watch(() => settings.invertScrollwheel, (v) => (kvm.config.invertScroll = v), { immediate: true })
watch(() => settings.scrollSensitivity, (v) => (kvm.config.scrollSensitivity = v), { immediate: true })
watch(() => settings.ctrlCmdSwap, (v) => (kvm.config.ctrlCmdSwap = v), { immediate: true })

onMounted(() => {
  startAutosave()
  if (!settings.skipConnectPrompt) panels.show('connectPrompt')
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keyup', onKeyup)
  document.addEventListener('fullscreenchange', syncFullscreen)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keyup', onKeyup)
  document.removeEventListener('fullscreenchange', syncFullscreen)
  jiggler.dispose()
  capture.stop()
})
</script>

<template>
  <ClientOnly>
    <div class="relative h-screen w-screen overflow-hidden bg-ink-950">
      <video ref="videoEl" class="kvm-video" autoplay playsinline muted></video>

      <NoSignal v-if="showNoSignal" />

      <!-- Pointer surface, sitting over the picture -->
      <div
        ref="stageEl"
        class="kvm-touch"
        :class="{ 'no-cursor': !settings.showLocalCursor }"
        @mousemove="onPointerMove"
        @mousedown="onPointerDown"
        @mouseup="onPointerUp"
        @wheel.prevent="onWheel"
        @click="onStageClick"
        @contextmenu.prevent
      ></div>

      <KvmToolbar
        :hidden="toolbarHidden"
        :fullscreen="isFullscreen"
        @toggle-serial="toggleSerial"
        @screenshot="takeScreenshot"
        @toggle-fullscreen="toggleFullscreen"
        @hide="toolbarHidden = true"
      />
      <button
        v-if="toolbarHidden"
        class="kvm-btn kvm-btn-icon fixed right-2 top-2 z-[1001]"
        title="Show toolbar"
        @click="toolbarHidden = false"
      >
        <AppIcon name="chevron-down" />
      </button>

      <StackedKeysDisplay />

      <PastePanel v-if="panels.open.paste" />
      <CopyPanel v-if="panels.open.copy" :video="videoEl" />
      <KeyboardPanel v-if="panels.open.keyboard" />
      <QuickAccessPanel v-if="panels.open.quickAccess" />
      <RecorderPanel v-if="panels.open.recorder" :video="videoEl" />
      <SettingsPanel v-if="panels.open.settings" />

      <ConnectPrompt v-if="panels.open.connectPrompt" @start="startCapture" />
      <BrowserWarning v-if="!serialSupported" />
    </div>
  </ClientOnly>
</template>
