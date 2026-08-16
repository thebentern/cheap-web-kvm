// SPDX-License-Identifier: GPL-3.0-or-later
import { reactive } from 'vue'

export type PanelName =
  | 'paste'
  | 'copy'
  | 'keyboard'
  | 'quickAccess'
  | 'recorder'
  | 'settings'
  | 'connectPrompt'

const open = reactive<Record<PanelName, boolean>>({
  paste: false,
  copy: false,
  keyboard: false,
  quickAccess: false,
  recorder: false,
  settings: false,
  connectPrompt: false,
})

export function usePanels() {
  return {
    open,
    show: (p: PanelName) => (open[p] = true),
    hide: (p: PanelName) => (open[p] = false),
    toggle: (p: PanelName) => (open[p] = !open[p]),
    isOpen: (p: PanelName) => open[p],
  }
}
