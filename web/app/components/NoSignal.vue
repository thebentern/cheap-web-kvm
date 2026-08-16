<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
// Placeholder drawn over the (blank) video element when nothing is streaming.
// The page decides when to mount this; the component is purely presentational.
</script>

<template>
  <div class="kvm-nosignal" role="status">
    <div class="flex flex-col items-center gap-3 px-6 text-center">
      <div
        class="flex h-14 w-14 items-center justify-center rounded-2xl border border-ink-600 bg-ink-800 text-2xl text-mist-400"
      >
        <AppIcon name="monitor" />
      </div>
      <p class="text-sm font-medium text-mist-200">No video signal</p>
      <p class="max-w-sm text-xs leading-relaxed text-mist-400">
        The capture card is connected but the target is not sending a picture. Check that the
        target is powered on and that HDMI is seated at both ends.
      </p>
    </div>
  </div>
</template>
