<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useHead } from '#imports'
import { useFirmwareFlasher } from '~/composables/useFirmwareFlasher'

const REPO = 'https://github.com/thebentern/cheap-web-kvm'
const {
  supported, status, busy, progress, logs, error, version, chipName,
  loadFirmware, install, dispose,
} = useFirmwareFlasher()
const clientReady = ref(false)

const statusLabel = computed(() => {
  switch (status.value) {
    case 'loading': return 'Loading packaged firmware…'
    case 'ready': return 'Ready to install'
    case 'connecting': return 'Connecting to your board…'
    case 'installing': return 'Installing firmware…'
    case 'success': return 'Firmware installed'
    case 'error': return 'Installation could not finish'
    case 'unavailable': return 'Firmware installation unavailable'
  }
})
const installEnabled = computed(() => clientReady.value && supported.value && !busy.value
  && version.value !== null && status.value !== 'loading' && status.value !== 'unavailable')
const retryLoad = computed(() => clientReady.value && supported.value && !busy.value
  && (status.value === 'error' || status.value === 'unavailable') && version.value === null)

function beforeUnload(event: BeforeUnloadEvent) {
  if (!busy.value) return
  event.preventDefault()
  event.returnValue = ''
}

// Keep a running installation on this page, including when Back is pressed.
// Reloading/closing the tab is covered by the browser's own beforeunload prompt.
onBeforeRouteLeave(() => !busy.value)
onMounted(() => {
  clientReady.value = true
  window.addEventListener('beforeunload', beforeUnload)
  void loadFirmware()
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload)
  void dispose()
})

useHead({
  title: '$KVM — Install firmware',
  htmlAttrs: { 'data-theme': 'light' },
  meta: [
    { name: 'color-scheme', content: 'light' },
    { name: 'theme-color', content: '#f7f1e8' },
    { name: 'description', content: 'Install the packaged $KVM firmware on an ESP32-S3-DevKitC-1-N8R8 from Chrome or Edge.' },
  ],
  bodyAttrs: { style: 'overflow: auto; height: auto; min-height: 100%' },
})
</script>

