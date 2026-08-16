<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Draggable on-screen keyboard. Ported from onscreen-keyboard.{html,js}.
//
// Two behavioural notes against the reference implementation:
//  * Modifiers latch. A latched modifier is applied through the HID modifier
//    byte (setModifierKey) rather than as an ordinary keycode, and it clears
//    itself after the next normal key unless Hold mode is on.
//  * The reference lit both Shift keys when either was latched and always
//    released the *left* bit. Here each key latches and releases its own bit,
//    so a right-Alt latch really does send RALT.
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { CSSProperties } from 'vue'
import { useKvm } from '~/composables/useKvm'
import { usePanels } from '~/composables/usePanels'

const kvm = useKvm()
const panels = usePanels()

/* ------------------------------------------------------------------- layout */

interface KeyDef {
  /** Unique within the layout: keycode plus the side, for left/right pairs. */
  id: string
  label: string
  code: number
  sublabel?: string
  width?: 'wide' | 'xwide' | 'space'
  /** Latches into the HID modifier byte instead of the keycode array. */
  modifier?: boolean
  /** Right-hand member of a modifier pair. */
  right?: boolean
}

type KeyOpts = Omit<KeyDef, 'id' | 'label' | 'code'>

function def(label: string, code: number, opts: KeyOpts = {}): KeyDef {
  return { id: `${code}${opts.right ? 'R' : 'L'}`, label, code, ...opts }
}

/** Letters and digits: the JS keyCode is the uppercase character code. */
function plain(chars: string): KeyDef[] {
  return [...chars].map((ch) => def(ch, ch.charCodeAt(0)))
}

const FUNCTION_KEYS: KeyDef[] = Array.from({ length: 12 }, (_, i) => def(`F${i + 1}`, 112 + i))

const LAYOUT: KeyDef[][] = [
  [def('Esc', 27), ...FUNCTION_KEYS],
  [
    def('`', 192, { sublabel: '~' }),
    def('1', 49, { sublabel: '!' }),
    def('2', 50, { sublabel: '@' }),
    def('3', 51, { sublabel: '#' }),
    def('4', 52, { sublabel: '$' }),
    def('5', 53, { sublabel: '%' }),
    def('6', 54, { sublabel: '^' }),
    def('7', 55, { sublabel: '&' }),
    def('8', 56, { sublabel: '*' }),
    def('9', 57, { sublabel: '(' }),
    def('0', 48, { sublabel: ')' }),
    def('-', 189, { sublabel: '_' }),
    def('=', 187, { sublabel: '+' }),
    def('Backspace', 8, { width: 'xwide' }),
  ],
  [
    def('Tab', 9, { width: 'wide' }),
    ...plain('QWERTYUIOP'),
    def('[', 219, { sublabel: '{' }),
    def(']', 221, { sublabel: '}' }),
    def('\\', 220, { sublabel: '|', width: 'wide' }),
  ],
  [
    def('Caps', 20, { width: 'xwide' }),
    ...plain('ASDFGHJKL'),
    def(';', 186, { sublabel: ':' }),
    def("'", 222, { sublabel: '"' }),
    def('Enter', 13, { width: 'xwide' }),
  ],
  [
    def('Shift', 16, { width: 'xwide', modifier: true }),
    ...plain('ZXCVBNM'),
    def(',', 188, { sublabel: '<' }),
    def('.', 190, { sublabel: '>' }),
    def('/', 191, { sublabel: '?' }),
    def('Shift', 16, { width: 'xwide', modifier: true, right: true }),
  ],
  [
    def('Ctrl', 17, { modifier: true }),
    def('Win', 91, { modifier: true }),
    def('Alt', 18, { modifier: true }),
    def('Space', 32, { width: 'space' }),
    def('Alt', 18, { modifier: true, right: true }),
    def('Ctrl', 17, { modifier: true, right: true }),
    def('←', 37),
    def('↑', 38),
    def('↓', 40),
    def('→', 39),
  ],
]

