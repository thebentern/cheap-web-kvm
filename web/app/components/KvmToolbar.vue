<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
// Console header and grouped tools. Everything here is
// either a panel toggle or an event for the page to act on — the toolbar owns
// no device state of its own.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useCapture } from '~/composables/useCapture'
import { useKvm } from '~/composables/useKvm'
import type { LinkKind } from '~/composables/useLink'
import { usePanels, type PanelName } from '~/composables/usePanels'
import { useSettings } from '~/composables/useSettings'
import { useToasts } from '~/composables/useToasts'

defineProps<{
  /** Slides the toolbar out of the way; the page keeps a "show" button. */
  hidden: boolean
  fullscreen: boolean
  captureBusy: boolean
}>()

const emit = defineEmits<{
  'toggle-link': [kind: LinkKind]
  screenshot: []
  'start-capture': []
  'height-change': [height: number]
  'toggle-fullscreen': []
  hide: []
}>()

const kvm = useKvm()
const capture = useCapture()
const panels = usePanels()
const toasts = useToasts()
const { settings } = useSettings()
const toolsOpen = ref(false)
const toolbarEl = ref<HTMLElement | null>(null)
let sizeObserver: ResizeObserver | undefined

onMounted(() => {
  const el = toolbarEl.value
  if (!el) return
  const measure = () => emit('height-change', el.offsetHeight)
  sizeObserver = new ResizeObserver(measure)
  sizeObserver.observe(el)
  measure()
})
onBeforeUnmount(() => sizeObserver?.disconnect())

const connected = kvm.link.connected
const connecting = kvm.link.connecting
const portLabel = kvm.link.portLabel
const serialSupported = kvm.link.serialSupported
const bleSupported = kvm.link.bleSupported

/** Panels that can only do anything once the HID link is up. */
const needsLink = computed(() => !connected.value)

interface LinkButton {
  kind: LinkKind
  icon: string
  title: string
  live: boolean
  busy: boolean
}

/**
 * One button per transport this browser has. With neither, the serial button
 * stays, disabled, so the toolbar can still say why nothing works.
 */
const linkButtons = computed<LinkButton[]>(() => {
  const out: LinkButton[] = []
  const add = (kind: LinkKind, icon: string, idle: string, busy: string, live: string) => {
    const mine = kvm.link.kind.value === kind
    const isLive = mine && connected.value
    const isBusy = mine && connecting.value
    out.push({ kind, icon, live: isLive, busy: isBusy, title: isBusy ? busy : isLive ? live : idle })
  }
  if (serialSupported.value || !bleSupported.value) {
    add(
      'serial',
      'usb',
      serialSupported.value
        ? 'Connect to the KVM serial port'
        : 'Web Serial is not available in this browser',
      'Opening the serial port…',
      'Disconnect the KVM serial port',
    )
  }
  if (bleSupported.value) {
    add(
      'ble',
      'bluetooth',
      'Connect to the KVM over Bluetooth',
      'Connecting over Bluetooth — enter the passkey if asked',
      'Disconnect Bluetooth',
    )
  }
  return out
})

const videoLabel = computed(() => {
  if (capture.testPattern.value) return 'No HDMI signal'
  switch (capture.status.value) {
    case 'live': return 'Video live'
    case 'paused': return 'Video paused'
    case 'reconnecting': return 'Video reconnecting'
    case 'failed': return 'Video stopped'
    default: return 'Video not started'
  }
})

const videoLive = computed(() => capture.status.value === 'live' && !capture.testPattern.value)
const inputTools: { panel: PanelName; icon: string; label: string; needsLink?: boolean }[] = [
  { panel: 'paste', icon: 'clipboard', label: 'Paste text', needsLink: true },
  { panel: 'copy', icon: 'search', label: 'Copy text' },
  { panel: 'keyboard', icon: 'keyboard', label: 'Keyboard', needsLink: true },
  { panel: 'quickAccess', icon: 'bolt', label: 'Hotkeys', needsLink: true },
]

function toggleCtrlCmdSwap() {
  settings.ctrlCmdSwap = !settings.ctrlCmdSwap
  toasts.info(settings.ctrlCmdSwap ? 'Ctrl ↔ Cmd swap enabled' : 'Ctrl ↔ Cmd swap disabled')
}
</script>

