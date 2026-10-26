<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
// Floating dock and compact tool menu. Everything here is
// either a panel toggle or an event for the page to act on — the toolbar owns
// no device state of its own.
import { computed, nextTick, ref } from 'vue'
import { useCapture } from '~/composables/useCapture'
import { useKvm } from '~/composables/useKvm'
import type { LinkKind } from '~/composables/useLink'
import { usePanels, type PanelName } from '~/composables/usePanels'
import { useSettings } from '~/composables/useSettings'
import { useToasts } from '~/composables/useToasts'

const REPO = 'https://github.com/thebentern/cheap-web-kvm'

const props = defineProps<{
  /** Slides the toolbar out of the way; the page keeps a "show" button. */
  hidden: boolean
  fullscreen: boolean
  captureBusy: boolean
}>()

const emit = defineEmits<{
  'toggle-link': [kind: LinkKind]
  screenshot: []
  'start-capture': []
  'toggle-fullscreen': []
  'show-led-legend': [opener: HTMLElement | null]
  hide: []
}>()

const kvm = useKvm()
const capture = useCapture()
const panels = usePanels()
const toasts = useToasts()
const { settings } = useSettings()
const toolsOpen = ref(false)
const toolsToggle = ref<HTMLButtonElement | null>(null)

function closeTools() {
  toolsOpen.value = false
  toolsToggle.value?.focus()
}

async function showLedLegend(event: MouseEvent) {
  let opener = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  if (toolsOpen.value) {
    // The menu entry disappears on close. Let the dialog remember the visible
    // Tools toggle, so Escape can return focus to a usable control on mobile.
    closeTools()
    await nextTick()
    opener = toolsToggle.value
  }
  emit('show-led-legend', opener)
}

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
  if (kvm.link.wifiAvailable.value) add('wifi', 'wifi', 'Use Wi-Fi for keyboard and mouse', 'Connecting Wi-Fi…', 'Wi-Fi keyboard and mouse active')
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
  { panel: 'media', icon: 'hard-drive', label: 'Virtual media' },
  { panel: 'paste', icon: 'clipboard', label: 'Paste text', needsLink: true },
  { panel: 'copy', icon: 'search', label: 'Copy text' },
  { panel: 'keyboard', icon: 'keyboard', label: 'Keyboard', needsLink: true },
  { panel: 'quickAccess', icon: 'bolt', label: 'Hotkeys', needsLink: true },
]

type ViewAction = 'screenshot' | 'recorder' | 'fullscreen'
const viewTools = computed(() => [
  { action: 'screenshot' as ViewAction, icon: 'camera', label: 'Screenshot', disabled: !capture.active.value, pressed: undefined },
  { action: 'recorder' as ViewAction, icon: 'film', label: 'Screen recorder', disabled: false, pressed: panels.open.recorder },
  { action: 'fullscreen' as ViewAction, icon: props.fullscreen ? 'compress' : 'expand', label: props.fullscreen ? 'Exit fullscreen' : 'Fullscreen', disabled: false, pressed: props.fullscreen },
])

function runView(action: ViewAction) {
  if (action === 'recorder') panels.toggle('recorder')
  else if (action === 'fullscreen') emit('toggle-fullscreen')
  else emit('screenshot')
}

function videoAction() {
  if (capture.active.value) panels.show('settings')
  else emit('start-capture')
}

function toggleCtrlCmdSwap() {
  settings.ctrlCmdSwap = !settings.ctrlCmdSwap
  toasts.info(settings.ctrlCmdSwap ? 'Ctrl ↔ Cmd swap enabled' : 'Ctrl ↔ Cmd swap disabled')
}
</script>

