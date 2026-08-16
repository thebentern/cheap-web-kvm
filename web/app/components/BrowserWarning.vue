<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
// Compatibility gate. Web Serial is Chromium-only, so on Firefox and Safari the
// keyboard and mouse path cannot work at all — say so rather than failing
// silently deeper in. Video capture still works, hence "Proceed anyway".
import { onMounted, ref } from 'vue'

/** Drives the `.kvm-modal` fade; raised a frame after mount so it animates. */
const visible = ref(false)
/** Set once the fade-out has finished, unmounting the overlay for good. */
const dismissed = ref(false)

// setTimeout rather than requestAnimationFrame: rAF does not fire while the
// tab is hidden, which would leave the panel invisible until it is focused.
onMounted(() => setTimeout(() => (visible.value = true), 16))

const BROWSERS: string[] = ['Chrome', 'Edge', 'Opera', 'Brave']

function proceed() {
  visible.value = false
  setTimeout(() => (dismissed.value = true), 260)
}
</script>

<template>
  <div
    v-if="!dismissed"
    class="kvm-modal"
    :class="{ 'is-visible': visible }"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="browser-warning-title"
  >
    <div class="kvm-panel w-full max-w-lg p-7 text-center">
      <div
        class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-warn-400/10 text-2xl text-warn-400"
      >
        <AppIcon name="alert-triangle" />
      </div>

      <h2 id="browser-warning-title" class="text-lg font-semibold text-mist-100">
        Unsupported browser
      </h2>
      <p class="mt-2 text-sm leading-relaxed text-mist-400">
        This app drives the KVM over the
        <strong class="text-mist-200">Web Serial API</strong>, which your browser does not
        implement. Use Chrome, Edge, or another Chromium-based browser.
      </p>

      <div class="mt-4 flex flex-wrap justify-center gap-2">
        <span
          v-for="b in BROWSERS"
          :key="b"
          class="rounded-md border border-ink-600 bg-ink-800 px-2.5 py-1 text-xs text-mist-200"
        >
          {{ b }}
        </span>
      </div>
      <p class="mt-3 text-xs text-mist-400">Firefox and Safari are not supported.</p>

      <button class="kvm-btn mx-auto mt-5" @click="proceed">
        <AppIcon name="alert-triangle" class="text-warn-400" /> Proceed anyway
      </button>
    </div>
  </div>
</template>
