<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
// First-run prompt: walk the user through plugging the dongle in before we ask
// the browser for camera and microphone permission. Emits `start`; the page
// owns both the capture call and hiding this panel.
import { onMounted, ref } from 'vue'
import { useSettings } from '~/composables/useSettings'
import { usePanels } from '~/composables/usePanels'

const emit = defineEmits<{ start: [] }>()

const { settings } = useSettings()
const panels = usePanels()

/** Drives the `.kvm-modal` fade; raised a frame after mount so it animates. */
const visible = ref(false)
// setTimeout rather than requestAnimationFrame: rAF does not fire while the
// tab is hidden, which would leave the panel invisible until it is focused.
onMounted(() => setTimeout(() => (visible.value = true), 16))

const STEPS: string[] = [
  'Connect the UART port to this computer',
  'Connect the native USB port and HDMI to the target',
  'Grant camera and audio access for the capture card',
]
</script>

<template>
  <div
    class="kvm-modal"
    :class="{ 'is-visible': visible }"
    role="dialog"
    aria-modal="true"
    aria-labelledby="connect-prompt-title"
  >
    <div class="kvm-panel relative w-full max-w-md p-7">
      <button
        class="kvm-btn kvm-btn-icon absolute right-3 top-3"
        title="Dismiss"
        aria-label="Dismiss"
        @click="panels.hide('connectPrompt')"
      >
        <AppIcon name="x" />
      </button>

      <div
        class="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-signal-500/10 text-xl text-signal-400"
      >
        <AppIcon name="usb" />
      </div>

      <h2 id="connect-prompt-title" class="text-lg font-semibold text-mist-100">
        Connect your KVM
      </h2>
      <p class="mt-1.5 text-sm text-mist-400">Plug the dongle in before starting capture.</p>

      <ol class="mt-5 space-y-3">
        <li v-for="(step, i) in STEPS" :key="i" class="flex gap-3">
          <span
            class="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-ink-700 text-[11px] font-semibold text-mist-200"
          >
            {{ i + 1 }}
          </span>
          <span class="text-sm text-mist-200">{{ step }}</span>
        </li>
      </ol>

      <div class="mt-6 flex flex-col gap-3">
        <button class="kvm-btn kvm-btn-primary w-full py-2.5" @click="emit('start')">
          <AppIcon name="film" /> Start capture
        </button>
        <label class="kvm-toggle self-center">
          <input v-model="settings.skipConnectPrompt" type="checkbox" />
          <span class="kvm-toggle-track"></span>
          <span class="kvm-toggle-text">Don't show this again</span>
        </label>
      </div>
    </div>
  </div>
</template>
