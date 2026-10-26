<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, onMounted, ref } from 'vue'
import { useSettings } from '~/composables/useSettings'
import { usePanels } from '~/composables/usePanels'
import { useDialogFocus } from '~/composables/useDialogFocus'
import { useDeviceHost } from '~/composables/useDeviceHost'

defineProps<{ busy: boolean }>()
const emit = defineEmits<{ start: [] }>()
const { settings } = useSettings()
const panels = usePanels()
const deviceHost = useDeviceHost()
const firmwareUrl = deviceHost.firmwareUrl
const dialogEl = ref<HTMLElement | null>(null)
const visible = ref(false)
useDialogFocus(dialogEl, () => panels.hide('connectPrompt'))
onMounted(() => setTimeout(() => (visible.value = true), 16))

const steps = computed(() => [
  deviceHost.onboard.value
    ? { title: 'Wi-Fi control', detail: 'Open Virtual media, enter the board’s access token if asked, and connect. Choose “Use Wi-Fi for keyboard & mouse” to control the target.' }
    : { title: 'Control to this computer', detail: 'Connect the board’s UART port to this computer. You can also connect control over Bluetooth from the toolbar.' },
  { title: 'USB and HDMI to the target', detail: 'Connect the board’s native USB port to the target. Run HDMI from the target through the capture stick to this computer.' },
  { title: 'Start the video', detail: 'Allow camera access for the capture stick, plus microphone access if audio is enabled. Then connect control from the toolbar.' },
])
</script>

<template>
  <div ref="dialogEl" class="kvm-modal" :class="{ 'is-visible': visible }" role="dialog" aria-modal="true" aria-labelledby="connect-prompt-title" tabindex="-1">
    <div class="kvm-panel setup-panel relative" data-theme="light">
      <button type="button" class="kvm-btn kvm-btn-icon absolute right-4 top-4" title="Close setup" aria-label="Close setup" @click="panels.hide('connectPrompt')">
        <AppIcon name="x" />
      </button>
      <BrandLogo class="mb-7" />
      <h2 id="connect-prompt-title">Set up your KVM</h2>
      <p class="mt-3 text-sm leading-relaxed text-mist-400">Two connections: one for control, one for video.</p>
      <ol class="setup-steps">
        <li v-for="(step, i) in steps" :key="step.title">
          <span class="setup-step-number">0{{ i + 1 }}</span>
          <div><strong>{{ step.title }}</strong><p>{{ step.detail }}</p></div>
        </li>
      </ol>
      <button type="button" class="kvm-btn kvm-btn-primary mt-6 w-full" :disabled="busy" @click="emit('start')">
        <AppIcon :name="busy ? 'refresh' : 'monitor'" :class="{ 'animate-[kvm-spin_0.9s_linear_infinite]': busy }" />
        {{ busy ? 'Starting video…' : 'Start video' }}
      </button>
      <div class="setup-footer">
        <label class="kvm-toggle">
          <input v-model="settings.skipConnectPrompt" type="checkbox" />
          <span class="kvm-toggle-track"></span>
          <span class="kvm-toggle-text">Skip next time</span>
        </label>
        <NuxtLink to="/docs">Setup guide</NuxtLink>
      </div>
      <p class="mt-5 text-sm text-mist-400">Blank board? <NuxtLink :to="firmwareUrl" class="text-signal-400 underline underline-offset-4">Install the firmware</NuxtLink> first.</p>
    </div>
  </div>
</template>
