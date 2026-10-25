<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
import { ref } from 'vue'
import { useDialogFocus } from '~/composables/useDialogFocus'
import { usePanels } from '~/composables/usePanels'

const props = defineProps<{ returnFocus: HTMLElement | null }>()
const panels = usePanels()
const rootEl = ref<HTMLElement | null>(null)
const close = () => panels.hide('ledLegend')
useDialogFocus(rootEl, close, { returnFocus: () => props.returnFocus, restoreAfterUpdate: true })

const legend = [
  { state: 'Starting', color: 'White', swatch: 'white', pattern: 'One 700 ms fade.' },
  { state: 'Waiting for USB target', color: 'Amber', swatch: 'amber', pattern: 'Slow breath every 3 seconds. Check the native USB cable and target power.' },
  { state: 'Target ready', color: 'Green', swatch: 'green', pattern: 'Dim, steady light. The target has enumerated the keyboard and mouse.' },
  { state: 'Bluetooth pairing', color: 'Blue', swatch: 'blue', pattern: 'Two short pulses every 2.4 seconds. Enter the Bluetooth PIN on the connecting device.' },
  { state: 'Input forwarded', color: 'Green', swatch: 'green', pattern: 'An 80 ms brightness lift when a keyboard or mouse report is submitted to USB. Continuous activity merges into a steady brighter light.' },
  { state: 'Input dropped', color: 'Red', swatch: 'red', pattern: 'One 180 ms flash when input cannot be queued or sent, then the previous status returns.' },
]
</script>

<template>
  <div ref="rootEl" class="kvm-modal is-visible led-legend-modal" role="dialog" aria-modal="true" aria-labelledby="led-legend-title" aria-describedby="led-legend-description" tabindex="-1" @click.self="close">
    <section class="kvm-panel led-legend-panel">
      <header class="led-legend-header">
        <div>
          <h2 id="led-legend-title">Status LED legend</h2>
          <p id="led-legend-description">The ESP32’s onboard NeoPixel uses the Quiet status scheme.</p>
        </div>
        <button type="button" class="kvm-btn kvm-btn-icon" title="Close status LED legend" aria-label="Close status LED legend" @click="close"><AppIcon name="x" /></button>
      </header>
      <dl class="led-legend-list">
        <div v-for="entry in legend" :key="entry.state" class="led-legend-entry">
          <dt><span class="led-legend-swatch" :class="`led-legend-${entry.swatch}`" aria-hidden="true" />{{ entry.state }}</dt>
          <dd><strong>{{ entry.color }}</strong> · {{ entry.pattern }}</dd>
        </div>
      </dl>
      <div class="led-legend-notes">
        <p>After Bluetooth pairing succeeds, fails, or disconnects, the light returns to the USB target status. Blue pulses take priority over that status; a red warning briefly overrides both.</p>
        <p>The light reports USB keyboard, mouse, and pairing activity. Video comes through a separate capture stick; check the app’s video indicator for HDMI status.</p>
      </div>
      <button type="button" class="kvm-btn led-legend-close" @click="close">Close legend</button>
    </section>
  </div>
</template>

<style scoped>
.led-legend-modal { z-index: 2800; }
.led-legend-panel { width: min(100%, 560px); max-height: calc(100dvh - 48px); overflow-y: auto; padding: 28px; color: var(--color-mist-100); }
.led-legend-header { display: flex; align-items: flex-start; gap: 16px; justify-content: space-between; }
.led-legend-header h2 { font-size: 22px; line-height: 1.25; font-weight: 600; letter-spacing: -0.025em; }
.led-legend-header p { margin-top: 8px; color: var(--color-mist-400); font-size: 13px; line-height: 1.6; }
.led-legend-list { margin-top: 20px; border-top: 1px solid var(--color-ink-600); }
.led-legend-entry { padding: 13px 0; border-bottom: 1px solid var(--color-ink-600); }
.led-legend-entry dt { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 600; }
.led-legend-entry dd { margin-top: 5px; padding-left: 22px; color: var(--color-mist-400); font-size: 13px; line-height: 1.6; }
.led-legend-entry dd strong { color: var(--color-mist-100); font-weight: 500; }
.led-legend-swatch { width: 12px; height: 12px; flex: none; border-radius: 50%; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.18); }
.led-legend-white { background: #f5f5f4; }
.led-legend-amber { background: #e9a52c; }
.led-legend-green { background: #38cf7b; }
.led-legend-blue { background: #3b82f6; }
.led-legend-red { background: #ee5655; }
.led-legend-notes { margin-top: 18px; font-size: 12px; line-height: 1.7; color: var(--color-mist-400); }
.led-legend-notes p + p { margin-top: 8px; }
.led-legend-close { margin-top: 20px; }
@media (max-width: 600px) {
  .led-legend-panel { max-height: calc(100dvh - 32px); padding: 20px; }
  .led-legend-header h2 { font-size: 20px; }
}
</style>