<template>
  <div class="site-page flash-page" data-theme="light">
    <header class="site-header" :class="{ 'flash-nav-busy': busy }" :inert="busy || undefined">
      <NuxtLink to="/" aria-label="$KVM console" class="flash-brand"><BrandLogo /></NuxtLink>
      <nav class="site-nav" aria-label="Main navigation">
        <NuxtLink to="/">Console</NuxtLink>
        <NuxtLink to="/docs">Docs</NuxtLink>
        <a :href="REPO" target="_blank" rel="noopener noreferrer">GitHub</a>
      </nav>
    </header>

    <main class="site-content flash-content">
      <header class="flash-intro">
        <p class="flash-eyebrow">Firmware</p>
        <h1>Set up the board.</h1>
        <p class="flash-lead">Install $KVM directly from your browser.</p>
        <p>Use desktop Chrome or Edge over HTTPS or localhost. Connect the board’s UART USB port with a data cable, then select it when the browser asks.</p>
      </header>

      <ol class="flash-steps" aria-label="Before installation">
        <li>
          <span class="flash-step-number" aria-hidden="true">01</span>
          <div><h2>Check your board</h2><p>This firmware is for the <strong>ESP32-S3-DevKitC-1-N8R8</strong> with <strong>8 MB flash</strong>. Its onboard NeoPixel is on GPIO48. Check the board label before continuing.</p></div>
        </li>
        <li>
          <span class="flash-step-number" aria-hidden="true">02</span>
          <div><h2>Connect the UART port</h2><p>Use the USB-to-serial bridge port, rather than the native USB port used by the target. Close other KVM tabs and serial monitors so the port is available.</p></div>
        </li>
        <li>
          <span class="flash-step-number" aria-hidden="true">03</span>
          <div><h2>Choose the board and install</h2><p>Press Install firmware and choose the board’s UART bridge in the serial port picker. The board restarts during installation; keep the cable connected until it finishes.</p></div>
        </li>
      </ol>

      <section class="kvm-panel flash-install" aria-labelledby="flash-install-title" :aria-busy="busy">
        <div class="flash-install-heading">
          <h2 id="flash-install-title">Packaged $KVM firmware</h2>
          <span v-if="version" class="flash-version">{{ version }}</span>
        </div>
        <p class="flash-preserve">Existing Bluetooth PIN and pairings are preserved.</p>

        <div v-if="clientReady && !supported" class="flash-message flash-warning" role="status">
          <AppIcon name="info" />
          <p>Browser installation needs Web Serial in desktop Chrome or Edge, over HTTPS or localhost. Safari, Firefox, and iPad browsers cannot flash this board. You can still use the ESP-IDF instructions in the <a :href="`${REPO}#firmware`" target="_blank" rel="noopener noreferrer">README</a>.</p>
        </div>

        <template v-else>
          <p class="flash-state" :class="{ 'flash-success': status === 'success' }" role="status" aria-live="polite">
            <AppIcon v-if="status === 'success'" name="check-circle" />
            {{ statusLabel }}
          </p>
          <p v-if="chipName" class="flash-detected">Detected board: {{ chipName }}</p>
          <div v-if="busy || status === 'success'" class="flash-progress">
            <div class="flash-progress-label"><span>{{ status === 'connecting' ? 'Connecting' : 'Installation progress' }}</span><span>{{ Math.round(progress) }}%</span></div>
            <progress :value="progress" max="100" aria-label="Firmware installation progress">{{ Math.round(progress) }}%</progress>
          </div>
          <p v-if="busy" class="flash-stay">Keep this page open and the board connected. Navigation is paused while installation runs.</p>
          <div v-if="error" class="flash-message flash-error" role="alert"><AppIcon name="alert-circle" /><p>{{ error }}</p></div>
          <p v-if="status === 'success'" class="flash-complete">Return to the console and reconnect Serial or Bluetooth to start using your KVM.</p>

          <div class="flash-actions">
            <button v-if="status !== 'success'" type="button" class="kvm-btn kvm-btn-primary" :disabled="!installEnabled" @click="install">
              <AppIcon :name="busy ? 'refresh' : 'cpu'" :class="{ 'animate-[kvm-spin_0.9s_linear_infinite]': busy }" />
              {{ busy ? 'Installation in progress…' : status === 'error' && version ? 'Retry installation' : 'Install firmware' }}
            </button>
            <button v-if="retryLoad" type="button" class="kvm-btn" @click="loadFirmware">Retry loading firmware</button>
            <NuxtLink v-if="status === 'success'" to="/" class="kvm-btn kvm-btn-primary"><AppIcon name="monitor" /> Open console</NuxtLink>
          </div>
        </template>

        <details v-if="logs.length" class="flash-log" :open="busy || status === 'error'">
          <summary>Installation log</summary>
          <pre tabindex="0" aria-label="Installation log">{{ logs.join('\n') }}</pre>
        </details>
      </section>

      <section class="flash-help" aria-labelledby="flash-help-title">
        <h2 id="flash-help-title">If the board won’t connect</h2>
        <p>First check the UART port, data cable, and whether another tab or app is using the port. If automatic bootloader entry fails, put the board in download mode:</p>
        <ol>
          <li>Hold the <strong>BOOT</strong> button.</li>
          <li>Press and release <strong>RESET / EN</strong> while holding BOOT.</li>
          <li>Release BOOT, then retry installation.</li>
        </ol>
        <p>After a successful installation, press RESET / EN if the board does not restart on its own. A missing port can also mean the UART bridge needs its driver; see the board vendor’s instructions.</p>
        <p><a :href="`${REPO}#firmware`" target="_blank" rel="noopener noreferrer" :aria-disabled="busy || undefined" :inert="busy || undefined">Manual build and flash instructions <span aria-hidden="true">↗</span></a></p>
      </section>
    </main>

    <footer class="site-footer" :inert="busy || undefined">
      <span>$KVM <span class="flash-footer-project">/ cheap-web-kvm</span></span>
      <NuxtLink to="/">Open console <span aria-hidden="true">→</span></NuxtLink>
    </footer>
  </div>
</template>

