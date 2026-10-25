<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ABS_MAX } from '~/utils/ch9329'
import { createTouchRecognizer, type TouchIntent } from '~/utils/touchGestures'
import { MOUSE_LEFT, MOUSE_MIDDLE, MOUSE_RIGHT, useKvm } from '~/composables/useKvm'
import type { LinkKind } from '~/composables/useLink'
import { useCapture } from '~/composables/useCapture'
import { useSettings } from '~/composables/useSettings'
import { usePanels } from '~/composables/usePanels'
import { useStackedKeys } from '~/composables/useStackedKeys'
import { useJiggler } from '~/composables/useJiggler'
import { useToasts } from '~/composables/useToasts'
import { useWakeLock } from '~/composables/useWakeLock'

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
const startingCapture = ref(false)

const linkSupported = computed(() => kvm.link.supported.value)
// The card streams colour bars when the target is dark, so "no stream" is not
// the same question as "no signal" — useCapture watches the pixels for that.
// Don't stack this behind the first-run prompt, which already says as much.
// Capture trouble shows even without a HID link (Safari on iPad has none): its
// overlay carries the only Restart button. Plain "no signal" keeps the old gate.
const showNoSignal = computed(() => {
  if (panels.open.connectPrompt) return false
  const s = capture.status.value
  if (s === 'paused' || s === 'reconnecting' || s === 'failed') return true
  return (!capture.active.value || capture.testPattern.value) && linkSupported.value
})

/* ------------------------------------------------------------------ capture */
// Immediate, so a page remounted onto a stream that is already live shows it.
watch(
  () => capture.stream.value,
  (s) => {
    if (videoEl.value) videoEl.value.srcObject = s
  },
  { immediate: true, flush: 'post' },
)

// Say when the picture drops and when it comes back; the overlay says why.
watch(
  () => capture.status.value,
  (now, before) => {
    if (now === 'reconnecting' && before !== 'reconnecting') toasts.warn('Video lost, reconnecting')
    else if (now === 'live' && before === 'reconnecting') toasts.success('Video back')
  },
)

async function startCapture() {
  if (startingCapture.value) return
  startingCapture.value = true
  try {
    // WebKit grants a wake lock only inside a gesture, and this click is one.
    wakeLock?.sync(true)
    const ok = await capture.start(settings.enableAudio)
    wakeLock?.sync()
    // Left the page while capture was opening: nothing here to report to.
    if (unmounted) return
    panels.hide('connectPrompt')
    if (ok) {
      toasts.success(`Capture started — ${capture.deviceName.value}`)
      if (capture.fuzzyMatch.value) {
        toasts.warn('Capture device VID:PID could not be confirmed; it may be the wrong device')
      }
    } else {
      toasts.error(capture.lastError.value ?? 'Could not start capture')
    }
  } finally {
    startingCapture.value = false
  }
}

/* --------------------------------------------------------------------- link */
async function toggleLink(which: LinkKind) {
  const name = which === 'ble' ? 'Bluetooth' : 'Serial'
  if (kvm.link.connected.value && kvm.link.kind.value === which) {
    await kvm.link.disconnect()
    toasts.info(`${name} link closed`)
    return
  }
  const ok = await kvm.link.connect(which)
  if (ok) {
    toasts.success(`${name} link established`)
    // Put the HID device into a known state, as the reference client does.
    setTimeout(() => void kvm.softReset(), 100)
  } else if (kvm.link.lastError.value) {
    toasts.error(kvm.link.lastError.value)
  }
}

/* -------------------------------------------------------------------- mouse */
/**
 * Where the picture is on screen. Measured from the video element, not the
 * stage: CSS puts the video at the top of the stage, not in the middle, and
 * assuming otherwise put every tap above the finger on a 4:3 iPad. The frame is
 * then fitted inside the element in case object-fit letterboxes it. Before a
 * stream arrives the video has no size, so fall back to the stage.
 */
