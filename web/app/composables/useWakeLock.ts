// SPDX-License-Identifier: GPL-3.0-or-later
import { watch } from 'vue'

/**
 * Keep the screen on while `wanted()` is true.
 *
 * A muted video does not count as activity, so an iPad left watching the
 * target auto-locks after a couple of minutes (30 s in Low Power Mode), and
 * locking suspends camera capture. WebKit grants a wake lock only during a tap
 * or key press, until one has been granted in the page, so the request is made
 * from the first pointerdown or keydown while it is wanted; after that it is
 * taken again each time the page returns to the front, as the browser drops it
 * whenever the page is hidden. Where the API is missing this does nothing.
 */
export function useWakeLock(wanted: () => boolean, onEvent?: (what: string) => void) {
  let lock: WakeLockSentinel | null = null
  let requesting = false
  let lastRefusal = ''
  let disposed = false
  /** What the latest sync() decided; a request that resolves after it changed is let go. */
  let desired = false

  /**
   * Take or drop the lock to match `wanted()`, or take it regardless with
   * `force`. The request is made synchronously, so call this from inside a
   * gesture handler when you can.
   */
  function sync(force = false) {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return
    desired = !disposed && (force || wanted())
    if (desired && !document.hidden) {
      if (lock || requesting) return
      requesting = true
      navigator.wakeLock
        .request('screen')
        .then((sentinel) => {
          if (disposed || !desired || document.hidden) {
            void sentinel.release().catch(() => {})
            return
          }
          lock = sentinel
          lastRefusal = ''
          onEvent?.('screen wake lock held')
          sentinel.addEventListener('release', () => {
            if (lock === sentinel) lock = null
            onEvent?.('screen wake lock released')
          })
        })
        .catch((err: Error) => {
          // Refused until a gesture comes along; say so once, not on every tap.
          const why = `${err.name}: ${err.message}`
          if (why !== lastRefusal) onEvent?.(`screen wake lock refused: ${why}`)
          lastRefusal = why
        })
        .finally(() => (requesting = false))
    } else if (lock) {
      void lock.release().catch(() => {})
      lock = null
    }
  }

  const onGesture = () => sync()
  const onVisibility = () => sync()
  const stopWatch = watch(wanted, () => sync(), { immediate: true })
  document.addEventListener('pointerdown', onGesture, true)
  document.addEventListener('keydown', onGesture, true)
  document.addEventListener('visibilitychange', onVisibility)

  function dispose() {
    disposed = true
    desired = false
    stopWatch()
    document.removeEventListener('pointerdown', onGesture, true)
    document.removeEventListener('keydown', onGesture, true)
    document.removeEventListener('visibilitychange', onVisibility)
    void lock?.release().catch(() => {})
    lock = null
  }

  return { sync, dispose }
}
