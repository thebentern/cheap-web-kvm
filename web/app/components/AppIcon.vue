<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
// Inline SVG icons. Vendored rather than pulled from an icon CDN so the tool
// works with no network.
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{ name: string; size?: number | string; stroke?: number }>(),
  { size: '1em', stroke: 1.9 },
)

/** Stroked paths, drawn on a 24×24 grid. */
const STROKED: Record<string, string> = {
  'scan-text': '<path d="M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4M7 8h10M7 12h10M7 16h6"/>',
  video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4Z"/>',
  led: '<path d="M8 13V9a4 4 0 0 1 8 0v4ZM7 13h10M10 13v8M14 13v8M12 1v2M3 6l2 1M21 6l-2 1"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M8 2v4M16 2v4M8 18v4M16 18v4M2 8h4M2 16h4M18 8h4M18 16h4"/>',
  'book-open': '<path d="M12 6c-2-2-6-3-10-2v15c4-1 8 0 10 2 2-2 6-3 10-2V4c-4-1-8 0-10 2ZM12 6v15"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8.1 8.1 12.4 12.4M14 10l6.5-6.5M8.1 15.9 12 12"/>',
  pencil: '<path d="m16 3 5 5-12 12-6 1 1-6ZM14 5l5 5"/>',
  printer: '<path d="M7 8V3h10v5M6 17H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7" rx="1"/><path d="M18 11h.01"/>',
  redo: '<path d="m17 5 4 4-4 4M21 9H10a6 6 0 0 0 0 12h3"/>',
  minus: '<path d="M5 12h14"/>',
  'select-all': '<rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="3 3"/><rect x="7" y="7" width="10" height="10" rx="1"/>',
  'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 12h8M8 16h6"/>',
  'eye-off': '<path d="m3 3 18 18M10.6 5.6C11.1 5.5 11.5 5.5 12 5.5c7.5 0 10.5 6.5 10.5 6.5a17 17 0 0 1-3.2 3.9M6.1 6.1A18 18 0 0 0 1.5 12S5 18.5 12 18.5a12 12 0 0 0 5.5-1.3M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  activity: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
  wifi: '<path d="M2 8.5a16 16 0 0 1 20 0M5.5 12a10.5 10.5 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0"/><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><polyline points="16.5 9 10.75 15 7.5 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  'x-circle': '<circle cx="12" cy="12" r="9"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  'alert-circle': '<circle cx="12" cy="12" r="9"/><line x1="12" y1="7.5" x2="12" y2="13"/><circle cx="12" cy="16.5" r="0.8" fill="currentColor" stroke="none"/>',
  'alert-triangle': '<path d="M10.3 3.9 1.8 18.4A2 2 0 0 0 3.5 21.4h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><line x1="12" y1="9" x2="12" y2="13.5"/><circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><circle cx="12" cy="7.8" r="0.8" fill="currentColor" stroke="none"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2.5"/><line x1="6" y1="9.5" x2="6" y2="9.5"/><line x1="10" y1="9.5" x2="10" y2="9.5"/><line x1="14" y1="9.5" x2="14" y2="9.5"/><line x1="18" y1="9.5" x2="18" y2="9.5"/><line x1="6" y1="13" x2="6" y2="13"/><line x1="10" y1="13" x2="10" y2="13"/><line x1="14" y1="13" x2="14" y2="13"/><line x1="18" y1="13" x2="18" y2="13"/><line x1="8" y1="16.3" x2="16" y2="16.3"/>',
  unlink: '<path d="M9.5 14.5 7 17a3.5 3.5 0 0 1-5-5l2.5-2.5"/><path d="M14.5 9.5 17 7a3.5 3.5 0 0 1 5 5l-2.5 2.5"/><line x1="4" y1="4" x2="20" y2="20"/>',
  link: '<path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.5 1.5"/><path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.5-1.5"/>',
  clipboard: '<rect x="8" y="3" width="8" height="4" rx="1.2"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
  expand: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  compress: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
  refresh: '<polyline points="21 4 21 10 15 10"/><polyline points="3 20 3 14 9 14"/><path d="M19 10a8 8 0 0 0-14-3M5 14a8 8 0 0 0 14 3"/>',
  exchange: '<polyline points="17 2 21 6 17 10"/><line x1="21" y1="6" x2="4" y2="6"/><polyline points="7 14 3 18 7 22"/><line x1="3" y1="18" x2="20" y2="18"/>',
  magic: '<line x1="4" y1="20" x2="15" y2="9"/><path d="M17 3v4M15 5h4M18.5 12v3M17 13.5h3M6.5 3v3M5 4.5h3"/>',
  pointer: '<path d="M5 3l6.5 17 2.2-6.9 6.9-2.2Z"/>',
  arrows: '<polyline points="12 2 15 5 9 5 12 2"/><polyline points="12 22 9 19 15 19 12 22"/><polyline points="2 12 5 9 5 15 2 12"/><polyline points="22 12 19 15 19 9 22 12"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="4" y1="12" x2="20" y2="12"/>',
  send: '<path d="M21.5 2.5 2.5 10l7.5 3 3 7.5Z"/><line x1="21.5" y1="2.5" x2="10" y2="13"/>',
  'volume-up': '<polygon points="4 9 8 9 13 5 13 19 8 15 4 15"/><path d="M16.5 9.2a4 4 0 0 1 0 5.6M19 6.8a7.5 7.5 0 0 1 0 10.4"/>',
  'volume-off': '<polygon points="4 9 8 9 13 5 13 19 8 15 4 15"/><line x1="17" y1="9.5" x2="22" y2="14.5"/><line x1="22" y1="9.5" x2="17" y2="14.5"/>',
  camera: '<path d="M3 8.5h3l1.5-2.5h9L18 8.5h3a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.5"/>',
  film: '<rect x="2" y="4" width="20" height="16" rx="2"/><line x1="7" y1="4" x2="7" y2="20"/><line x1="17" y1="4" x2="17" y2="20"/><line x1="2" y1="12" x2="22" y2="12"/>',
  cog: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
  eye: '<path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3.2"/>',
  bolt: '<polygon points="13 2 4 14 11 14 10 22 20 10 13 10"/>',
  trash: '<polyline points="3 6 21 6"/><path d="M8 6V4.5a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 16 4.5V6"/><path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  bluetooth: '<polyline points="7 7 17 17 12 22 12 2 17 7 7 17"/>',
  'hard-drive': '<path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="6" y1="16" x2="6" y2="16"/><line x1="18" y1="16" x2="18" y2="16"/>',
  usb: '<path d="m12 2-2.5 4h5Z" fill="currentColor" stroke="none"/><circle cx="12" cy="20" r="1.6"/><line x1="12" y1="18.4" x2="12" y2="6"/><path d="M12 12l4-3v-2"/><rect x="14.6" y="5" width="3" height="3" rx="0.6"/><path d="M12 15l-4-3v-2.5"/><circle cx="8" cy="8.5" r="1.4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  crop: '<path d="M6.5 2v15.5H22"/><path d="M2 6.5h15.5V22"/>',
  undo: '<path d="m7 5-4 4 4 4M3 9h11a6 6 0 0 1 0 12h-3"/>',
  lock: '<rect x="4" y="10.5" width="16" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  monitor: '<rect x="2" y="3.5" width="20" height="13" rx="2"/><line x1="8" y1="20.5" x2="16" y2="20.5"/><line x1="12" y1="16.5" x2="12" y2="20.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="16.2" y1="16.2" x2="21" y2="21"/>',
  wrench: '<path d="m14.7 6.3 3 3 4-4a6 6 0 0 1-7.9 7.9l-7.3 7.3a3 3 0 0 1-4.2-4.2l7.3-7.3a6 6 0 0 1 7.9-7.9Z"/>',
  power: '<line x1="12" y1="3" x2="12" y2="12"/><path d="M7 6.3a8 8 0 1 0 10 0"/>',
  'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
  'chevron-up': '<polyline points="6 15 12 9 18 15"/>',
  'chevron-left': '<polyline points="15 6 9 12 15 18"/>',
  'chevron-right': '<polyline points="9 6 15 12 9 18"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  list: '<line x1="9" y1="7" x2="20" y2="7"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="17" x2="20" y2="17"/><circle cx="4.5" cy="7" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="17" r="1.2" fill="currentColor" stroke="none"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  record: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
}

/** Filled paths. */
const FILLED: Record<string, string> = {
  github:
    '<path d="M12 .5C5.7.5.5 5.7.5 12a11.5 11.5 0 0 0 7.9 10.9c.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.4-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.1.1 1.7 1.2 1.7 1.2 1 1.7 2.7 1.2 3.4.9.1-.7.4-1.2.7-1.5-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6A11.5 11.5 0 0 0 23.5 12C23.5 5.7 18.3.5 12 .5Z"/>',
}

const body = computed(() => STROKED[props.name] ?? FILLED[props.name] ?? STROKED.circle!)
const isFilled = computed(() => props.name in FILLED)
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :fill="isFilled ? 'currentColor' : 'none'"
    :stroke="isFilled ? 'none' : 'currentColor'"
    :stroke-width="isFilled ? undefined : stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    class="inline-block shrink-0 align-[-0.125em]"
    v-html="body"
  />
</template>
