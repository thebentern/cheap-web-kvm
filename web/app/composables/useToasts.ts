// SPDX-License-Identifier: GPL-3.0-or-later
import { ref } from 'vue'

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: number
  message: string
  kind: ToastKind
  /** Lifetime in ms; 0 keeps it until dismissed. */
  life: number
  progress: boolean
}

const toasts = ref<Toast[]>([])
let nextId = 1

export function useToasts() {
  function dismiss(id: number) {
    const i = toasts.value.findIndex((t) => t.id === id)
    if (i !== -1) toasts.value.splice(i, 1)
  }

  function push(message: string, kind: ToastKind = 'info', life = 3000, progress = false) {
    const toast: Toast = { id: nextId++, message, kind, life, progress }
    toasts.value.push(toast)
    // Keep the stack bounded so a chatty failure loop cannot fill the screen.
    while (toasts.value.length > 6) toasts.value.shift()
    if (life > 0) setTimeout(() => dismiss(toast.id), life)
    return toast.id
  }

  return {
    toasts,
    dismiss,
    push,
    info: (m: string, life?: number) => push(m, 'info', life),
    success: (m: string, life?: number) => push(m, 'success', life),
    warn: (m: string, life?: number) => push(m, 'warning', life),
    error: (m: string, life?: number) => push(m, 'error', life),
  }
}