const WIDTH_CLASS = {
  wide: 'key-wide',
  xwide: 'key-xwide',
  space: 'key-space',
} as const

const BY_ID = new Map<string, KeyDef>(LAYOUT.flat().map((k) => [k.id, k]))

/* -------------------------------------------------------------------- state */

/** Keys physically held down by the pointer right now. */
const pressed = reactive(new Set<string>())
/** Modifier keys latched into the HID modifier byte. */
const latched = reactive(new Set<string>())
const holdMode = ref(false)

async function clearLatched(): Promise<void> {
  for (const id of [...latched]) {
    latched.delete(id)
    const k = BY_ID.get(id)
    if (k) await kvm.unsetModifierKey(k.code, k.right === true)
  }
}

async function toggleModifier(k: KeyDef): Promise<void> {
  if (latched.delete(k.id)) {
    await kvm.unsetModifierKey(k.code, k.right === true)
  } else {
    latched.add(k.id)
    await kvm.setModifierKey(k.code, k.right === true)
  }
}

/**
 * Pointer capture is best-effort: it throws for a pointer id that is no longer
 * active, and a key press must never be swallowed by that. Without capture the
 * ordinary event flow still delivers pointerup to the key.
 */
function setCapture(target: EventTarget | null, pointerId: number, on: boolean): void {
  const el = target as HTMLElement | null
  if (!el) return
  try {
    if (on) el.setPointerCapture(pointerId)
    else el.releasePointerCapture(pointerId)
  } catch {
    // Pointer already gone; nothing to capture or release.
  }
}

async function onKeyPointerDown(e: PointerEvent, k: KeyDef): Promise<void> {
  // Keep focus (and the browser's own click/scroll handling) off the key so the
  // panel never steals input from the video surface.
  e.preventDefault()

  if (k.modifier) {
    setCapture(e.currentTarget, e.pointerId, true)
    await toggleModifier(k)
    return
  }
  if (pressed.has(k.id)) return
  pressed.add(k.id)
  setCapture(e.currentTarget, e.pointerId, true)
  await kvm.pressKey(k.code)
}

async function onKeyPointerUp(e: PointerEvent, k: KeyDef): Promise<void> {
  e.preventDefault()
  if (k.modifier) return
  if (!pressed.delete(k.id)) return
  await kvm.releaseKey(k.code)
  // A latched modifier is a one-shot unless the user pinned it with Hold.
  if (!holdMode.value) await clearLatched()
}

async function toggleHold(): Promise<void> {
  holdMode.value = !holdMode.value
  if (!holdMode.value) await clearLatched()
}

async function releaseEverything(): Promise<void> {
  for (const id of [...pressed]) {
    pressed.delete(id)
    const k = BY_ID.get(id)
    if (k) await kvm.releaseKey(k.code)
  }
  await clearLatched()
}

function close(): void {
  panels.hide('keyboard')
}

/* ---------------------------------------------------------------- placement */

const rootEl = ref<HTMLElement | null>(null)
const pos = reactive({ x: 0, y: 0 })
/**
 * Until the user drags, the panel parks itself along the bottom edge purely
 * with CSS. Measuring at mount would be wrong whenever the stylesheet lands
 * after the component does, so `pos` only takes over once we have a real
 * on-screen rectangle to start from.
 */
const dragged = ref(false)

const panelStyle = computed<CSSProperties>(() =>
  dragged.value
    ? { left: `${pos.x}px`, top: `${pos.y}px` }
    : { left: '50%', bottom: '1.25rem', transform: 'translateX(-50%)' },
)

/** Clamp inside the viewport; a panel larger than the viewport pans instead. */
function clampAxis(v: number, extent: number, available: number): number {
  const max = available - extent
  return max >= 0 ? Math.min(Math.max(v, 0), max) : Math.min(Math.max(v, max), 0)
}

