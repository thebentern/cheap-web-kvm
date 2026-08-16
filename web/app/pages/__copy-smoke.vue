<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
// TEMPORARY harness for CopyPanel - delete after verification.
import { onMounted, ref } from 'vue'
import { usePanels } from '~/composables/usePanels'

const panels = usePanels()
const videoEl = ref<HTMLVideoElement | null>(null)

onMounted(() => {
  const c = document.createElement('canvas')
  c.width = 1280
  c.height = 720
  const ctx = c.getContext('2d')!
  const draw = () => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = '#101010'
    ctx.font = '64px Georgia'
    ctx.fillText('Hello KVM 42', 120, 300)
    ctx.font = '40px Georgia'
    ctx.fillText('second line here', 120, 380)
    requestAnimationFrame(draw)
  }
  draw()
  const stream = (c as HTMLCanvasElement).captureStream(10)
  if (videoEl.value) {
    videoEl.value.srcObject = stream
    void videoEl.value.play()
  }
})
</script>

<template>
  <div class="relative h-screen w-screen overflow-hidden bg-ink-950">
    <video ref="videoEl" class="kvm-video" autoplay playsinline muted></video>
    <button class="kvm-btn fixed left-2 top-2 z-[900]" @click="panels.show('copy')">open copy</button>
    <CopyPanel v-if="panels.open.copy" :video="videoEl" />
    <ToastHost />
  </div>
</template>