function stageMetrics() {
  const video = videoEl.value
  const playing = !!video && video.videoWidth > 0 && video.videoHeight > 0
  const el = playing ? video : stageEl.value
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  const res = capture.resolution.value
  const aspect = playing
    ? video!.videoWidth / video!.videoHeight
    : res
      ? res.width / res.height
      : 16 / 9

  // Map only the picture area so the pointer lands where the user is looking.
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

/** Map a client position onto the picture. Outside it, clamp or give up. */
function toAbs(clientX: number, clientY: number, clamp: boolean) {
  const m = stageMetrics()
  if (!m) return null
  let nx = (clientX - m.offX) / m.w
  let ny = (clientY - m.offY) / m.h
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
    if (!clamp) return null
    nx = Math.min(1, Math.max(0, nx))
    ny = Math.min(1, Math.max(0, ny))
  }
  return { x: nx * ABS_MAX, y: ny * ABS_MAX }
}

/**
 * Absolute move. Returns false, sending nothing, if the point is off the
 * picture. A move to where the pointer already is is skipped: the button
 * report that usually follows carries the position anyway.
 */
function moveTo(clientX: number, clientY: number, clamp: boolean) {
  const p = toAbs(clientX, clientY, clamp)
  if (!p) return false
  if (Math.round(p.x) !== kvm.hid.mouseX || Math.round(p.y) !== kvm.hid.mouseY) {
    void kvm.mouseMoveAbsolute(p.x, p.y)
  }
  return true
}

/** Sub-count remainders, so slow or scaled-down movement is not rounded away. */
let relRemX = 0
let relRemY = 0

/** Relative move, scaled by the sensitivity setting and split into ±127 reports. */
function moveBy(dx: number, dy: number) {
  // One NaN would poison the remainders and stop relative motion for good.
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
  relRemX += dx * settings.relativeMouseSensitivity
  relRemY += dy * settings.relativeMouseSensitivity
  let ix = Math.trunc(relRemX)
  let iy = Math.trunc(relRemY)
  relRemX -= ix
  relRemY -= iy
  while (ix || iy) {
    const sx = Math.max(-127, Math.min(127, ix))
    const sy = Math.max(-127, Math.min(127, iy))
    void kvm.mouseMoveRelative(sx, sy, 0)
    ix -= sx
    iy -= sy
  }
}

/*
 * Every call below is fired without awaiting. Each builds its frame
 * synchronously and both transports send in call order, so a move-press-release
 * stays in order without waiting on a round trip per step — and the Bluetooth
 * queue can still merge moves that pile up.
 */

/* -------------------------------------------------------------- mouse & pen */
const POINTER_BUTTONS = MOUSE_LEFT | MOUSE_RIGHT | MOUSE_MIDDLE

/** Buttons the mouse or pen has pressed, so letting go releases only those. */
let pointerHeld = 0
/** Buttons pressed off the picture or off the stage, ignored until let go. */
let pointerIgnored = 0
/** Fallback for WebKit before 17, whose pointer events have no movementX. */
let mouseLast: { x: number; y: number } | null = null
/** The pointer type of the last press, so a touch tap never asks for pointer lock. */
let lastPointerType = ''

/** PointerEvent.buttons lays out left, right and middle exactly as the report does. */
function syncButtons(buttons: number) {
  const want = buttons & POINTER_BUTTONS
  const press = want & ~pointerHeld
  const release = pointerHeld & ~want
  pointerHeld = want
  if (release) void kvm.mouseButtonRelease(release)
  if (press) void kvm.mouseButtonPress(press)
}

/**
 * Pointer events only report the first button down and the last one up, so the
 * button state is read from `buttons` on every event instead.
 */
function onMouseOrPen(e: PointerEvent) {
  let onPicture = true
  if (kvm.config.absoluteMode) {
    // Mid-drag, follow the pointer past the picture's edge rather than stop.
    onPicture = moveTo(e.clientX, e.clientY, pointerHeld !== 0)
  } else {
    const fromLast = (axis: 'x' | 'y', client: number) =>
      mouseLast ? client - mouseLast[axis] : 0
    moveBy(
      Number.isFinite(e.movementX) ? e.movementX : fromLast('x', e.clientX),
      Number.isFinite(e.movementY) ? e.movementY : fromLast('y', e.clientY),
    )
  }
  mouseLast = { x: e.clientX, y: e.clientY }

  // Only the stage's own pointerdown may start a press. A button pressed over
  // the toolbar and slid onto the picture would otherwise be pressed here and
  // released over there, out of our sight; a press in the letterbox would click
  // wherever the pointer last was. Adding a button mid-press is still fine.
  const down = e.buttons & POINTER_BUTTONS
  pointerIgnored &= down
  if (!onPicture || (e.type !== 'pointerdown' && !pointerHeld)) {
    pointerIgnored |= down & ~pointerHeld
  }
  syncButtons(down & ~pointerIgnored)
}

