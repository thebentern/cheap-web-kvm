// SPDX-License-Identifier: GPL-3.0-or-later
import { ref, watch } from 'vue'
import { useKvm } from '~/composables/useKvm'
import { useSettings } from '~/composables/useSettings'

/**
 * Nudges the pointer after a period of inactivity so the target does not sleep.
 * Any real input resets the countdown.
 */
const IDLE_MS = 30_000
const INTERVAL_MS = 5_000
const AMOUNT = 10

export function useJiggler() {
  const kvm = useKvm()
  const { settings } = useSettings()
  const jiggling = ref(false)

  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let jiggleTimer: ReturnType<typeof setInterval> | null = null
  let direction = 1

  function stopJiggle() {
    if (jiggleTimer) clearInterval(jiggleTimer)
    jiggleTimer = null
    jiggling.value = false
  }

  async function jiggleOnce() {
    if (!kvm.link.connected.value) return
    await kvm.mouseMoveRelative(AMOUNT * direction, 0, 0)
    direction *= -1
  }

  function noteActivity() {
    stopJiggle()
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    if (!settings.mouseJiggler) return

    idleTimer = setTimeout(() => {
      jiggling.value = true
      direction = 1
      void jiggleOnce()
      jiggleTimer = setInterval(() => void jiggleOnce(), INTERVAL_MS)
    }, IDLE_MS)
  }

  function dispose() {
    stopJiggle()
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  watch(() => settings.mouseJiggler, noteActivity)

  return { jiggling, noteActivity, dispose }
}
