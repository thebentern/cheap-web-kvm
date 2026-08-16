<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
import { useToasts, type ToastKind } from '~/composables/useToasts'

const { toasts, dismiss } = useToasts()

const ICON: Record<ToastKind, string> = {
  info: 'info',
  success: 'check-circle',
  warning: 'alert-triangle',
  error: 'alert-circle',
}

const TONE: Record<ToastKind, string> = {
  info: 'text-signal-400',
  success: 'text-live-400',
  warning: 'text-warn-400',
  error: 'text-alert-400',
}
</script>

<template>
  <div class="kvm-toasts">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="kvm-toast kvm-toast-in"
        :class="{
          'kvm-toast-success': t.kind === 'success',
          'kvm-toast-warning': t.kind === 'warning',
          'kvm-toast-error': t.kind === 'error',
        }"
        role="status"
        @click="dismiss(t.id)"
      >
        <AppIcon :name="ICON[t.kind]" class="mt-0.5" :class="TONE[t.kind]" />
        <span class="flex-1">{{ t.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}
</style>
