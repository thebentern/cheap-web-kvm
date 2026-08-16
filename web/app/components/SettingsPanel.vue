<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Settings overlay. Ported from the pre-Vue settings.html of cheap-web-kvm,
// itself a re-skin of the settings panel in tobychui/DezKVM-Go (GPLv3).
// Every control writes straight into useSettings(), which persists itself.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useCapture } from '~/composables/useCapture'
import { useKvm } from '~/composables/useKvm'
import { usePanels } from '~/composables/usePanels'
import { useSettings } from '~/composables/useSettings'
import { useToasts } from '~/composables/useToasts'

const capture = useCapture()
const kvm = useKvm()
const panels = usePanels()
const toasts = useToasts()
const { settings, reset } = useSettings()

type TabId = 'display' | 'audio' | 'input' | 'hotkeys' | 'advanced' | 'about'

interface Tab {
  id: TabId
  label: string
  icon: string
}

const TABS: Tab[] = [
  { id: 'display', label: 'Display', icon: 'monitor' },
  { id: 'audio', label: 'Audio', icon: 'volume-up' },
  { id: 'input', label: 'Keyboard & mouse', icon: 'keyboard' },
  { id: 'hotkeys', label: 'Hotkeys', icon: 'bolt' },
  { id: 'advanced', label: 'Advanced', icon: 'wrench' },
  { id: 'about', label: 'About', icon: 'info' },
]

const STACK_KEYS: { value: string; label: string }[] = [
  { value: 'ShiftRight', label: 'Right Shift' },
  { value: 'ShiftLeft', label: 'Left Shift' },
  { value: 'ControlRight', label: 'Right Ctrl' },
  { value: 'AltRight', label: 'Right Alt' },
  { value: 'MetaRight', label: 'Right Meta / Win' },
]

const tab = ref<TabId>('display')
const rootEl = ref<HTMLElement | null>(null)

function close() {
  panels.hide('settings')
}

/* ------------------------------------------------------------------ capture */
interface CaptureRow {
  label: string
  value: string
}

const captureRows = computed<CaptureRow[] | null>(() => {
  const res = capture.resolution.value
  if (!res) return null
  return [
    { label: 'Device', value: capture.deviceName.value ?? 'Unknown' },
    { label: 'Resolution', value: `${res.width} × ${res.height}` },
    { label: 'Frame rate', value: `${res.frameRate} fps` },
    { label: 'Stream', value: capture.active.value ? 'Live' : 'Stopped' },
  ]
})

/* ------------------------------------------------------------------- serial */
// `kvm` is a plain object of refs, so the template cannot auto-unwrap them.
const connected = computed(() => kvm.link.connected.value)
const portLabel = computed(() => kvm.link.portLabel.value)

/* --------------------------------------------------------------- fullscreen */
const isFullscreen = ref(false)

function syncFullscreen() {
  isFullscreen.value = !!document.fullscreenElement
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch {
    toasts.error('The browser refused to change fullscreen state')
  }
}

/* ----------------------------------------------------------------- advanced */
async function resetHid() {
  if (!kvm.link.connected.value) {
    toasts.warn('Not connected — nothing to reset')
    return
  }
  await kvm.softReset()
  toasts.success('HID device reset')
}

async function releaseAll() {
  if (!kvm.link.connected.value) {
    toasts.warn('Not connected — nothing to release')
    return
  }
  await kvm.releaseAll()
  toasts.info('All keys and buttons released')
}

function onPersistChange(e: Event) {
  // useSettings() writes on every change and clears storage when persist is off,
  // so there is nothing to do here beyond telling the user which way it went.
  // Read the control rather than the setting: this handler and v-model's own
  // share the change event, and their order is not ours to rely on.
  const on = (e.target as HTMLInputElement).checked
  if (on) toasts.success('Settings will be kept in this browser')
  else toasts.info('Stored settings cleared from this browser')
}

function resetToDefaults() {
  reset()
  toasts.info('Settings restored to defaults')
}

/* ------------------------------------------------------------------ keyboard */
// The page-level handler in index.vue forwards keystrokes to the target. While
// this overlay is up, swallow anything aimed at it so typing here cannot leak
// through, and take Escape as the close gesture.
function onKeydownCapture(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
    return
  }
  stopIfInside(e)
}

function stopIfInside(e: KeyboardEvent) {
  const target = e.target as Node | null
  if (target && rootEl.value?.contains(target)) e.stopPropagation()
}