<template>
  <header ref="toolbarEl" class="kvm-toolbar" :class="{ 'is-hidden': hidden }" :inert="hidden || undefined" aria-label="KVM controls">
    <div class="kvm-toolbar-main">
      <NuxtLink to="/" class="kvm-toolbar-brand" aria-label="$KVM console">
        <BrandLogo dark />
      </NuxtLink>

      <div class="kvm-connections">
        <button
          v-for="b in linkButtons"
          :key="b.kind"
          type="button"
          class="kvm-btn"
          :class="{ negative: b.live, 'kvm-btn-primary': !connected && b.kind === (serialSupported ? 'serial' : 'ble') }"
          :disabled="connecting || (b.kind === 'serial' && !serialSupported)"
          :title="b.title"
          :aria-label="b.title"
          @click="emit('toggle-link', b.kind)"
        >
          <AppIcon v-if="b.busy" name="refresh" class="animate-[kvm-spin_0.9s_linear_infinite]" />
          <AppIcon v-else :name="b.live ? 'unlink' : b.icon" />
          {{ b.busy ? 'Connecting…' : b.live ? 'Disconnect' : b.kind === 'ble' ? 'Bluetooth' : 'Connect control' }}
        </button>
        <span class="kvm-status" :class="{ 'is-live': connected }" :title="connected ? portLabel : 'Keyboard and mouse are disconnected'" role="status">
          {{ connecting ? 'Control connecting' : connected ? 'Control linked' : 'Control offline' }}
        </span>
        <div class="kvm-divider" aria-hidden="true" />
        <span
          class="kvm-status"
          :class="{ 'is-live': videoLive, 'is-error': capture.status.value === 'failed', 'is-warning': capture.testPattern.value || capture.status.value === 'paused' || capture.status.value === 'reconnecting' }"
          :title="capture.deviceName.value || undefined"
          role="status"
        >{{ videoLabel }}</span>
        <button v-if="!capture.active.value" type="button" class="kvm-btn" :disabled="captureBusy" @click="emit('start-capture')">
          <AppIcon name="film" /> {{ captureBusy ? 'Starting…' : 'Start video' }}
        </button>
      </div>

      <div class="kvm-toolbar-end">
        <NuxtLink to="/docs" class="kvm-docs-link">Docs</NuxtLink>
        <button type="button" class="kvm-btn kvm-tools-toggle" :aria-expanded="toolsOpen" aria-controls="console-tools" @click="toolsOpen = !toolsOpen">Tools</button>
        <button type="button" class="kvm-btn kvm-btn-icon" :aria-pressed="panels.open.settings" title="Settings" aria-label="Settings" @click="panels.toggle('settings')">
          <AppIcon name="cog" />
        </button>
        <button type="button" class="kvm-btn kvm-btn-icon" title="Hide toolbar" aria-label="Hide toolbar" @click="emit('hide')">
          <AppIcon name="chevron-up" />
        </button>
      </div>
    </div>

    <nav id="console-tools" class="kvm-tools" :class="{ 'is-open': toolsOpen }" aria-label="Console tools" @click="toolsOpen = false">
      <div class="kvm-tool-group">
        <span class="kvm-tool-label">Input</span>
        <button
          v-for="tool in inputTools"
          :key="tool.panel"
          type="button"
          class="kvm-btn"
          :disabled="tool.needsLink && needsLink"
          :aria-pressed="panels.open[tool.panel]"
          @click="panels.toggle(tool.panel)"
        >
          <AppIcon :name="tool.icon" /> {{ tool.label }}
        </button>
      </div>
      <div class="kvm-divider" aria-hidden="true" />
      <div class="kvm-tool-group">
        <span class="kvm-tool-label">View</span>
        <button type="button" class="kvm-btn" :disabled="!capture.active.value" @click="emit('screenshot')">
          <AppIcon name="camera" /> Screenshot
        </button>
        <button type="button" class="kvm-btn" :aria-pressed="panels.open.recorder" @click="panels.toggle('recorder')">
          <AppIcon name="film" /> Record
        </button>
        <button type="button" class="kvm-btn" :aria-pressed="fullscreen" @click="emit('toggle-fullscreen')">
          <AppIcon :name="fullscreen ? 'compress' : 'expand'" /> {{ fullscreen ? 'Exit fullscreen' : 'Fullscreen' }}
        </button>
      </div>
      <div class="kvm-divider" aria-hidden="true" />
      <button type="button" class="kvm-btn" :aria-pressed="settings.ctrlCmdSwap" title="Swap Ctrl and Cmd" @click="toggleCtrlCmdSwap">
        <AppIcon name="exchange" /> Ctrl / Cmd
      </button>
      <NuxtLink to="/docs" class="kvm-btn kvm-tools-docs">Setup guide</NuxtLink>
    </nav>
  </header>
</template>
