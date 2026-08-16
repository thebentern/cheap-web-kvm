<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Quick access hotkeys — a draggable palette of one-shot key bursts.
//
// Ported from quick-access.html / quick-access.js. The reference client pressed
// every keycode (modifiers included) through SendKeyboardPress, which parked the
// 0xE0-family usages in the keycode array. Here modifiers go through the
// modifier byte via setModifierKey, which is what the HID report actually wants;
// the resulting report is identical as far as the target is concerned.
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { usePanels } from '~/composables/usePanels'
import { useKvm } from '~/composables/useKvm'
import { useToasts } from '~/composables/useToasts'

const panels = usePanels()
const kvm = useKvm()
const toasts = useToasts()

/* ------------------------------------------------------------------ hotkeys */

type ModName = 'ctrl' | 'shift' | 'alt' | 'meta'

/** Browser keyCode for each modifier, as `setModifierKey` expects it. */
const MOD_KEYCODE: Record<ModName, number> = {
  ctrl: 17,
  shift: 16,
  alt: 18,
  meta: 91, // Windows / Command / Super all share this keycode.
}

interface Hotkey {
  /** Stable id, used as the v-for key and to mark the button mid-send. */
  id: string
  label: string
  description: string
  icon: string
  /** Applied to the modifier byte, in order. */
  mods: ModName[]
  /** Browser keyCodes pressed as ordinary keys, in order. */
  keys: number[]
}

interface HotkeySection {
  title: string
  items: Hotkey[]
}

/**
 * Deliberately absent: Alt+Tab. The burst releases Alt immediately after Tab, so
 * the window switcher closes before anything can be picked — the reference had
 * it commented out for the same reason.
 */