/* ------------------------------------------------------------ touch & pencil */
/** Fingers, in whichever style the mouse mode calls for. */
const fingers = createTouchRecognizer()
/**
 * The Pencil in relative mode works the screen like a finger on a trackpad.
 * Its own recogniser, so a resting palm never pairs with it into a scroll.
 */
const pencil = createTouchRecognizer()

function click(button: number) {
  void kvm.mouseButtonPress(button)
  void kvm.mouseButtonRelease(button)
}

function runTouch(intents: TouchIntent[]) {
  for (const i of intents) {
    switch (i.type) {
      case 'tap':
      case 'secondaryTap':
        // Trackpad style clicks wherever the pointer already is.
        if (kvm.config.absoluteMode && !moveTo(i.x, i.y, false)) break
        click(i.type === 'tap' ? MOUSE_LEFT : MOUSE_RIGHT)
        break
      case 'dragStart':
        moveTo(i.x, i.y, true)
        void kvm.mouseButtonPress(MOUSE_LEFT)
        break
      case 'dragMove':
        moveTo(i.x, i.y, true)
        break
      case 'dragEnd':
        moveTo(i.x, i.y, true)
        void kvm.mouseButtonRelease(MOUSE_LEFT)
        break
      case 'glide':
        moveBy(i.dx, i.dy)
        break
      case 'scroll':
        // The target scrolls whatever is under its pointer, so in direct style
        // put the pointer under the fingers first.
        if (kvm.config.absoluteMode) moveTo(i.x, i.y, true)
        for (let n = 0; n < Math.abs(i.ticks); n++) void kvm.mouseScroll(Math.sign(i.ticks))
        break
    }
  }
}

/* ----------------------------------------------------------- pointer events */
/**
 * Where each pointer that went down on the stage is sent, fixed at pointerdown
 * so a gesture never changes path halfway. 'ignore' is a touch that landed off
 * the picture, so a finger can rest in the letterbox without joining gestures.
 */
type Route = 'mouse' | 'fingers' | 'pencil' | 'ignore'
const routes = new Map<number, Route>()

function routeFor(e: PointerEvent): Route {
  const relativePen = e.pointerType === 'pen' && !kvm.config.absoluteMode
  if (e.pointerType !== 'touch' && !relativePen) return 'mouse'
  if (!toAbs(e.clientX, e.clientY, false)) return 'ignore'
  return relativePen ? 'pencil' : 'fingers'
}

/**
 * A pointer with nothing down — mouse or Pencil hover — has no route yet. A
 * hovering Pencil moves the pointer in absolute mode only: as a trackpad it
 * acts on contact.
 */
function hoverRoute(e: PointerEvent): Route {
  if (e.pointerType === 'mouse') return 'mouse'
  return e.pointerType === 'pen' && kvm.config.absoluteMode ? 'mouse' : 'ignore'
}

function recognizer(route: Route) {
  if (route === 'fingers') return fingers
  return route === 'pencil' ? pencil : null
}

function onPointerDown(e: PointerEvent) {
  stageEl.value?.focus({ preventScroll: true })
  jiggler.noteActivity()
  lastPointerType = e.pointerType
  const route = routeFor(e)
  routes.set(e.pointerId, route)

  const g = recognizer(route)
  if (g) {
    const style = route === 'pencil' || !kvm.config.absoluteMode ? 'trackpad' : 'direct'
    runTouch(g.down(e.pointerId, e.clientX, e.clientY, e.timeStamp, style))
  } else if (route === 'mouse') {
    // Keep the release coming here even if it happens over the toolbar or
    // outside the window, so a button is never left held on the target.
    try {
      stageEl.value?.setPointerCapture(e.pointerId)
    } catch {
      // A pointer that is already gone cannot be captured; still send the press.
    }
    onMouseOrPen(e)
  }
}