function applyPosition(x: number, y: number): void {
  const el = rootEl.value
  const w = el?.offsetWidth ?? 0
  const h = el?.offsetHeight ?? 0
  pos.x = clampAxis(x, w, window.innerWidth)
  pos.y = clampAxis(y, h, window.innerHeight)
}

let dragPointer: number | null = null
let grabX = 0
let grabY = 0

function onDragStart(e: PointerEvent): void {
  if ((e.target as HTMLElement).closest('button')) return
  const el = rootEl.value
  if (!dragged.value && el) {
    // Hand over from the CSS placement without a visual jump.
    const rect = el.getBoundingClientRect()
    pos.x = rect.left
    pos.y = rect.top
    dragged.value = true
  }
  dragPointer = e.pointerId
  grabX = e.clientX - pos.x
  grabY = e.clientY - pos.y
  setCapture(e.currentTarget, e.pointerId, true)
  e.preventDefault()
}

function onDragMove(e: PointerEvent): void {
  if (dragPointer !== e.pointerId) return
  applyPosition(e.clientX - grabX, e.clientY - grabY)
}

function onDragEnd(e: PointerEvent): void {
  if (dragPointer !== e.pointerId) return
  dragPointer = null
  setCapture(e.currentTarget, e.pointerId, false)
}

function onResize(): void {
  if (dragged.value) applyPosition(pos.x, pos.y)
}

onMounted(() => {
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  // Closing the panel must not leave the target holding a key or a modifier.
  void releaseEverything()
})
</script>

<template>
  <div
    ref="rootEl"
    class="kvm-panel fixed z-[1500] touch-none p-2.5 select-none"
    :style="panelStyle"
  >
    <div
      class="mb-2 flex cursor-grab items-center gap-2 rounded-lg bg-ink-900/70 px-2.5 py-1.5 active:cursor-grabbing"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <AppIcon name="keyboard" class="text-signal-400" />
      <span class="text-xs font-semibold text-mist-100">On-screen keyboard</span>
      <span class="hidden text-[11px] text-mist-400 sm:inline">Drag to move</span>

      <div class="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          class="kvm-btn px-2 py-1 text-[11px]"
          :class="holdMode ? 'border-warn-400 bg-warn-400/15 text-warn-400' : ''"
          :aria-pressed="holdMode"
          :title="
            holdMode ? 'Hold mode: ON — modifiers stay latched until clicked again' : 'Hold mode: OFF'
          "
          @click="toggleHold"
        >
          <AppIcon name="lock" />
          Hold
        </button>
        <button
          type="button"
          class="kvm-btn kvm-btn-icon h-7 w-7 p-1"
          title="Close"
          aria-label="Close on-screen keyboard"
          @click="close"
        >
          <AppIcon name="x" />
        </button>
      </div>
    </div>

    <div class="flex flex-col gap-1">
      <div
        v-for="(row, rowIndex) in LAYOUT"
        :key="rowIndex"
        class="keyboard-row"
        :class="rowIndex === 0 ? 'mb-0.5' : ''"
      >
        <button
          v-for="keyDef in row"
          :key="keyDef.id"
          type="button"
          class="key"
          :class="[
            keyDef.width ? WIDTH_CLASS[keyDef.width] : '',
            pressed.has(keyDef.id) ? 'key-active' : '',
            latched.has(keyDef.id) ? 'key-caps' : '',
          ]"
          :aria-label="keyDef.label"
          :aria-pressed="keyDef.modifier ? latched.has(keyDef.id) : undefined"
          @pointerdown="onKeyPointerDown($event, keyDef)"
          @pointerup="onKeyPointerUp($event, keyDef)"
          @pointercancel="onKeyPointerUp($event, keyDef)"
          @contextmenu.prevent
        >
          <span class="key-label">{{ keyDef.label }}</span>
          <span v-if="keyDef.sublabel" class="key-sublabel">{{ keyDef.sublabel }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
