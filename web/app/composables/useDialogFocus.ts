// SPDX-License-Identifier: GPL-3.0-or-later
import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

interface Dialog {
  element: HTMLElement
  previous: HTMLElement | null
}

const dialogs: Dialog[] = []
const ACTIONS = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'

function layer(dialog: Dialog) {
  const overlay = dialog.element.closest('[aria-modal="true"]') ?? dialog.element
  return Number.parseInt(getComputedStyle(overlay).zIndex, 10) || 0
}

function actions(element: HTMLElement) {
  return [...element.querySelectorAll<HTMLElement>(ACTIONS)].filter(
    (el) => el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[inert]')
      && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
  )
}

function focusDialog(dialog: Dialog) {
  const target = actions(dialog.element)[0] ?? dialog.element
  if (target === dialog.element && !target.hasAttribute('tabindex')) target.tabIndex = -1
  target.focus({ preventScroll: true })
}

/** Keep keyboard focus in the topmost open dialog and return it on close. */
export function useDialogFocus(root: Ref<HTMLElement | null>, close?: () => void) {
  let dialog: Dialog | null = null
  let stopWatch: (() => void) | undefined

  function deactivate() {
    if (!dialog) return
    const wasTop = dialogs.at(-1) === dialog
    const previous = dialog.previous
    dialogs.splice(dialogs.indexOf(dialog), 1)
    for (const remaining of dialogs) {
      if (remaining.previous && dialog.element.contains(remaining.previous)) remaining.previous = previous
    }
    dialog = null
    if (!wasTop) return

    const next = dialogs.at(-1)
    if (previous?.isConnected && (!next || next.element.contains(previous))) {
      previous.focus({ preventScroll: true })
    } else if (next) {
      focusDialog(next)
    }
  }

  function sync() {
    if (dialog?.element === root.value) return
    deactivate()
    if (!root.value) return
    dialog = {
      element: root.value,
      previous: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    }
    dialogs.push(dialog)
    // A setup prompt can mount after the browser warning above it. Keep the
    // focus order aligned with the overlays' z-index and DOM painting order.
    dialogs.sort((a, b) => layer(a) - layer(b)
      || (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    if (dialogs.at(-1) === dialog) focusDialog(dialog)
  }

  function onKeydown(e: KeyboardEvent) {
    if (!dialog || dialogs.at(-1) !== dialog) return
    if (e.key === 'Escape' && close) {
      e.preventDefault()
      e.stopImmediatePropagation()
      close()
    } else if (e.key === 'Tab') {
      const items = actions(dialog.element)
      const first = items[0]
      const last = items.at(-1)
      const active = document.activeElement
      if (!first) {
        e.preventDefault()
        focusDialog(dialog)
      } else if (!dialog.element.contains(active) || (e.shiftKey ? active === first : active === last)) {
        e.preventDefault()
        const target = e.shiftKey ? last : first
        target?.focus({ preventScroll: true })
      }
      e.stopImmediatePropagation()
    }
  }

  function stopRemoteInput(e: KeyboardEvent) {
    if (dialog && dialogs.at(-1) === dialog && dialog.element.contains(e.target as Node)) {
      e.stopPropagation()
    }
  }

  onMounted(() => {
    stopWatch = watch(root, sync, { immediate: true, flush: 'post' })
    document.addEventListener('keydown', onKeydown, true)
    document.addEventListener('keydown', stopRemoteInput)
    document.addEventListener('keyup', stopRemoteInput)
  })

  onBeforeUnmount(() => {
    stopWatch?.()
    document.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('keydown', stopRemoteInput)
    document.removeEventListener('keyup', stopRemoteInput)
    deactivate()
  })
}
