<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
// Floating top toolbar (the reference client's #menu). Everything here is
// either a panel toggle or an event for the page to act on — the toolbar owns
// no device state of its own.
import { computed } from 'vue'
import { useKvm } from '~/composables/useKvm'
import { usePanels, type PanelName } from '~/composables/usePanels'
import { useSettings } from '~/composables/useSettings'
import { useToasts } from '~/composables/useToasts'

defineProps<{
  /** Slides the toolbar out of the way; the page keeps a "show" button. */
  hidden: boolean
  fullscreen: boolean
}>()

const emit = defineEmits<{
  'toggle-serial': []
  screenshot: []
  'toggle-fullscreen': []
  hide: []
}>()

const kvm = useKvm()
const panels = usePanels()
const toasts = useToasts()
const { settings } = useSettings()

const connected = kvm.link.connected
const connecting = kvm.link.connecting
const portLabel = kvm.link.portLabel
const supported = kvm.link.supported

/** Panels that can only do anything once the HID link is up. */
const needsLink = computed(() => !connected.value)

const serialTitle = computed(() => {
  if (!supported.value) return 'Web Serial is not available in this browser'
  if (connecting.value) return 'Opening the serial port…'
  return connected.value ? 'Disconnect the KVM serial port' : 'Connect to the KVM serial port'
})

/** Open panels light their button up so the toolbar reflects what is on screen. */
function panelClass(name: PanelName): string {
  // Utilities sit in a later cascade layer than `.kvm-btn`, so no `!` needed.
  return panels.open[name] ? 'border-signal-600 bg-signal-500/10 text-signal-400' : ''
}

function toggleCtrlCmdSwap() {
  settings.ctrlCmdSwap = !settings.ctrlCmdSwap
  toasts.info(settings.ctrlCmdSwap ? 'Ctrl ↔ Cmd swap enabled' : 'Ctrl ↔ Cmd swap disabled')
}
</script>

<template>
  <!-- `is-hidden` only fades the bar out, so mark it inert to keep the hidden
       buttons out of the tab order too. -->
  <div class="kvm-toolbar" :class="{ 'is-hidden': hidden }" :inert="hidden || undefined">
    <!-- Wordmark -->
    <span class="px-1 text-[13px] font-semibold tracking-tight whitespace-nowrap text-mist-100">
      cheap<span class="text-signal-400">-web-</span>kvm
    </span>

    <div class="kvm-divider" />

    <!-- Serial link -->
    <button
      type="button"
      class="kvm-btn kvm-btn-icon"
      :class="{ negative: connected }"
      :disabled="!supported || connecting"
      :title="serialTitle"
      :aria-label="serialTitle"
      @click="emit('toggle-serial')"
    >
      <AppIcon
        v-if="connecting"
        name="refresh"
        class="animate-[kvm-spin_0.9s_linear_infinite]"
      />
      <AppIcon v-else :name="connected ? 'unlink' : 'keyboard'" />
    </button>
    <span
      class="flex items-center gap-1.5 px-1 font-mono text-[11px] whitespace-nowrap text-mist-400"
      :title="connected ? 'Connected serial port' : 'No serial port open'"
    >
      <span
        class="h-1.5 w-1.5 rounded-full"
        :class="connected ? 'bg-live-400' : 'bg-ink-500'"
        aria-hidden="true"
      />
      {{ portLabel }}
    </span>

    <div class="kvm-divider" />

    <!-- Input helpers -->
    <button
      type="button"
      class="kvm-btn kvm-btn-icon"
      :class="panelClass('paste')"
      :disabled="needsLink"
      :aria-pressed="panels.open.paste"
      title="Paste text to the target"
      @click="panels.toggle('paste')"
    >
      <AppIcon name="clipboard" />
    </button>
    <button
      type="button"
      class="kvm-btn kvm-btn-icon"
      :class="panelClass('copy')"
      :aria-pressed="panels.open.copy"
      title="Copy from the target via OCR"
      @click="panels.toggle('copy')"
    >
      <AppIcon name="search" />
    </button>
    <button
      type="button"
      class="kvm-btn kvm-btn-icon"
      :class="panelClass('quickAccess')"
      :disabled="needsLink"
      :aria-pressed="panels.open.quickAccess"
      title="Hotkeys and macros"
      @click="panels.toggle('quickAccess')"
    >
      <AppIcon name="bolt" />
    </button>
    <button
      type="button"
      class="kvm-btn kvm-btn-icon"
      :class="panelClass('keyboard')"
      :disabled="needsLink"
      :aria-pressed="panels.open.keyboard"
      title="On-screen keyboard"
      @click="panels.toggle('keyboard')"
    >
      <AppIcon name="keyboard" />
    </button>

    <div class="kvm-divider" />

    <!-- Video -->
    <button
      type="button"
      class="kvm-btn kvm-btn-icon"
      title="Screenshot"
      @click="emit('screenshot')"
    >
      <AppIcon name="camera" />
    </button>
    <button
      type="button"
      class="kvm-btn kvm-btn-icon"
      :class="panelClass('recorder')"
      :aria-pressed="panels.open.recorder"
      title="Screen recorder"
      @click="panels.toggle('recorder')"
    >
      <AppIcon name="film" />
    </button>
    <button
      type="button"
      class="kvm-btn kvm-btn-icon"
      :title="fullscreen ? 'Leave fullscreen' : 'Fullscreen'"
      :aria-pressed="fullscreen"
      @click="emit('toggle-fullscreen')"
    >
      <AppIcon :name="fullscreen ? 'compress' : 'expand'" />
    </button>

    <div class="kvm-divider" />

    <!-- Modifier remap -->
    <button
      type="button"
      class="kvm-btn font-mono text-[11px]"
      :class="settings.ctrlCmdSwap ? 'green' : 'grey'"
      :aria-pressed="settings.ctrlCmdSwap"
      :title="settings.ctrlCmdSwap ? 'Ctrl ↔ Cmd swap is on' : 'Swap Ctrl and Cmd'"
      @click="toggleCtrlCmdSwap"
    >
      ⌃ ↔ ⌘
    </button>

    <div class="kvm-divider" />

    <!-- Settings and chrome -->
    <button
      type="button"
      class="kvm-btn"
      :class="panelClass('settings')"
      :aria-pressed="panels.open.settings"
      title="Settings"
      @click="panels.toggle('settings')"
    >
      <AppIcon name="cog" /> Settings
    </button>
    <button
      type="button"
      class="kvm-btn kvm-btn-icon"
      title="Hide toolbar"
      @click="emit('hide')"
    >
      <AppIcon name="chevron-up" />
    </button>
  </div>
</template>