<template>
  <header class="kvm-toolbar" :class="{ 'is-hidden': hidden }" :inert="hidden || undefined" aria-label="KVM controls">
    <div class="kvm-toolbar-main">
      <NuxtLink to="/" class="kvm-toolbar-brand" aria-label="$KVM console">
        <BrandLogo dark />
      </NuxtLink>

      <div class="kvm-divider" aria-hidden="true" />
      <div class="kvm-connections">
        <button
          v-for="b in linkButtons"
          :key="b.kind"
          type="button"
          class="kvm-btn kvm-btn-icon"
          :class="{ negative: b.live, 'kvm-btn-primary': !connected && b.kind === (serialSupported ? 'serial' : 'ble') }"
          :disabled="connecting || (b.kind === 'serial' && !serialSupported)"
          :title="b.title"
          :aria-label="b.title"
          @click="emit('toggle-link', b.kind)"
        >
          <AppIcon v-if="b.busy" name="refresh" class="animate-[kvm-spin_0.9s_linear_infinite]" />
          <AppIcon v-else :name="b.live ? 'unlink' : b.icon" />
        </button>
        <span class="kvm-status kvm-dock-status" :class="{ 'is-live': connected }" :title="connected ? portLabel : 'Keyboard and mouse are disconnected'" role="status">
          {{ connecting ? 'Connecting' : connected ? 'Control linked' : 'Control offline' }}
        </span>
      </div>
      <button
        type="button"
        class="kvm-btn kvm-btn-icon kvm-video-control"
        :class="{ 'is-live': videoLive, 'is-warning': capture.testPattern.value || capture.status.value === 'paused' || capture.status.value === 'reconnecting', 'is-error': capture.status.value === 'failed' }"
        :disabled="captureBusy"
        :title="`${videoLabel} · ${capture.active.value ? 'Display settings' : 'Start video'}`"
        :aria-label="capture.active.value ? 'Video settings' : 'Start video'"
        @click="videoAction"
      >
        <AppIcon :name="captureBusy ? 'refresh' : 'film'" :class="{ 'animate-[kvm-spin_0.9s_linear_infinite]': captureBusy }" />
      </button>
      <span class="kvm-status kvm-dock-status" :class="{ 'is-live': videoLive, 'is-error': capture.status.value === 'failed' }" role="status">{{ videoLabel }}</span>

      <nav class="kvm-dock-tools" aria-label="Console shortcuts">
        <div class="kvm-divider" aria-hidden="true" />
        <button v-for="tool in inputTools" :key="tool.panel" type="button" class="kvm-btn kvm-btn-icon" :disabled="tool.needsLink && needsLink" :aria-pressed="panels.open[tool.panel]" :title="tool.label" :aria-label="tool.label" @click="panels.toggle(tool.panel)">
          <AppIcon :name="tool.icon" />
        </button>
        <div class="kvm-divider" aria-hidden="true" />
        <button v-for="tool in viewTools" :key="tool.action" type="button" class="kvm-btn kvm-btn-icon" :disabled="tool.disabled" :aria-pressed="tool.pressed" :title="tool.label" :aria-label="tool.label" @click="runView(tool.action)">
          <AppIcon :name="tool.icon" />
        </button>
        <div class="kvm-divider" aria-hidden="true" />
        <button type="button" class="kvm-btn kvm-btn-icon" :aria-pressed="settings.ctrlCmdSwap" title="Swap Ctrl and Cmd" aria-label="Swap Ctrl and Cmd" @click="toggleCtrlCmdSwap">
          <AppIcon name="exchange" />
        </button>
        <button type="button" class="kvm-btn kvm-btn-icon" title="Status LED legend" aria-label="Status LED legend" aria-haspopup="dialog" @click="showLedLegend"><AppIcon name="record" /></button>
        <NuxtLink to="/flash" class="kvm-btn kvm-btn-icon" title="Install firmware" aria-label="Install firmware"><AppIcon name="download" /></NuxtLink>
        <NuxtLink to="/docs" class="kvm-btn kvm-btn-icon" title="Documentation" aria-label="Documentation"><AppIcon name="info" /></NuxtLink>
        <a :href="REPO" class="kvm-btn kvm-btn-icon" title="GitHub repository" aria-label="GitHub repository" target="_blank" rel="noopener noreferrer"><AppIcon name="github" /></a>
      </nav>
      <button ref="toolsToggle" type="button" class="kvm-btn kvm-tools-toggle" :aria-expanded="toolsOpen" aria-controls="console-tools" @click="toolsOpen = !toolsOpen" @keydown.esc.stop.prevent="closeTools">Tools</button>
      <button type="button" class="kvm-btn kvm-btn-icon kvm-dock-secondary" :aria-pressed="panels.open.settings" title="Settings" aria-label="Settings" @click="panels.toggle('settings')">
        <AppIcon name="cog" />
      </button>
      <button type="button" class="kvm-btn kvm-btn-icon kvm-dock-secondary" title="Hide toolbar" aria-label="Hide toolbar" @click="emit('hide')">
        <AppIcon name="chevron-up" />
      </button>
    </div>

    <nav v-show="toolsOpen" id="console-tools" class="kvm-tools" aria-label="Console tools" @keydown.esc.stop.prevent="closeTools" @click="closeTools">
      <div class="kvm-menu-status">
        <span class="kvm-status" :class="{ 'is-live': connected }">{{ connected ? 'Control linked' : connecting ? 'Control connecting' : 'Control offline' }}</span>
        <span class="kvm-status" :class="{ 'is-live': videoLive, 'is-error': capture.status.value === 'failed' }">{{ videoLabel }}</span>
      </div>
      <div class="kvm-tool-group">
        <span class="kvm-tool-label">Input</span>
        <button v-for="tool in inputTools" :key="tool.panel" type="button" class="kvm-btn" :disabled="tool.needsLink && needsLink" :aria-pressed="panels.open[tool.panel]" @click="panels.toggle(tool.panel)">
          <AppIcon :name="tool.icon" /> {{ tool.label }}
        </button>
      </div>
      <div class="kvm-tool-group">
        <span class="kvm-tool-label">View</span>
        <button v-for="tool in viewTools" :key="tool.action" type="button" class="kvm-btn" :disabled="tool.disabled" :aria-pressed="tool.pressed" @click="runView(tool.action)">
          <AppIcon :name="tool.icon" /> {{ tool.action === 'recorder' ? 'Record' : tool.label }}
        </button>
      </div>
      <div class="kvm-tool-group">
        <button type="button" class="kvm-btn" :aria-pressed="settings.ctrlCmdSwap" @click="toggleCtrlCmdSwap"><AppIcon name="exchange" /> Ctrl / Cmd</button>
        <button type="button" class="kvm-btn" @click="panels.toggle('settings')"><AppIcon name="cog" /> Settings</button>
        <button type="button" class="kvm-btn" aria-haspopup="dialog" @click.stop="showLedLegend"><AppIcon name="record" /> Status LED legend</button>
        <NuxtLink to="/flash" class="kvm-btn"><AppIcon name="download" /> Install firmware</NuxtLink>
        <NuxtLink to="/docs" class="kvm-btn"><AppIcon name="info" /> Setup guide</NuxtLink>
        <a :href="REPO" class="kvm-btn" target="_blank" rel="noopener noreferrer"><AppIcon name="github" /> GitHub</a>
        <button type="button" class="kvm-btn" @click="emit('hide')"><AppIcon name="chevron-up" /> Hide toolbar</button>
      </div>
    </nav>
  </header>
</template>
