<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, onMounted, ref } from 'vue'
import { usePanels } from '~/composables/usePanels'
import { useKvm } from '~/composables/useKvm'
import { useVirtualMedia } from '~/composables/useVirtualMedia'
import { useDialogFocus } from '~/composables/useDialogFocus'
import { frame } from '~/utils/ch9329'
import type { Volume } from '~/utils/media/disk'
const panels = usePanels(),
  kvm = useKvm(),
  media = useVirtualMedia()
const root = ref<HTMLElement | null>(null)
useDialogFocus(root, () => panels.hide('media'), { restoreAfterUpdate: true })
const {
  connected,
  connecting,
  error,
  meta,
  saved,
  entries,
  inserted,
  uncertain,
  writeMode,
  busy,
  progress,
  persistent,
  path,
  inspection,
  activity,
  url,
  flags,
  preview,
} = media
const mode = ref<'boot' | 'fat32'>('boot'),
  capacity = ref(256),
  label = ref('KVM FILES'),
  folder = ref(''),
  unmounted = ref(false),
  savedId = ref('')
const key = ref(0x45),
  delay = ref(0),
  press = ref(80),
  interval = ref(300),
  duration = ref(60),
  macroArmed = ref(false),
  macroBusy = ref(false)
const locked = computed(() => busy.value || inserted.value || uncertain.value)
const dirty = computed(
  () => meta.value && meta.value.revision !== meta.value.exportedRevision,
)
const selectedSaved = computed(() =>
  saved.value.find((v) => v.id === savedId.value),
)
const size = (n: number) =>
  n >= 1073741824
    ? `${(n / 1073741824).toFixed(2)} GiB`
    : n >= 1048576
      ? `${(n / 1048576).toFixed(1)} MiB`
      : `${n} B`
function createDrive() {
  savedId.value = ''
  void media.open({ size: capacity.value * 1048576, label: label.value })
}
function insertMedia() {
  unmounted.value = false
  void media.insert()
}
async function image(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0]
  if (file)
    await media.open({
      file,
      meta:
        selectedSaved.value?.kind === 'boot' ? selectedSaved.value : undefined,
    })
  input.value = ''
}
async function add(event: Event) {
  const input = event.target as HTMLInputElement
  for (const file of Array.from(input.files ?? [])) {
    await media.add(file)
    if (error.value) break
  }
  input.value = ''
}
async function restore() {
  if (selectedSaved.value?.kind === 'fat32') {
    mode.value = 'fat32'
    await media.open({ meta: selectedSaved.value })
  } else if (selectedSaved.value) {
    mode.value = 'boot'
    error.value =
      'Reselect the original boot image below. Its size and full SHA-256 fingerprint must match the saved overlay.'
  }
}
async function boot(cancel = false) {
  if (!kvm.link.connected.value) {
    error.value = 'Connect Serial, Bluetooth, or Wi-Fi HID first'
    return
  }
  macroBusy.value = true
  try {
    const payload = new Uint8Array(17),
      v = new DataView(payload.buffer)
    payload[0] = key.value
    for (const [i, n] of [
      delay.value,
      press.value,
      interval.value,
      duration.value * 1000,
    ].entries())
      v.setUint32(1 + i * 4, n, true)
    const cmd = cancel ? 0x33 : 0x32,
      reply = await kvm.link.sendAndWait(
        frame(cmd, cancel ? [] : [...payload]),
        cmd,
      )
    if (!reply.ok)
      throw new Error(
        'Boot repetition rejected. Check timing values and install firmware supporting this feature.',
      )
    macroArmed.value = !cancel
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    macroBusy.value = false
  }
}
onMounted(() => {
  void media.initialize()
})
</script>