onMounted(() => {
  syncFullscreen()
  document.addEventListener('fullscreenchange', syncFullscreen)
  window.addEventListener('keydown', onKeydownCapture, true)
  window.addEventListener('keyup', stopIfInside, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', syncFullscreen)
  window.removeEventListener('keydown', onKeydownCapture, true)
  window.removeEventListener('keyup', stopIfInside, true)
})
</script>

<template>
  <div
    class="kvm-overlay kvm-settings is-visible"
    role="dialog"
    aria-modal="true"
    aria-labelledby="kvm-settings-title"
    @click.self="close"
  >
    <div
      ref="rootEl"
      class="kvm-panel relative flex h-[80vh] max-h-[40rem] w-full max-w-3xl flex-col overflow-hidden"
    >
      <!-- Title bar -->
      <div class="flex flex-none items-center justify-between gap-3 border-b border-ink-600 px-4 py-3">
        <div class="flex items-center gap-2.5">
          <span
            class="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-signal-500/10 text-signal-400"
          >
            <AppIcon name="cog" />
          </span>
          <div>
            <h3 id="kvm-settings-title" class="text-sm font-semibold text-mist-100">Settings</h3>
            <p class="kvm-hint">Applied straight away, remembered in this browser</p>
          </div>
        </div>
        <button type="button" class="kvm-btn kvm-btn-icon flex-none" title="Close settings" @click="close">
          <AppIcon name="x" />
        </button>
      </div>

      <div class="flex min-h-0 flex-1 flex-col sm:flex-row">
        <!-- Tab strip: a wrapping row on narrow screens, a rail on wide ones -->
        <nav
          class="flex flex-none flex-wrap gap-1 border-b border-ink-600 p-2 sm:w-44 sm:flex-col sm:flex-nowrap sm:border-r sm:border-b-0"
          aria-label="Settings sections"
        >
          <button
            v-for="t in TABS"
            :key="t.id"
            type="button"
            class="kvm-tab flex flex-none items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[13px] transition-colors sm:w-full"
            :class="
              tab === t.id
                ? 'is-active'
                : 'border-transparent text-mist-400 hover:bg-ink-800 hover:text-mist-200'
            "
            :aria-current="tab === t.id ? 'true' : undefined"
            @click="tab = t.id"
          >
            <AppIcon :name="t.icon" />
            {{ t.label }}
          </button>
        </nav>

        <!-- Panes -->
        <div class="kvm-scroll min-h-0 flex-1 px-5 py-4">
          <!-- ------------------------------------------------------ Display -->
          <section v-if="tab === 'display'">
            <h4 class="flex items-center gap-2 text-sm font-semibold text-mist-100">
              <AppIcon name="monitor" class="text-signal-400" /> Display
            </h4>
            <p class="kvm-hint mt-1">The capture side of the link, and how its picture is drawn.</p>

            <div class="mt-4 space-y-5">
              <div>
                <div class="kvm-label">Capture properties</div>
                <p class="kvm-hint mt-0.5">Live figures for the video track currently attached.</p>
                <div class="mt-2 max-w-sm overflow-hidden rounded-lg border border-ink-600 bg-ink-900">
                  <table class="w-full border-collapse text-left">
                    <tbody v-if="!captureRows">
                      <tr>
                        <td class="px-3 py-2 text-center text-xs text-mist-400" colspan="2">
                          Waiting for a capture device…
                        </td>
                      </tr>
                    </tbody>
                    <tbody v-else>
                      <tr
                        v-for="(row, i) in captureRows"
                        :key="row.label"
                        :class="i > 0 ? 'border-t border-ink-700' : ''"
                      >
                        <td class="px-3 py-2 text-xs text-mist-400">{{ row.label }}</td>
                        <td class="px-3 py-2 font-mono text-xs text-mist-100">{{ row.value }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <div class="kvm-label">Fullscreen</div>
                <p class="kvm-hint mt-0.5">
                  Drop the browser chrome and give the target the whole screen.
                </p>
                <button type="button" class="kvm-btn mt-2" @click="toggleFullscreen">
                  <AppIcon :name="isFullscreen ? 'compress' : 'expand'" />
                  {{ isFullscreen ? 'Leave fullscreen' : 'Enter fullscreen' }}
                </button>
              </div>

              <div>
                <div class="kvm-label">Image sharpening</div>
                <p class="kvm-hint mt-0.5">
                  Worth turning on when the target is showing a terminal. Costs a little GPU time and
                  nothing in latency.
                </p>
                <label class="kvm-toggle mt-2">
                  <input v-model="settings.imageSharpening" type="checkbox" />
                  <span class="kvm-toggle-track"></span>
                  <span class="kvm-toggle-text">Sharpen the incoming picture</span>
                </label>
              </div>
            </div>
          </section>

          <!-- -------------------------------------------------------- Audio -->
          <section v-else-if="tab === 'audio'">
            <h4 class="flex items-center gap-2 text-sm font-semibold text-mist-100">
              <AppIcon name="volume-up" class="text-signal-400" /> Audio
            </h4>
            <p class="kvm-hint mt-1">Sound arrives on the capture card's own audio endpoint.</p>

            <div class="mt-4 space-y-5">
              <div>
                <div class="kvm-label">Output</div>
                <p class="kvm-hint mt-0.5">
                  Play the target's audio through this machine. Takes effect the next time capture
                  starts.
                </p>
                <label class="kvm-toggle mt-2">
                  <input v-model="settings.enableAudio" type="checkbox" />
                  <span class="kvm-toggle-track"></span>
                  <span class="kvm-toggle-text">Enable audio</span>
                </label>
              </div>

              <div>
                <div class="kvm-label">Extra gain</div>
                <p class="kvm-hint mt-0.5">
                  For capture cards with a quiet — or unpleasantly hot — audio path. 1.00× is
                  untouched; push it far above that and you will clip.
                </p>
                <div class="kvm-range mt-3 max-w-sm">
                  <input
                    v-model.number="settings.extraGain"
                    type="range"
                    min="0.5"
                    max="4"
                    step="0.25"
                    aria-label="Extra audio gain"
                  />
                  <output>{{ settings.extraGain.toFixed(2) }}×</output>
                </div>
              </div>
            </div>
          </section>

          <!-- --------------------------------------------- Keyboard & mouse -->
          <section v-else-if="tab === 'input'">
            <h4 class="flex items-center gap-2 text-sm font-semibold text-mist-100">
              <AppIcon name="keyboard" class="text-signal-400" /> Keyboard &amp; mouse
            </h4>
            <p class="kvm-hint mt-1">
              Input leaves over Web Serial and reaches the target as real USB HID.
            </p>

            <div class="mt-4 space-y-5">
              <div>
                <div class="kvm-label">Relative mouse mode</div>
                <p class="kvm-hint mt-0.5">
                  Sends deltas instead of absolute coordinates, for games and 3D applications that
                  capture the pointer. Absolute is the default and works better through a laggy video
                  feed — the pointer lands where you clicked even if the picture is a few frames
                  behind.
                </p>
                <label class="kvm-toggle mt-2">
                  <input v-model="settings.relativeMouseMode" type="checkbox" />
                  <span class="kvm-toggle-track"></span>
                  <span class="kvm-toggle-text">Use relative mouse mode</span>
                </label>
                <div class="kvm-range mt-3 max-w-sm">
                  <input
                    v-model.number="settings.relativeMouseSensitivity"
                    type="range"
                    min="0.5"
                    max="2"
                    step="0.1"
                    aria-label="Relative mouse sensitivity"
                  />
                  <output>{{ settings.relativeMouseSensitivity.toFixed(1) }}×</output>
                </div>
                <p class="kvm-hint mt-1.5">Movement sensitivity while relative mode is on.</p>
              </div>

              <div>
                <div class="kvm-label">Scroll direction</div>
                <p class="kvm-hint mt-0.5">Flip the wheel if the target scrolls the wrong way.</p>
                <label class="kvm-toggle mt-2">
                  <input v-model="settings.invertScrollwheel" type="checkbox" />
                  <span class="kvm-toggle-track"></span>
                  <span class="kvm-toggle-text">Invert scrollwheel</span>
                </label>
                <div class="kvm-range mt-3 max-w-sm">
                  <input
                    v-model.number="settings.scrollSensitivity"
                    type="range"
                    min="1"
                    max="10"
                    step="1"
                    aria-label="Scroll sensitivity"
                  />
                  <output>{{ settings.scrollSensitivity }} lines</output>
                </div>
                <p class="kvm-hint mt-1.5">How far one notch of the wheel travels on the target.</p>
              </div>

              <div>
                <div class="kvm-label">Local cursor</div>
                <p class="kvm-hint mt-0.5">
                  Keep your own pointer visible over the video. Turn it off when the target draws its
                  own.
                </p>
                <label class="kvm-toggle mt-2">
                  <input v-model="settings.showLocalCursor" type="checkbox" />
                  <span class="kvm-toggle-track"></span>
                  <span class="kvm-toggle-text">Show local cursor</span>
                </label>
              </div>

              <div>
                <div class="kvm-label">Mouse jiggler</div>
                <p class="kvm-hint mt-0.5">
                  Nudges the pointer after a spell of inactivity, so the target never sees an idle
                  session.
                </p>
                <label class="kvm-toggle mt-2">
                  <input v-model="settings.mouseJiggler" type="checkbox" />
                  <span class="kvm-toggle-track"></span>
                  <span class="kvm-toggle-text">Enable mouse jiggler</span>
                </label>
              </div>

              <div>
                <div class="kvm-label">Swap Ctrl and Cmd</div>
                <p class="kvm-hint mt-0.5">
                  For driving a Windows or Linux target from a Mac: what you press as
                  <span class="rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 font-mono text-mist-200">Cmd</span>
                  arrives as
                  <span class="rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 font-mono text-mist-200">Ctrl</span>,
                  and the other way round.
                </p>
                <label class="kvm-toggle mt-2">
                  <input v-model="settings.ctrlCmdSwap" type="checkbox" />
                  <span class="kvm-toggle-track"></span>
                  <span class="kvm-toggle-text">Swap Ctrl ↔ Cmd</span>
                </label>
              </div>
            </div>
          </section>

          <!-- ------------------------------------------------------ Hotkeys -->
          <section v-else-if="tab === 'hotkeys'">
            <h4 class="flex items-center gap-2 text-sm font-semibold text-mist-100">
              <AppIcon name="bolt" class="text-signal-400" /> Hotkeys
            </h4>
            <p class="kvm-hint mt-1">
              For the combinations your own OS swallows before the browser sees them.
            </p>

            <div class="mt-4 space-y-5">
              <div>
                <div class="kvm-label">Stacked keys</div>
                <p class="kvm-hint mt-0.5">
                  Build a combination one key at a time, then send it in one go — the way to reach
                  <span class="rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 font-mono text-mist-200">Ctrl</span>
                  <span class="rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 font-mono text-mist-200">Alt</span>
                  <span class="rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 font-mono text-mist-200">Del</span>
                  without your own machine intercepting it.
                </p>
                <label class="kvm-toggle mt-2">
                  <input v-model="settings.stackKeysEnabled" type="checkbox" />
                  <span class="kvm-toggle-track"></span>
                  <span class="kvm-toggle-text">Enable stacked keys</span>
                </label>
              </div>

              <div>
                <div class="kvm-label">Toggle key</div>
                <p class="kvm-hint mt-0.5">
                  The key that opens and sends a stack. Pick something you never press by accident.
                </p>
                <select
                  v-model="settings.stackKeyToggle"
                  class="kvm-select mt-2 max-w-[16rem]"
                  :disabled="!settings.stackKeysEnabled"
                  aria-label="Stacked keys toggle key"
                >
                  <option v-for="k in STACK_KEYS" :key="k.value" :value="k.value">
                    {{ k.label }}
                  </option>
                </select>
              </div>

              <div>
                <div class="kvm-label">Long press duration</div>
                <p class="kvm-hint mt-0.5">
                  How long to hold the toggle key before stack mode opens. Set it to zero and a short
                  tap does it instead.
                </p>
                <div class="kvm-range mt-3 max-w-sm">
                  <input
                    v-model.number="settings.stackKeyLongPress"
                    type="range"
                    min="0"
                    max="3"
                    step="0.1"
                    :disabled="!settings.stackKeysEnabled"
                    aria-label="Stacked keys long press duration"
                  />
                  <output>
                    {{ settings.stackKeyLongPress === 0 ? 'tap' : settings.stackKeyLongPress.toFixed(1) + ' s' }}
                  </output>
                </div>
              </div>
            </div>
          </section>

          <!-- ----------------------------------------------------- Advanced -->
          <section v-else-if="tab === 'advanced'">
            <h4 class="flex items-center gap-2 text-sm font-semibold text-mist-100">
              <AppIcon name="wrench" class="text-signal-400" /> Advanced
            </h4>
            <p class="kvm-hint mt-1">
              The link itself, and what this browser remembers. Fine as they are, for almost everyone.
            </p>

            <div class="mt-4 space-y-5">
              <div>
                <div class="kvm-label">Serial link</div>
                <p class="kvm-hint mt-0.5">
                  The firmware always comes up at 115200 baud, so there is nothing to choose here.
                </p>
                <div class="mt-2 flex max-w-sm items-center gap-2 rounded-lg border border-ink-600 bg-ink-900 px-3 py-2">
                  <AppIcon name="usb" :class="connected ? 'text-live-400' : 'text-mist-400'" />
                  <span class="text-[13px] text-mist-200">
                    {{ connected ? portLabel || 'Serial port' : 'Not connected' }}
                  </span>
                  <span class="kvm-hint ml-auto font-mono">115200 8N1</span>
                </div>
              </div>

              <div>
                <div class="kvm-label">Reset HID device</div>
                <p class="kvm-hint mt-0.5">
                  Soft-resets the remote keyboard and mouse. Try this first if input stops responding.
                </p>
                <div class="mt-2 flex flex-wrap gap-2">
                  <button type="button" class="kvm-btn" @click="resetHid">
                    <AppIcon name="refresh" class="text-alert-400" /> Reset HID
                  </button>
                  <button type="button" class="kvm-btn" @click="releaseAll">
                    <AppIcon name="unlink" /> Release all keys
                  </button>
                </div>
                <p class="kvm-hint mt-1.5">
                  Releasing lets go of every modifier and mouse button the target still thinks is
                  held down.
                </p>
              </div>

              <div>
                <div class="kvm-label">Remember settings</div>
                <p class="kvm-hint mt-0.5">
                  Keep these preferences in this browser's local storage. Turning it off clears what
                  is already stored.
                </p>
                <label class="kvm-toggle mt-2">
                  <input v-model="settings.persist" type="checkbox" @change="onPersistChange" />
                  <span class="kvm-toggle-track"></span>
                  <span class="kvm-toggle-text">Save settings in this browser</span>
                </label>
              </div>

              <div>
                <div class="kvm-label">Reset to defaults</div>
                <p class="kvm-hint mt-0.5">
                  Puts every setting on this panel back where it started. Does not touch the serial
                  or capture connection.
                </p>
                <button type="button" class="kvm-btn mt-2" @click="resetToDefaults">
                  <AppIcon name="undo" /> Reset to defaults
                </button>
              </div>
            </div>
          </section>

          <!-- -------------------------------------------------------- About -->
          <section v-else>
            <h4 class="flex items-center gap-2 text-sm font-semibold text-mist-100">
              <AppIcon name="info" class="text-signal-400" /> About
            </h4>
            <p class="kvm-hint mt-1">What this is, what it runs on, and the licence it ships under.</p>

            <div class="mt-4 space-y-5">
              <div>
                <div class="text-sm font-semibold text-mist-100">
                  cheap<span class="text-signal-400">-web-</span>kvm
                </div>
                <p class="kvm-hint mt-1">
                  A browser-based USB KVM. Video and audio come in from a UVC capture card;
                  keystrokes and pointer movement go out over Web Serial to a CH9329-compatible HID
                  bridge, which the target sees as an ordinary USB keyboard and mouse. There is no
                  server and nothing to reach on the network — it works on a bench with no internet
                  at all.
                </p>
              </div>

              <!-- Fork attribution. The interface below is tobychui's work; see NOTICE. -->
              <div class="rounded-lg border border-ink-600 bg-ink-900 p-3">
                <div class="flex items-center gap-2 text-[13px] font-semibold text-mist-100">
                  <AppIcon name="github" /> A fork of DezKVM-Go
                </div>
                <p class="kvm-hint mt-1.5">
                  cheap-web-kvm is a fork of
                  <strong class="font-medium text-mist-200">DezKVM-Go</strong>, by tobychui. The
                  entire web interface originates from that project — this settings panel, the paste
                  box, the OCR copy box, the on-screen keyboard, quick access, the screen recorder,
                  stacked keys and the CH9329 byte serialisation. This fork adds the ESP32-S3
                  firmware, MS2130 capture support and the current theme.
                </p>
                <a
                  class="kvm-btn mt-2.5"
                  href="https://github.com/tobychui/DezKVM-Go"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <AppIcon name="github" /> tobychui/DezKVM-Go
                </a>
              </div>

              <div>
                <div class="kvm-label">Supported hardware</div>
                <ul class="mt-2 space-y-2">
                  <li class="flex gap-2.5 rounded-lg border border-ink-600 bg-ink-900 p-3">
                    <AppIcon name="film" class="mt-0.5 flex-none text-signal-400" />
                    <div>
                      <div class="text-[13px] text-mist-100">
                        <strong class="font-semibold">MS2130</strong> HDMI capture — preferred
                      </div>
                      <p class="kvm-hint mt-0.5">
                        1080p60 with audio. <strong class="font-medium text-mist-200">MS2109</strong>
                        also works, at 1080p30 — or 25 fps behind a hub.
                      </p>
                    </div>
                  </li>
                  <li class="flex gap-2.5 rounded-lg border border-ink-600 bg-ink-900 p-3">
                    <AppIcon name="usb" class="mt-0.5 flex-none text-signal-400" />
                    <div>
                      <div class="text-[13px] text-mist-100">
                        <strong class="font-semibold">ESP32-S3</strong> running CH9329-compatible
                        firmware
                      </div>
                      <p class="kvm-hint mt-0.5">
                        Presents a boot-protocol HID keyboard and an absolute mouse to the target,
                        and takes CH9329 frames from this browser over UART at 115200. A genuine
                        <strong class="font-medium text-mist-200">CH9329</strong> module works too.
                      </p>
                    </div>
                  </li>
                </ul>
              </div>

              <!-- GPLv3 section 5(d): Appropriate Legal Notices. -->
              <div class="rounded-lg border border-ink-600 bg-ink-950 p-3">
                <div class="flex items-center gap-2 text-[13px] font-semibold text-mist-100">
                  <AppIcon name="lock" /> Licence
                </div>
                <div class="mt-2 space-y-2 font-mono text-[11px] leading-relaxed text-mist-400">
                  <p>cheap-web-kvm — Copyright (C) 2026 Ben Meadors</p>
                  <p>DezKVM-Go — Copyright (C) tobychui</p>
                  <p>
                    This program is free software: you can redistribute it and/or modify it under
                    the terms of the GNU General Public License as published by the Free Software
                    Foundation, either version 3 of the License, or (at your option) any later
                    version.
                  </p>
                  <p>
                    This program is distributed in the hope that it will be useful, but WITHOUT ANY
                    WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
                    PARTICULAR PURPOSE. See the GNU General Public License for more details.
                  </p>
                </div>
                <div class="mt-3 flex flex-wrap gap-2">
                  <a
                    class="kvm-btn"
                    href="https://github.com/thebentern/cheap-web-kvm"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <AppIcon name="github" /> Source code
                  </a>
                  <a
                    class="kvm-btn"
                    href="https://www.gnu.org/licenses/gpl-3.0.html"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <AppIcon name="folder" /> Full GPLv3 text
                  </a>
                </div>
                <p class="kvm-hint mt-2.5">
                  The complete corresponding source for this interface, including the modifications
                  made to DezKVM-Go, is at the link above. The upstream project's hardware designs
                  are CC BY-NC-ND 4.0 and are not included in this fork.
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Native range inputs and the colour scheme of native form controls: neither is
 * reachable from utility classes. */
.kvm-settings {
  color-scheme: dark;
}

.kvm-range {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.kvm-range input[type='range'] {
  flex: 1 1 auto;
  min-width: 0;
  -webkit-appearance: none;
  appearance: none;
  height: 0.375rem;
  border-radius: 999px;
  background: var(--color-ink-600);
  cursor: pointer;
}
.kvm-range input[type='range']:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.kvm-range input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 0.95rem;
  height: 0.95rem;
  border-radius: 999px;
  border: 2px solid var(--color-ink-900);
  background: var(--color-signal-400);
  cursor: pointer;
}
.kvm-range input[type='range']::-moz-range-thumb {
  width: 0.95rem;
  height: 0.95rem;
  border-radius: 999px;
  border: 2px solid var(--color-ink-900);
  background: var(--color-signal-400);
  cursor: pointer;
}
.kvm-range output {
  flex: none;
  min-width: 4.5rem;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--color-signal-400);
}
</style>
