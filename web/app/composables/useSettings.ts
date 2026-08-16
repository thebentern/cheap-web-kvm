// SPDX-License-Identifier: GPL-3.0-or-later
import { reactive, watch } from 'vue'

const STORAGE_KEY = 'cheap-web-kvm.settings'

export interface KvmSettings {
  enableAudio: boolean
  extraGain: number
  invertScrollwheel: boolean
  scrollSensitivity: number
  relativeMouseMode: boolean
  relativeMouseSensitivity: number
  showLocalCursor: boolean
  mouseJiggler: boolean
  imageSharpening: boolean
  ctrlCmdSwap: boolean
  askOnPaste: boolean
  stackKeysEnabled: boolean
  stackKeyToggle: string
  stackKeyLongPress: number
  ocrLanguage: string
  ocrTrimSpaces: boolean
  skipConnectPrompt: boolean
  persist: boolean
}

export const DEFAULT_SETTINGS: KvmSettings = {
  enableAudio: true,
  extraGain: 1,
  invertScrollwheel: false,
  scrollSensitivity: 2,
  relativeMouseMode: false,
  relativeMouseSensitivity: 1.0,
  showLocalCursor: true,
  mouseJiggler: false,
  imageSharpening: false,
  ctrlCmdSwap: false,
  askOnPaste: false,
  stackKeysEnabled: true,
  stackKeyToggle: 'ShiftRight',
  stackKeyLongPress: 1.0,
  ocrLanguage: 'eng',
  ocrTrimSpaces: false,
  skipConnectPrompt: false,
  persist: true,
}

const settings = reactive<KvmSettings>({ ...DEFAULT_SETTINGS })
let loaded = false

export function useSettings() {
  function load() {
    if (loaded || typeof localStorage === 'undefined') return
    loaded = true
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as Partial<KvmSettings>
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof KvmSettings)[]) {
        if (saved[key] !== undefined) (settings[key] as unknown) = saved[key]
      }
    } catch {
      // Corrupt or unreadable storage: fall back to defaults rather than failing.
    }
  }

  function save() {
    if (typeof localStorage === 'undefined') return
    if (!settings.persist) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // Private mode or quota; not worth interrupting the user over.
    }
  }

  function reset() {
    Object.assign(settings, DEFAULT_SETTINGS)
    save()
  }

  function startAutosave() {
    load()
    watch(settings, save, { deep: true })
  }

  return { settings, load, save, reset, startAutosave, DEFAULT_SETTINGS }
}
