// SPDX-License-Identifier: GPL-3.0-or-later
import { ref } from 'vue'
import { useKvm } from '~/composables/useKvm'
import { useSettings } from '~/composables/useSettings'

/**
 * Build a key combination one key at a time, then send it as a single report.
 *
 * This exists because the host browser swallows some combinations itself —
 * Ctrl+Alt+Del never reaches a keydown handler — so they have to be assembled
 * rather than captured.
 */

export interface StackedKey {
  keyCode: number
  isRight: boolean
  isModifier: boolean
  label: string
}

const MAX_REGULAR = 6

const active = ref(false)
const keys = ref<StackedKey[]>([])
const triggerProgress = ref(0)

export function useStackedKeys() {
  const kvm = useKvm()
  const { settings } = useSettings()

  let toggleDown = false
  let toggleTimer: ReturnType<typeof setTimeout> | null = null
  let activatedByHold = false
  let forwardedModifier: { keyCode: number; isRight: boolean } | null = null

  const isModifierKey = (key: string) =>
    key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta'

  function label(e: KeyboardEvent): string {
    const right = e.location === 2
    switch (e.key) {
      case 'Control': return right ? 'RCtrl' : 'Ctrl'
      case 'Shift': return right ? 'RShift' : 'Shift'
      case 'Alt': return right ? 'RAlt' : 'Alt'
      case 'Meta': return right ? 'RWin' : 'Win'
      case ' ': return 'Space'
      case 'Delete': return 'Del'
      case 'Escape': return 'Esc'
      case 'ArrowUp': return '↑'
      case 'ArrowDown': return '↓'
      case 'ArrowLeft': return '←'
      case 'ArrowRight': return '→'
    }
    return e.key.length === 1 ? e.key.toUpperCase() : e.key
  }

  function enter() {
    active.value = true
    keys.value = []
  }

  async function send(list: StackedKey[]) {
    const mods = list.filter((k) => k.isModifier)
    const regular = list.filter((k) => !k.isModifier).slice(0, MAX_REGULAR)
    try {
      for (const m of mods) await kvm.setModifierKey(m.keyCode, m.isRight)
      for (const r of regular) await kvm.pressKey(r.keyCode)
      // Brief hold so the target registers the combination.
      await new Promise((r) => setTimeout(r, 50))
      for (const r of regular) await kvm.releaseKey(r.keyCode)
      for (const m of mods) await kvm.unsetModifierKey(m.keyCode, m.isRight)
    } catch {
      await kvm.releaseAll()
    }
  }

  async function exit(dispatch: boolean) {
    const snapshot = keys.value.slice()
    active.value = false
    keys.value = []
    activatedByHold = false
    if (dispatch && snapshot.length) await send(snapshot)
  }

  function add(e: KeyboardEvent) {
    const modifier = isModifierKey(e.key)
    if (!modifier && keys.value.filter((k) => !k.isModifier).length >= MAX_REGULAR) return
    keys.value.push({
      keyCode: e.keyCode,
      isRight: e.location === 2,
      isModifier: modifier,
      label: label(e),
    })
  }

  function undo() {
    keys.value.pop()
  }

  /** Returns true when the event was consumed by this feature. */
  function onKeydown(e: KeyboardEvent): boolean {
    if (!settings.stackKeysEnabled) return false

    if (e.code === settings.stackKeyToggle) {
      e.preventDefault()
      if (toggleDown) return true
      toggleDown = true

      const holdMs = Math.round(settings.stackKeyLongPress * 1000)
      if (!active.value && holdMs > 0) {
        // Keep the toggle key usable as a normal key on a short press; if it is
        // a modifier, forward it live so Right Shift + letter still capitalises.
        if (isModifierKey(e.key)) {
          forwardedModifier = { keyCode: e.keyCode, isRight: e.location === 2 }
          void kvm.setModifierKey(forwardedModifier.keyCode, forwardedModifier.isRight)
        }
        triggerProgress.value = 0
        const started = performance.now()
        const tick = setInterval(() => {
          triggerProgress.value = Math.min(1, (performance.now() - started) / holdMs)
        }, 30)
        toggleTimer = setTimeout(() => {
          clearInterval(tick)
          toggleTimer = null
          triggerProgress.value = 0
          if (forwardedModifier) {
            void kvm.unsetModifierKey(forwardedModifier.keyCode, forwardedModifier.isRight)
            forwardedModifier = null
          }
          enter()
          activatedByHold = true
        }, holdMs)
      }
      return true
    }

    if (active.value) {
      e.preventDefault()
      if (e.repeat) return true
      if (e.key === 'Escape') void exit(false)
      else if (e.key === 'Backspace') undo()
      else add(e)
      return true
    }
    return false
  }

  function onKeyup(e: KeyboardEvent): boolean {
    if (!settings.stackKeysEnabled) return false

    if (e.code === settings.stackKeyToggle) {
      e.preventDefault()
      toggleDown = false
      if (toggleTimer) {
        clearTimeout(toggleTimer)
        toggleTimer = null
      }
      triggerProgress.value = 0

      if (active.value) {
        if (activatedByHold) activatedByHold = false
        else void exit(true)
      } else if (Math.round(settings.stackKeyLongPress * 1000) === 0) {
        enter()
      } else if (forwardedModifier) {
        void kvm.unsetModifierKey(forwardedModifier.keyCode, forwardedModifier.isRight)
        forwardedModifier = null
      } else {
        // Short tap of a non-modifier toggle key: forward it as a normal tap.
        void kvm.pressKey(e.keyCode).then(() => kvm.releaseKey(e.keyCode))
      }
      return true
    }

    if (active.value) {
      e.preventDefault()
      return true
    }
    return false
  }

  return { active, keys, triggerProgress, onKeydown, onKeyup, exit, undo }
}
