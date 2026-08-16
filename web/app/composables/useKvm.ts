// SPDX-License-Identifier: GPL-3.0-or-later
import { reactive, ref } from 'vue'
import {
  ABS_MAX,
  CMD,
  getInfoFrame,
  jsKeycodeToHid,
  keyboardFrame,
  modifierBit,
  mouseAbsFrame,
  mouseRelFrame,
  resetFrame,
} from '~/utils/ch9329'
import { useSerialLink } from '~/composables/useSerialLink'

/**
 * HID state and the actions that drive it.
 *
 * Mirrors the reference client's HIDController: the full keyboard report is
 * rebuilt and resent on every change, and modifiers pressed as ordinary keys
 * land in the keycode array exactly as before — the firmware folds those into
 * the modifier byte so BIOS sees them (docs/PROTOCOL.md §7).
 */

export const MOUSE_LEFT = 0x01
export const MOUSE_RIGHT = 0x02
export const MOUSE_MIDDLE = 0x04

const hid = reactive({
  mouseButtons: 0,
  mouseX: 0,
  mouseY: 0,
  modifier: 0,
  keys: [0, 0, 0, 0, 0, 0] as number[],
})

const config = reactive({
  absoluteMode: true,
  scrollSensitivity: 2,
  invertScroll: false,
  relativeSensitivity: 1.0,
  ctrlCmdSwap: false,
})

const busy = ref(false)

export function useKvm() {
  const link = useSerialLink()

  function swapCtrlCmd(keyCode: number) {
    if (!config.ctrlCmdSwap) return keyCode
    if (keyCode === 17) return 91
    if (keyCode === 91) return 17
    return keyCode
  }

  async function send(frame: Uint8Array, cmd: number) {
    if (!link.connected.value) return
    busy.value = true
    try {
      return await link.sendAndWait(frame, cmd)
    } finally {
      busy.value = false
    }
  }

  async function softReset() {
    hid.modifier = 0
    hid.keys = [0, 0, 0, 0, 0, 0]
    hid.mouseButtons = 0
    return send(resetFrame(), CMD.RESET)
  }

  async function getInfo() {
    return send(getInfoFrame(), CMD.GET_INFO)
  }

  async function sendKeyboardReport() {
    return send(keyboardFrame(hid.modifier, hid.keys), CMD.KEYBOARD)
  }

  async function mouseMoveAbsolute(x: number, y: number, wheel = 0) {
    hid.mouseX = Math.max(0, Math.min(ABS_MAX, Math.round(x)))
    hid.mouseY = Math.max(0, Math.min(ABS_MAX, Math.round(y)))
    return send(mouseAbsFrame(hid.mouseButtons, hid.mouseX, hid.mouseY, wheel), CMD.MOUSE_ABS)
  }

  async function mouseMoveRelative(dx: number, dy: number, wheel = 0) {
    return send(mouseRelFrame(hid.mouseButtons, dx, dy, wheel), CMD.MOUSE_REL)
  }

  /** Resend the current position/button state in whichever mode is active. */
  async function refreshMouse() {
    return config.absoluteMode
      ? mouseMoveAbsolute(hid.mouseX, hid.mouseY)
      : mouseMoveRelative(0, 0, 0)
  }

  async function mouseButtonPress(button: number) {
    hid.mouseButtons |= button
    return refreshMouse()
  }

  async function mouseButtonRelease(button?: number) {
    hid.mouseButtons = button === undefined ? 0 : hid.mouseButtons & ~button
    return refreshMouse()
  }

  /**
   * Scroll always travels as a relative report, even in absolute mode — which
   * is why the device has to expose both pointer reports at once.
   */
  async function mouseScroll(tilt: number) {
    if (tilt === 0) return
    const t = config.invertScroll ? -tilt : tilt
    const wheel = t < 0 ? config.scrollSensitivity : 0xff - config.scrollSensitivity
    return mouseMoveRelative(0, 0, wheel)
  }

  async function setModifierKey(keycode: number, isRight = false) {
    const bit = modifierBit(swapCtrlCmd(keycode), isRight)
    if (!bit) return
    hid.modifier |= bit
    return sendKeyboardReport()
  }

  async function unsetModifierKey(keycode: number, isRight = false) {
    const bit = modifierBit(swapCtrlCmd(keycode), isRight)
    if (!bit) return
    hid.modifier &= ~bit
    return sendKeyboardReport()
  }

  /** Press a key by its HID usage id. */
  async function pressHid(usage: number) {
    if (!usage) return
    if (hid.keys.includes(usage)) return
    const slot = hid.keys.indexOf(0)
    if (slot === -1) return
    hid.keys[slot] = usage
    return sendKeyboardReport()
  }

  async function releaseHid(usage: number) {
    if (!usage) return
    const slot = hid.keys.indexOf(usage)
    if (slot === -1) return
    hid.keys[slot] = 0
    return sendKeyboardReport()
  }

  async function pressKey(keycode: number) {
    return pressHid(jsKeycodeToHid(swapCtrlCmd(keycode)))
  }

  async function releaseKey(keycode: number) {
    return releaseHid(jsKeycodeToHid(swapCtrlCmd(keycode)))
  }

  async function tapHid(usage: number, holdMs = 0) {
    await pressHid(usage)
    if (holdMs) await new Promise((r) => setTimeout(r, holdMs))
    await releaseHid(usage)
  }

  /** Release everything the target might think is held. */
  async function releaseAll() {
    hid.modifier = 0
    hid.keys = [0, 0, 0, 0, 0, 0]
    await sendKeyboardReport()
    hid.mouseButtons = 0
    await refreshMouse()
  }

  return {
    hid,
    config,
    busy,
    link,
    softReset,
    getInfo,
    sendKeyboardReport,
    mouseMoveAbsolute,
    mouseMoveRelative,
    mouseButtonPress,
    mouseButtonRelease,
    mouseScroll,
    setModifierKey,
    unsetModifierKey,
    pressHid,
    releaseHid,
    pressKey,
    releaseKey,
    tapHid,
    releaseAll,
  }
}
