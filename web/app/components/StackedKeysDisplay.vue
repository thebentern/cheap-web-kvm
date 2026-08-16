<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
// Read-only view of the stacked-keys composable: the chip list while a
// combination is being assembled, and the long-press progress bar that shows
// the toggle key is being held. Both live at the bottom centre and are mutually
// exclusive in practice — the hold completes, then stack mode opens.
import { computed } from 'vue'
import { useStackedKeys } from '~/composables/useStackedKeys'

const { active, keys, triggerProgress } = useStackedKeys()

/** `.kvm-stack-trigger .fill` is a bare width, so hand it a percentage. */
const fillWidth = computed(() => `${Math.min(1, Math.max(0, triggerProgress.value)) * 100}%`)
</script>

<template>
  <!-- `flex` / `block` override the `display: none` these classes ship with. -->
  <div v-if="active" class="kvm-stacked kvm-panel flex" role="status" aria-live="polite">
    <div class="stacked-keys-title"><span class="dot"></span> Stacked Keys</div>

    <div class="stacked-keys-chips">
      <template v-if="keys.length">
        <span v-for="(k, i) in keys" :key="i" class="stacked-key-chip">{{ k.label }}</span>
      </template>
      <span v-else class="stacked-keys-empty">Press keys to stack…</span>
    </div>

    <div class="stacked-keys-hint">Toggle key: send · Backspace: undo · Esc: cancel</div>
  </div>

  <div v-if="triggerProgress > 0" class="kvm-stack-trigger block" aria-hidden="true">
    <span class="fill" :style="{ width: fillWidth }"></span>
  </div>
</template>
