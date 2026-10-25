<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
import { computed } from 'vue'
import { useRuntimeConfig } from '#imports'

const props = defineProps<{ dark?: boolean }>()
const baseURL = useRuntimeConfig().app.baseURL
const src = computed(() => `${baseURL}brand/${props.dark ? 'logo-dark.svg' : 'logo.svg'}`)
</script>

<template>
  <img :src="src" class="brand-logo" width="191" height="64" alt="$KVM" />
</template>