<style scoped>
.flash-brand { display: inline-flex; flex: none; align-items: center; }
.flash-content { padding-block: 64px 72px; }
.flash-intro { margin-bottom: 36px; }
.flash-eyebrow { margin: 0 0 16px; color: var(--color-mist-400); font-size: 13px; font-weight: 600; }
.flash-intro h1 { margin: 0; font-size: 36px; line-height: 1.2; font-weight: 650; letter-spacing: -0.035em; }
.flash-intro .flash-lead { margin-top: 20px; font-size: 19px; line-height: 1.5; }
.flash-intro p:last-child, .flash-help p { margin-top: 16px; font-size: 15px; line-height: 1.7; }
.flash-steps { margin: 0 0 36px; border-top: 1px solid var(--color-ink-600); list-style: none; padding: 0; }
.flash-steps li { display: flex; gap: 20px; padding: 20px 0; border-bottom: 1px solid var(--color-ink-600); }
.flash-step-number { flex: none; color: var(--color-signal-400); font: 13px/24px var(--font-mono); }
.flash-steps h2, .flash-install h2 { font-size: 16px; font-weight: 600; line-height: 1.5; }
.flash-steps p { margin-top: 5px; font-size: 14px; line-height: 1.7; color: var(--color-mist-400); }
.flash-steps strong { color: var(--color-mist-100); font-weight: 500; }
.flash-install { padding: 28px; }
.flash-install-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.flash-version { max-width: 100%; overflow-wrap: anywhere; color: var(--color-mist-400); font: 12px/1.5 var(--font-mono); }
.flash-preserve { margin-top: 5px; color: var(--color-mist-400); font-size: 13px; line-height: 1.7; }
.flash-state { display: flex; align-items: center; gap: 8px; margin-top: 24px; font-size: 15px; font-weight: 500; }
.flash-success { color: var(--color-live-400); }
.flash-detected { margin-top: 6px; color: var(--color-mist-400); font-size: 13px; }
.flash-progress { margin-top: 20px; }
.flash-progress-label { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; color: var(--color-mist-400); font-variant-numeric: tabular-nums; }
.flash-progress progress { display: block; width: 100%; height: 8px; margin-top: 8px; overflow: hidden; appearance: none; border: none; border-radius: 4px; background: var(--color-ink-700); accent-color: var(--primary); }
.flash-progress progress::-webkit-progress-bar { background: var(--color-ink-700); }
.flash-progress progress::-webkit-progress-value { background: var(--primary); }
.flash-progress progress::-moz-progress-bar { background: var(--primary); }
.flash-stay, .flash-complete { margin-top: 14px; font-size: 13px; line-height: 1.7; color: var(--color-mist-400); }
.flash-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 22px; }
.flash-message { display: flex; align-items: flex-start; gap: 10px; margin-top: 22px; font-size: 13px; line-height: 1.7; }
.flash-message > svg { margin-top: 3px; }
.flash-warning { color: var(--color-warn-400); }
.flash-error { color: var(--color-alert-400); }
.flash-message a, .flash-help a { color: var(--color-signal-400); text-decoration: underline; text-underline-offset: 3px; }
.flash-log { margin-top: 24px; border-top: 1px solid var(--color-ink-600); padding-top: 16px; }
.flash-log summary { width: fit-content; font-size: 13px; color: var(--color-mist-200); cursor: pointer; }
.flash-log pre { max-height: 240px; margin-top: 12px; overflow: auto; padding: 14px; background: var(--color-ink-800); border-radius: 6px; color: var(--color-mist-200); font: 12px/1.7 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.flash-help { margin-top: 40px; }
.flash-help h2 { font-size: 20px; font-weight: 600; letter-spacing: -0.025em; }
.flash-help ol { margin-top: 16px; padding-left: 22px; font-size: 14px; line-height: 1.8; }
.flash-nav-busy { opacity: 0.6; }
.flash-footer-project { color: var(--color-mist-400); }
@media (max-width: 600px) {
  .flash-page .site-header { flex-wrap: wrap; gap: 12px; }
  .flash-page .site-nav { gap: 16px; }
  .flash-content { width: calc(100% - 40px); padding-block: 40px 48px; }
  .flash-intro h1 { font-size: 32px; }
  .flash-install { padding: 20px; }
  .flash-steps li { gap: 14px; }
  .flash-page .site-footer { flex-wrap: wrap; }
}
</style>