const SECTIONS: HotkeySection[] = [
  {
    title: 'Windows',
    items: [
      { id: 'ctrl-alt-del', label: 'Ctrl+Alt+Del', description: 'Security screen', icon: 'lock', mods: ['ctrl', 'alt'], keys: [46] },
      { id: 'win-shift-s', label: 'Win+Shift+S', description: 'Snip a region', icon: 'camera', mods: ['meta', 'shift'], keys: [83] },
      { id: 'win-l', label: 'Win+L', description: 'Lock session', icon: 'lock', mods: ['meta'], keys: [76] },
      { id: 'win-d', label: 'Win+D', description: 'Show desktop', icon: 'monitor', mods: ['meta'], keys: [68] },
      { id: 'win-e', label: 'Win+E', description: 'File Explorer', icon: 'folder', mods: ['meta'], keys: [69] },
      { id: 'win-r', label: 'Win+R', description: 'Run dialog', icon: 'terminal', mods: ['meta'], keys: [82] },
      { id: 'ctrl-shift-esc', label: 'Ctrl+Shift+Esc', description: 'Task Manager', icon: 'cog', mods: ['ctrl', 'shift'], keys: [27] },
      { id: 'alt-f4', label: 'Alt+F4', description: 'Close window', icon: 'x', mods: ['alt'], keys: [115] },
    ],
  },
  {
    title: 'macOS',
    items: [
      { id: 'cmd-z', label: '⌘+Z', description: 'Undo', icon: 'undo', mods: ['meta'], keys: [90] },
      { id: 'cmd-x', label: '⌘+X', description: 'Cut', icon: 'crop', mods: ['meta'], keys: [88] },
      { id: 'cmd-c', label: '⌘+C', description: 'Copy', icon: 'clipboard', mods: ['meta'], keys: [67] },
      { id: 'cmd-v', label: '⌘+V', description: 'Paste', icon: 'clipboard', mods: ['meta'], keys: [86] },
      { id: 'cmd-a', label: '⌘+A', description: 'Select all', icon: 'pointer', mods: ['meta'], keys: [65] },
      { id: 'cmd-s', label: '⌘+S', description: 'Save', icon: 'save', mods: ['meta'], keys: [83] },
      { id: 'cmd-f', label: '⌘+F', description: 'Find', icon: 'search', mods: ['meta'], keys: [70] },
      { id: 'cmd-w', label: '⌘+W', description: 'Close window', icon: 'x', mods: ['meta'], keys: [87] },
      { id: 'cmd-q', label: '⌘+Q', description: 'Quit app', icon: 'power', mods: ['meta'], keys: [81] },
      { id: 'cmd-space', label: '⌘+Space', description: 'Spotlight', icon: 'search', mods: ['meta'], keys: [32] },
      { id: 'cmd-tab', label: '⌘+Tab', description: 'Switch apps', icon: 'exchange', mods: ['meta'], keys: [9] },
      { id: 'cmd-option-esc', label: '⌘+⌥+Esc', description: 'Force quit', icon: 'stop', mods: ['meta', 'alt'], keys: [27] },
      { id: 'cmd-h', label: '⌘+H', description: 'Hide window', icon: 'eye', mods: ['meta'], keys: [72] },
      { id: 'cmd-m', label: '⌘+M', description: 'Minimize', icon: 'compress', mods: ['meta'], keys: [77] },
      { id: 'cmd-option-d', label: '⌘+⌥+D', description: 'Toggle Dock', icon: 'monitor', mods: ['meta', 'alt'], keys: [68] },
    ],
  },
  {
    title: 'Linux',
    items: [
      { id: 'ctrl-alt-t', label: 'Ctrl+Alt+T', description: 'Terminal', icon: 'terminal', mods: ['ctrl', 'alt'], keys: [84] },
      { id: 'super-l', label: 'Super+L', description: 'Lock screen', icon: 'lock', mods: ['meta'], keys: [76] },
    ],
  },
  {
    title: 'Editing & navigation',
    items: [
      { id: 'f2', label: 'F2', description: 'Rename', icon: 'wrench', mods: [], keys: [113] },
      { id: 'ctrl-c', label: 'Ctrl+C', description: 'Copy', icon: 'clipboard', mods: ['ctrl'], keys: [67] },
      { id: 'ctrl-v', label: 'Ctrl+V', description: 'Paste', icon: 'clipboard', mods: ['ctrl'], keys: [86] },
      { id: 'ctrl-z', label: 'Ctrl+Z', description: 'Undo', icon: 'undo', mods: ['ctrl'], keys: [90] },
      { id: 'ctrl-y', label: 'Ctrl+Y', description: 'Redo', icon: 'refresh', mods: ['ctrl'], keys: [89] },
      { id: 'ctrl-a', label: 'Ctrl+A', description: 'Select all', icon: 'pointer', mods: ['ctrl'], keys: [65] },
      { id: 'ctrl-f', label: 'Ctrl+F', description: 'Find', icon: 'search', mods: ['ctrl'], keys: [70] },
      { id: 'ctrl-s', label: 'Ctrl+S', description: 'Save', icon: 'save', mods: ['ctrl'], keys: [83] },
      { id: 'ctrl-p', label: 'Ctrl+P', description: 'Print', icon: 'list', mods: ['ctrl'], keys: [80] },
      { id: 'f5', label: 'F5', description: 'Refresh', icon: 'refresh', mods: [], keys: [116] },
      { id: 'ctrl-w', label: 'Ctrl+W', description: 'Close tab', icon: 'x', mods: ['ctrl'], keys: [87] },
    ],
  },
  {
    title: 'Screen capture',
    items: [
      { id: 'printscreen', label: 'PrtScn', description: 'Full screen', icon: 'camera', mods: [], keys: [44] },
      { id: 'alt-printscreen', label: 'Alt+PrtScn', description: 'Active window', icon: 'monitor', mods: ['alt'], keys: [44] },
      { id: 'mac-cmd-shift-3', label: '⌘+Shift+3', description: 'macOS full screen', icon: 'camera', mods: ['meta', 'shift'], keys: [51] },
      { id: 'mac-cmd-shift-4', label: '⌘+Shift+4', description: 'macOS region', icon: 'crop', mods: ['meta', 'shift'], keys: [52] },
    ],
  },
]

/* ------------------------------------------------------------------ sending */

/** How long the combination is held down before it is released. */
const HOLD_MS = 50

const sending = ref(false)
const activeId = ref<string | null>(null)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function sendHotkey(hk: Hotkey) {
  if (sending.value) return
  if (!kvm.link.connected.value) {
    toasts.warn('HID link not connected')
    return
  }

  sending.value = true
  activeId.value = hk.id
  try {
    for (const mod of hk.mods) await kvm.setModifierKey(MOD_KEYCODE[mod])
    for (const key of hk.keys) await kvm.pressKey(key)

    await sleep(HOLD_MS)

    // Release in the reverse of the press order, so the target never sees a
    // key held with its modifier already gone.
    for (const key of [...hk.keys].reverse()) await kvm.releaseKey(key)
    for (const mod of [...hk.mods].reverse()) await kvm.unsetModifierKey(MOD_KEYCODE[mod])

    toasts.success(`Sent ${hk.label}`, 1200)
  } catch (err) {
    // A half-sent burst leaves keys latched on the target; clear the lot.
    await kvm.releaseAll().catch(() => {})
    console.error('Quick access hotkey failed', err)
    toasts.error('Failed to send hotkey')
  } finally {
    sending.value = false
    // Hold the dimmed state briefly so short bursts still register visually.
    setTimeout(() => {
      if (activeId.value === hk.id) activeId.value = null
    }, 180)
  }
}

