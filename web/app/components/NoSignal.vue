<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
// Placeholder drawn over the (blank) video element when nothing is streaming.
// The page decides when to mount this and owns the restart it asks for.
import { computed } from 'vue'
import type { CaptureStatus } from '~/composables/useCapture'

const props = defineProps<{ status?: CaptureStatus; error?: string | null; busy?: boolean }>()
defineEmits<{ restart: []; start: [] }>()

const copy = computed(() => {
  if (!props.status || props.status === 'idle') {
    return {
      icon: 'monitor',
      title: 'Video is not started',
      detail: 'Connect the HDMI capture stick to this computer, then start video. Keyboard and mouse connect separately from the toolbar.',
    }
  }
  if (props.status === 'reconnecting') {
    return {
      icon: 'refresh',
      title: 'Reconnecting to the capture card',
      detail:
        'The video stream stopped and is being retried. If it does not come back, tap Restart video. Settings → Display lists what happened.',
    }
  }
  if (props.status === 'failed') {
    return {
      icon: 'alert-triangle',
      title: 'Video stopped',
      detail: `${props.error ? props.error + '. ' : ''}Tap Restart video to try again. Settings → Display lists what happened.`,
    }
  }
  if (props.status === 'paused') {
    return {
      icon: 'monitor',
      title: 'Video paused by the system',
      detail:
        'iPadOS paused the camera: the screen locked, another app or tab took the camera, or a call or Siri interrupted audio. It usually resumes by itself.',
    }
  }
  return {
    icon: 'monitor',
    title: 'No video signal',
    detail:
      'The capture card is connected but the target is not sending a picture. Check that the target is powered on and that HDMI is seated at both ends.',
  }
})
</script>

<template>
  <div class="kvm-nosignal" role="status">
    <div class="flex flex-col items-center gap-3 px-6 text-center">
      <div class="mb-2 text-3xl text-mist-400">
        <AppIcon
          :name="copy.icon"
          :class="{ 'animate-[kvm-spin_0.9s_linear_infinite]': status === 'reconnecting' }"
        />
      </div>
      <p class="text-2xl font-medium tracking-tight text-mist-100">{{ copy.title }}</p>
      <p class="max-w-sm text-sm leading-relaxed text-mist-400">{{ copy.detail }}</p>
      <button v-if="!status || status === 'idle'" type="button" class="kvm-btn kvm-btn-primary mt-3" :disabled="busy" @click="$emit('start')">
        <AppIcon name="film" /> {{ busy ? 'Starting…' : 'Start video' }}
      </button>
      <!-- The only part of the overlay that takes pointer input (main.css). -->
      <button
        v-if="status === 'paused' || status === 'reconnecting' || status === 'failed'"
        type="button"
        class="kvm-btn mt-1"
        @click="$emit('restart')"
      >
        <AppIcon name="refresh" /> Restart video
      </button>
    </div>
  </div>
</template>