<template>
  <div
    class="fixed inset-0 z-[1600] flex items-center justify-center bg-black/60 p-3"
    @click.self="panels.hide('media')"
  >
    <section
      ref="root"
      role="dialog"
      aria-modal="true"
      aria-labelledby="media-title"
      class="kvm-media w-full max-w-3xl max-h-[92dvh] overflow-auto rounded-xl border border-ink-600 bg-ink-900 p-5 text-mist-100 shadow-2xl"
    >
      <div class="flex items-center justify-between gap-3">
        <h2 id="media-title" class="text-lg font-semibold">Virtual media</h2>
        <button
          class="kvm-btn"
          aria-label="Close virtual media panel"
          @click="panels.hide('media')"
        >
          Close
        </button>
      </div>
      <p class="kvm-hint mt-2">
        Keep this client connected, awake, and this tab visible while media is
        inserted. The ESP32 streams sectors; the source image stays unchanged.
        Experimental until validated on your board and target.
      </p>
      <p
        v-if="error"
        role="alert"
        class="mt-3 rounded border border-alert-400 p-3 text-sm text-alert-400"
      >
        {{ error }}
      </p>
      <details class="mt-4 rounded border border-ink-600 p-3">
        <summary class="cursor-pointer text-sm font-semibold">Wi-Fi setup · hotspot or router client</summary>
        <div class="mt-3"><WifiSettingsPanel /></div>
      </details>
      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <label class="text-sm"
          >Media backend
          <input
            v-model="url"
            class="kvm-input mt-1 w-full"
            placeholder="wss://localhost:8443/media"
            :disabled="connected || locked"
          />
        </label>
        <div class="flex flex-wrap items-end gap-2">
          <button
            class="kvm-btn"
            :disabled="busy || connecting || locked"
            @click="connected ? media.disconnect() : media.connect()"
          >
            {{ connected ? 'Disconnect media' : 'Connect media' }}
          </button>
          <button
            class="kvm-btn"
            :disabled="!connected || locked"
            @click="media.benchmark()"
          >
            Measure link
          </button>
          <button
            class="kvm-btn"
            :disabled="!connected || busy"
            @click="kvm.link.connect('wifi')"
          >
            Use Wi-Fi HID
          </button>
        </div>
      </div>
      <p class="kvm-hint mt-2">
        Wi-Fi via the local HTTPS helper. Serial at 115200 and Bluetooth remain
        control links. Configure the network and helper token in Settings → Wi-Fi;
        see the virtual-media guide in the repository.
      </p>
      <p class="mt-2 font-mono text-xs">
        {{
          connected
            ? 'Backend connected · protocol v1 · 512-byte sectors'
            : 'Backend disconnected'
        }}
        ·
        {{
          uncertain
            ? 'Synchronization required — edits locked'
            : inserted
              ? 'Inserted — target owns disk'
              : 'Ejected — client owns disk'
        }}
      </p>
      <p v-if="activity.benchmark" class="kvm-hint mt-1">
        {{ activity.benchmark }}
      </p>
      <div class="mt-4 flex gap-2" role="group" aria-label="Media mode">
        <button
          class="kvm-btn"
          :aria-pressed="mode === 'boot'"
          :disabled="locked"
          @click="mode = 'boot'"
        >
          Boot image
        </button>
        <button
          class="kvm-btn"
          :aria-pressed="mode === 'fat32'"
          :disabled="locked"
          @click="mode = 'fat32'"
        >
          FAT32 thumb drive
        </button>
      </div>
      <fieldset class="mt-3 space-y-3" :disabled="locked">
        <legend class="sr-only">Source selection</legend>
        <div class="flex flex-wrap items-end gap-2">
          <label class="flex-1 text-sm"
            >Saved disks and overlays
            <select v-model="savedId" class="kvm-input mt-1 w-full">
              <option value="">New source</option>
              <option v-for="v in saved" :key="v.id" :value="v.id">
                {{ v.name }} · {{ v.kind }} · {{ v.created.slice(0, 10) }}
              </option>
            </select>
          </label>
          <button class="kvm-btn" :disabled="!savedId" @click="restore">
            Open saved
          </button>
        </div>
        <template v-if="mode === 'boot'">
          <label class="block text-sm"
            >Select local .img or USB-bootable hybrid .iso
            <input
              class="mt-2 block w-full text-sm"
              type="file"
              accept=".img,.iso,.xz"
              @change="image"
            />
          </label>
          <p class="kvm-hint">
            Unpack .img.xz first. Optical-only ISOs need CD/DVD emulation, which
            is not provided. mPWRD-OS UEFI is a compressed raw disk image and
            may require writable media for first boot.
          </p>
        </template>
        <div v-else class="grid gap-2 sm:grid-cols-3">
          <label class="text-sm"
            >Capacity (MiB)<input
              v-model.number="capacity"
              type="number"
              min="64"
              max="32768"
              step="1"
              class="kvm-input mt-1 w-full"
          /></label>
          <label class="text-sm"
            >Volume label<input
              v-model="label"
              maxlength="11"
              class="kvm-input mt-1 w-full"
          /></label>
          <button class="kvm-btn self-end" @click="createDrive">
            Create FAT32 drive
          </button>
        </div>
      </fieldset>
      <div v-if="meta" class="mt-4 rounded-lg border border-ink-600 p-3">
        <p class="text-sm font-semibold">
          {{ meta.name }} · {{ size(meta.size) }} ·
          {{
            meta.kind === 'fat32'
              ? 'MBR / FAT32'
              : 'Disk image + copy-on-write overlay'
          }}
        </p>
        <p class="kvm-hint mt-1">
          Revision {{ meta.revision }} ·
          {{
            dirty
              ? 'Changes saved in this browser; export not confirmed'
              : 'Export confirmed at current revision'
          }}
          ·
          {{
            persistent
              ? 'Persistent storage granted'
              : 'Storage may be evicted; writable insertion disabled'
          }}
        </p>
        <p v-if="meta.needsCheck" role="alert" class="text-sm text-alert-400">
          A client edit was interrupted. Export for filesystem repair before
          inserting or editing.
        </p>
        <ul
          v-if="inspection.length"
          class="mt-2 space-y-1 text-xs text-mist-300"
        >
          <li v-for="line in inspection" :key="line">{{ line }}</li>
        </ul>
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <label class="text-sm"
            ><input v-model="writeMode" type="checkbox" :disabled="locked" />
            Allow target writes to saved overlay</label
          >
          <button
            v-if="!persistent"
            class="kvm-btn"
            :disabled="busy || inserted"
            @click="media.grantPersistence()"
          >
            Grant persistent storage
          </button>
          <button
            class="kvm-btn"
            :disabled="!connected || locked || !!meta.needsCheck"
            @click="insertMedia"
          >
            Insert
          </button>
          <button
            class="kvm-btn"
            :disabled="busy || (!inserted && !uncertain)"
            @click="media.eject(unmounted)"
          >
            Eject and synchronize
          </button>
        </div>
        <label v-if="inserted || uncertain" class="mt-3 block text-sm"
          ><input v-model="unmounted" type="checkbox" /> I unmounted/ejected
          this disk in the target OS (or the target is powered off).</label
        >
        <p class="kvm-hint mt-2">
          Before ejection, unmount in the target and wait for transfers to stop.
          Every successful target write is committed to browser storage; quota
          errors fail the USB write. This does not flush data still cached by
          the target OS.
        </p>
        <p class="mt-2 font-mono text-xs">
          Read {{ size(activity.read) }} · committed writes
          {{ size(activity.written) }} · {{ size(Math.round(activity.rate)) }}/s
          average · {{ activity.last || 'No transfers yet' }}
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            class="kvm-btn"
            :disabled="locked"
            @click="media.exportDisk()"
          >
            Export updated disk image
          </button>
          <button
            v-if="dirty"
            class="kvm-btn"
            :disabled="locked"
            @click="media.markExported()"
          >
            I saved the downloaded export
          </button>
        </div>
        <p class="kvm-hint mt-1">
          Exports are new files. Saved overlays can be reopened here; boot
          overlays require reselecting the matching original. Clearing browser
          data removes them. An interrupted client edit is locked for external
          repair.
        </p>
      </div>
      <fieldset
        v-if="meta?.kind === 'fat32'"
        class="mt-4"
        :disabled="locked || !!meta.needsCheck"
      >
        <legend class="text-sm font-semibold">
          Files · /{{ path.join('/') }}
        </legend>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <button
            class="kvm-btn"
            :disabled="!path.length"
            @click="media.navigate()"
          >
            Up
          </button>
          <label class="kvm-btn"
            >Add files<input
              class="sr-only"
              type="file"
              multiple
              :disabled="locked"
              @change="add"
          /></label>
          <input
            v-model="folder"
            class="kvm-input"
            placeholder="New folder name"
            aria-label="New folder name"
          />
          <button
            class="kvm-btn"
            :disabled="!folder"
            @click="media.mkdir(folder)"
          >
            Create folder
          </button>
        </div>
        <p v-if="inserted || uncertain" class="kvm-hint mt-2">
          File browser locked while the target owns the filesystem. Eject and
          synchronize to retrieve target-created files.
        </p>
        <table v-else class="mt-3 w-full text-left text-sm">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Size</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in entries"
              :key="entry.name"
              class="border-t border-ink-600"
            >
              <td class="max-w-60 break-words py-2">
                <button
                  v-if="entry.directory"
                  class="underline"
                  @click="media.navigate(entry.name)"
                >
                  {{ entry.name }}/</button
                ><span v-else>{{ entry.name }}</span>
              </td>
              <td>{{ entry.directory ? 'Folder' : size(entry.size) }}</td>
              <td>
                <button
                  v-if="!entry.directory"
                  class="kvm-btn"
                  @click="media.inspectFile(entry.name)"
                >
                  Inspect
                </button>
                <button
                  v-if="!entry.directory"
                  class="kvm-btn"
                  @click="media.downloadFile(entry.name)"
                >
                  Download
                </button>
                <button class="kvm-btn" @click="media.remove(entry.name)">
                  Remove
                </button>
              </td>
            </tr>
            <tr v-if="!entries.length">
              <td colspan="3" class="py-3 text-mist-400">
                This folder is empty.
              </td>
            </tr>
          </tbody>
        </table>
        <pre
          v-if="preview && !inserted && !uncertain"
          class="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-ink-600 p-2 text-xs"
          >{{ preview }}</pre>
        <p class="kvm-hint mt-2">
          64 MiB–32 GiB, up to 4 GiB minus 1 byte per file, VFAT names up to 255
          UTF-16 units. Remove folder contents before removing a folder.
        </p>
      </fieldset>
      <section
        class="mt-5 border-t border-ink-600 pt-4"
        aria-labelledby="boot-repeat-title"
      >
        <h3 id="boot-repeat-title" class="text-sm font-semibold">
          Boot-key repetition
        </h3>
        <p class="kvm-hint mt-1">
          Arm before manually restarting the target. Firmware waits for keyboard
          readiness and resumes after re-enumeration within the duration. Target
          power control needs additional hardware.
        </p>
        <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <label class="text-xs"
            >Key<select v-model.number="key" class="kvm-input mt-1 w-full">
              <option v-for="n in 12" :key="n" :value="0x39 + n">
                F{{ n }}
              </option>
              <option :value="0x29">Escape</option>
              <option :value="0x4c">Delete</option>
              <option :value="0x28">Enter</option>
            </select></label
          >
          <label class="text-xs"
            >Initial delay (ms)<input
              v-model.number="delay"
              class="kvm-input mt-1 w-full"
              type="number"
              min="0"
              max="120000"
          /></label>
          <label class="text-xs"
            >Press (ms)<input
              v-model.number="press"
              class="kvm-input mt-1 w-full"
              type="number"
              min="20"
              max="2000"
          /></label>
          <label class="text-xs"
            >Press interval (ms)<input
              v-model.number="interval"
              class="kvm-input mt-1 w-full"
              type="number"
              :min="press + 10"
              max="10000"
          /></label>
          <label class="text-xs"
            >Duration (seconds)<input
              v-model.number="duration"
              class="kvm-input mt-1 w-full"
              type="number"
              min="1"
              max="300"
          /></label>
        </div>
        <div class="mt-3 flex gap-2">
          <button
            class="kvm-btn"
            :disabled="macroBusy || !kvm.link.connected.value"
            @click="boot()"
          >
            Arm repetition</button
          ><button
            class="kvm-btn"
            :disabled="!kvm.link.connected.value"
            @click="boot(true)"
          >
            Cancel and release key
          </button>
        </div>
        <p class="kvm-hint mt-2">
          {{
            connected
              ? flags & 32
                ? 'Firmware repetition active'
                : 'Firmware repetition inactive'
              : macroArmed
                ? 'Armed; bounded by configured duration (serial/Bluetooth status not polled)'
                : 'Not armed'
          }}. Cancel from the active control link, even during media transfers.
        </p>
      </section>
      <p v-if="busy" role="status" class="mt-3 text-sm text-signal-400">
        Working{{ progress ? ` · ${progress}%` : '…' }}
      </p>
    </section>
  </div>
</template>
<style scoped>
.kvm-media {
  color-scheme: dark;
}
.kvm-media :disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.kvm-media th {
  font-weight: 500;
  padding-bottom: 0.5rem;
}
</style>