/* ----------------------------------------------------------------- dragging */

const panelEl = ref<HTMLElement | null>(null)
const pos = reactive({ x: 0, y: 0 })
const ready = ref(false)
const dragging = ref(false)
let grabOffsetX = 0
let grabOffsetY = 0

/** Keep the panel fully inside the viewport. */
function clampToViewport() {
  const el = panelEl.value
  if (!el) return
  const maxX = Math.max(0, window.innerWidth - el.offsetWidth)
  const maxY = Math.max(0, window.innerHeight - el.offsetHeight)
  pos.x = Math.min(Math.max(0, pos.x), maxX)
  pos.y = Math.min(Math.max(0, pos.y), maxY)
}

function onDragStart(e: PointerEvent) {
  // The close button lives in the handle; let it be clicked.
  if ((e.target as HTMLElement | null)?.closest('button')) return
  dragging.value = true
  grabOffsetX = e.clientX - pos.x
  grabOffsetY = e.clientY - pos.y
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
}

function onDragMove(e: PointerEvent) {
  if (!dragging.value) return
  pos.x = e.clientX - grabOffsetX
  pos.y = e.clientY - grabOffsetY
  clampToViewport()
}

function onDragEnd(e: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
}

/* ----------------------------------------------------------------- mounting */

onMounted(async () => {
  await nextTick()
  const el = panelEl.value
  if (el) {
    // Opens bottom-right, as the reference did, with a small margin.
    pos.x = window.innerWidth - el.offsetWidth - 16
    pos.y = window.innerHeight - el.offsetHeight - 16
    clampToViewport()
  }
  ready.value = true
  window.addEventListener('resize', clampToViewport)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', clampToViewport)
})
</script>

<template>
  <!-- Key events raised inside the panel must not reach the page-level keyboard
       forwarder, or focusing a button and pressing Enter would type at the
       target as well as activating the button. -->
  <div
    ref="panelEl"
    class="kvm-panel fixed z-[1500] flex max-h-[80vh] w-[min(40rem,92vw)] flex-col overflow-hidden"
    :style="{ left: `${pos.x}px`, top: `${pos.y}px`, visibility: ready ? 'visible' : 'hidden' }"
    role="dialog"
    aria-label="Quick access hotkeys"
    @keydown.stop
    @keyup.stop
  >
    <!-- Drag handle -->
    <div
      class="flex touch-none select-none items-center justify-between gap-3 border-b border-ink-600 bg-ink-800/60 px-3 py-2"
      :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <div class="flex min-w-0 items-center gap-2">
        <AppIcon name="bolt" class="text-signal-400" />
        <span class="text-[13px] font-semibold text-mist-100">Quick access</span>
        <span class="hidden text-[11px] text-mist-400 sm:inline">drag to move</span>
      </div>
      <button class="kvm-btn kvm-btn-icon" title="Close" aria-label="Close" @click="panels.hide('quickAccess')">
        <AppIcon name="x" />
      </button>
    </div>

    <!-- Hotkeys -->
    <div class="kvm-scroll flex-1 space-y-5 px-3 py-3">
      <section v-for="section in SECTIONS" :key="section.title">
        <div class="mb-2 flex items-center gap-2">
          <h4 class="text-[11px] font-semibold uppercase tracking-[0.12em] text-mist-400">
            {{ section.title }}
          </h4>
          <span class="h-px flex-1 bg-ink-600"></span>
        </div>
        <div class="grid grid-cols-2 gap-1.5 md:grid-cols-3">
          <button
            v-for="hk in section.items"
            :key="hk.id"
            class="hotkey-btn min-w-0 disabled:cursor-not-allowed"
            :class="activeId === hk.id ? 'opacity-60' : ''"
            :disabled="sending"
            :title="`Send ${hk.label}`"
            @click="sendHotkey(hk)"
          >
            <AppIcon :name="hk.icon" class="text-[15px] text-mist-400" />
            <span class="min-w-0">
              <span class="block truncate font-mono text-[11px]">{{ hk.label }}</span>
              <span class="block truncate text-[10px] text-mist-400">{{ hk.description }}</span>
            </span>
          </button>
        </div>
      </section>
    </div>

    <div class="flex items-center gap-2 border-t border-ink-600 px-3 py-2">
      <AppIcon name="usb" class="text-mist-400" />
      <span class="kvm-hint">Each button sends one press-and-release burst over the HID link.</span>
    </div>
  </div>
</template>
