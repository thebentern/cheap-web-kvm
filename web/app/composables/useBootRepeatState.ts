// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, ref, watch, type Ref } from 'vue'
import { FLAG } from '~/utils/media/protocol'

// Repetition runs on the board, so closing its panel must not lose the Stop
// action. Only the short-lived status watcher belongs to an individual panel.
const armed = ref(false)
const pending = ref<'start' | 'stop' | null>(null)
let expiry: ReturnType<typeof setTimeout> | undefined

function clearExpiry() {
  clearTimeout(expiry)
  expiry = undefined
}

export function useBootRepeatState(
  connected: Ref<boolean>,
  flags: Ref<number>,
) {
  const boardActive = computed(
    () => connected.value && !!(flags.value & FLAG.MACRO),
  )
  const active = computed(() => armed.value || boardActive.value)

  watch(
    boardActive,
    (running) => {
      if (running) {
        armed.value = false
        clearExpiry()
      }
    },
    { immediate: true, flush: 'sync' },
  )

  return {
    active,
    pending,
    begin(cancel: boolean) {
      if (pending.value || (!cancel && active.value)) return false
      pending.value = cancel ? 'stop' : 'start'
      return true
    },
    acknowledge(cancel: boolean, expiresAfterMs: number) {
      clearExpiry()
      armed.value = !cancel && !boardActive.value
      if (cancel) flags.value &= ~FLAG.MACRO
      else if (armed.value)
        expiry = setTimeout(
          () => {
            armed.value = false
            expiry = undefined
          },
          Math.max(0, expiresAfterMs),
        )
    },
    finish() {
      pending.value = null
    },
  }
}