function onPointerMove(e: PointerEvent) {
  jiggler.noteActivity()
  const route = routes.get(e.pointerId) ?? hoverRoute(e)
  const g = recognizer(route)
  if (g) runTouch(g.move(e.pointerId, e.clientX, e.clientY, e.timeStamp))
  else if (route === 'mouse') onMouseOrPen(e)
}

function onPointerUp(e: PointerEvent) {
  const route = routes.get(e.pointerId) ?? hoverRoute(e)
  routes.delete(e.pointerId)
  const g = recognizer(route)
  if (g) runTouch(g.up(e.pointerId, e.clientX, e.clientY, e.timeStamp))
  else if (route === 'mouse') {
    pointerIgnored &= e.buttons
    syncButtons(e.buttons & ~pointerIgnored)
  }
}

function onPointerCancel(e: PointerEvent) {
  const route = routes.get(e.pointerId) ?? hoverRoute(e)
  routes.delete(e.pointerId)
  const g = recognizer(route)
  if (g) runTouch(g.cancel(e.pointerId))
  else if (route === 'mouse') {
    pointerIgnored = 0
    syncButtons(0)
  }
}

/** Switching apps mid-drag delivers no pointerup; let go rather than stay held. */
function onWindowBlur() {
  routes.clear()
  pointerIgnored = 0
  mouseLast = null
  syncButtons(0)
  runTouch([...fingers.cancelAll(), ...pencil.cancelAll()])
}

async function onWheel(e: WheelEvent) {
  e.preventDefault()
  jiggler.noteActivity()
  await kvm.mouseScroll(e.deltaY > 0 ? settings.scrollSensitivity : -settings.scrollSensitivity)
}

function onStageClick() {
  if (lastPointerType !== 'mouse') return
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
    t.isContentEditable ||
    !!t.closest('button, a, [role="dialog"], [role="alertdialog"]') ||
    (e.key === 'Tab' && t !== stageEl.value)
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

let stopSignalWatch: (() => void) | null = null
let stopDeviceWatch: (() => void) | null = null
let wakeLock: ReturnType<typeof useWakeLock> | null = null
let unmounted = false

onMounted(() => {
  startAutosave()
  stopSignalWatch = capture.watchSignal(() => videoEl.value)
  stopDeviceWatch = capture.watchDevices(() => settings.enableAudio)
  wakeLock = useWakeLock(
    () => ['live', 'paused', 'reconnecting'].includes(capture.status.value),
    capture.note,
  )
  if (!settings.skipConnectPrompt) panels.show('connectPrompt')
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keyup', onKeyup)
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('fullscreenchange', syncFullscreen)
})

onBeforeUnmount(() => {
  unmounted = true
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keyup', onKeyup)
  window.removeEventListener('blur', onWindowBlur)
  document.removeEventListener('fullscreenchange', syncFullscreen)
  stopSignalWatch?.()
  stopDeviceWatch?.()
  wakeLock?.dispose()
  jiggler.dispose()
  capture.stop()
})
</script>

<template>
  <ClientOnly>
    <div class="relative h-dvh w-screen overflow-hidden bg-ink-950">
      <video
        ref="videoEl"
        class="kvm-video"
        autoplay
        playsinline
        muted
        disablepictureinpicture
      ></video>

      <NoSignal
        v-if="showNoSignal"
        :status="capture.status.value"
        :error="capture.lastError.value"
        :busy="startingCapture"
        @start="startCapture"
        @restart="void capture.restart()"
      />

      <!-- Pointer surface, sitting over the picture -->
      <div
        ref="stageEl"
        class="kvm-touch"
        tabindex="-1"
        aria-label="Remote keyboard and pointer surface"
        :class="{ 'no-cursor': !settings.showLocalCursor }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
        @wheel.prevent="onWheel"
        @click="onStageClick"
        @contextmenu.prevent
      ></div>

      <KvmToolbar
        :hidden="toolbarHidden"
        :fullscreen="isFullscreen"
        :capture-busy="startingCapture"
        @toggle-link="toggleLink"
        @start-capture="startCapture"
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

      <ConnectPrompt v-if="panels.open.connectPrompt" :busy="startingCapture" @start="startCapture" />
      <BrowserWarning v-if="!linkSupported" />
    </div>
  </ClientOnly>
</template>
