<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, onMounted, ref } from 'vue'
import { usePanels } from '~/composables/usePanels'
import { useKvm } from '~/composables/useKvm'
import { useVirtualMedia } from '~/composables/useVirtualMedia'
import { useDialogFocus } from '~/composables/useDialogFocus'
import { useSerialLink } from '~/composables/useSerialLink'
import { useBleLink } from '~/composables/useBleLink'
import { useBootRepeatState } from '~/composables/useBootRepeatState'
import { frame } from '~/utils/ch9329'
const panels = usePanels(),
  kvm = useKvm(),
  media = useVirtualMedia(),
  serial = useSerialLink(),
  ble = useBleLink()
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
  phase,
  importing,
  cancelingImport,
  persistent,
  path,
  inspection,
  activity,
  url,
  boardToken,
  onboard,
  deviceInfo,
  transport,
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
  duration = ref(60)
const repeat = useBootRepeatState(connected, flags)
const repeatActive = repeat.active
const macroBusy = computed(() => repeat.pending.value !== null)
const locked = computed(() => busy.value || inserted.value || uncertain.value)
const needsPairing = computed(
  () =>
    transport.value === 'wifi' &&
    onboard.value &&
    !deviceInfo.value?.authenticated,
)
const pairingMethod = computed(() =>
  serial.connected.value
    ? 'usb'
    : ble.connected.value
      ? 'bluetooth'
      : serial.supported.value
        ? 'usb'
        : ble.supported.value
          ? 'bluetooth'
          : 'manual',
)
const manualPairing = ref(false)
const connectionLabel = computed(() => {
  if (connecting.value) return 'Connecting…'
  if (connected.value) return 'Disconnect'
  if (!needsPairing.value) return 'Connect'
  if (boardToken.value) return 'Connect with token'
  return pairingMethod.value === 'usb'
    ? 'Pair with USB'
    : pairingMethod.value === 'bluetooth'
      ? 'Pair with Bluetooth'
      : 'Enter access token'
})
function connectMedia() {
  if (connected.value) return media.disconnect()
  if (!needsPairing.value || boardToken.value) return media.connect()
  if (pairingMethod.value === 'usb') return media.pairWithUsb()
  if (pairingMethod.value === 'bluetooth') return media.pairWithBluetooth()
  manualPairing.value = true
}
const wifiControlActive = computed(
  () => kvm.link.kind.value === 'wifi' && kvm.link.connected.value,
)
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
      : n >= 1024
        ? `${(n / 1024).toFixed(1)} KiB`
        : `${n} B`
function changeBaud(event: Event) {
  serial.setBaudRate(Number((event.target as HTMLSelectElement).value))
}
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
  if (
    selectedSaved.value?.kind === 'fat32' ||
    selectedSaved.value?.sourceCache
  ) {
    mode.value = selectedSaved.value.kind
    await media.open({ meta: selectedSaved.value })
  } else if (selectedSaved.value) {
    mode.value = 'boot'
    error.value =
      'Reselect the original boot image. Its size and full SHA-256 fingerprint must match the saved overlay.'
  }
}
async function boot(cancel = false) {
  if (!kvm.link.connected.value) {
    error.value = 'Connect Serial, Bluetooth, or Wi-Fi HID first'
    return
  }
  if (!repeat.begin(cancel)) return
  const expiresAfter = delay.value + duration.value * 1000
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
    repeat.acknowledge(cancel, expiresAfter)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    repeat.finish()
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
      class="kvm-media w-full max-w-2xl max-h-[92dvh] overflow-auto rounded-xl border border-ink-600 bg-ink-900 p-5 text-mist-100 shadow-2xl sm:p-6"
    >
      <header class="flex items-start justify-between gap-4">
        <div>
          <h2 id="media-title" class="text-lg font-semibold">Virtual media</h2>
          <p class="kvm-hint mt-1">
            Share a boot image or a USB drive with the target.
          </p>
        </div>
        <button
          class="kvm-btn kvm-btn-icon"
          aria-label="Close virtual media panel"
          @click="panels.hide('media')"
        >
          <AppIcon name="x" />
        </button>
      </header>

      <p
        v-if="error"
        role="alert"
        class="mt-4 rounded-lg border border-alert-400 p-3 text-sm text-alert-400"
      >
        {{ error }}
      </p>
      <div v-if="busy" class="mt-4 flex items-center justify-between gap-3">
        <p role="status" class="text-sm text-signal-400">
          {{
            cancelingImport
              ? 'Canceling import…'
              : `${phase}${progress ? ` · ${progress}%` : '…'}`
          }}
        </p>
        <button
          v-if="importing"
          class="kvm-btn"
          :disabled="cancelingImport"
          @click="media.cancelImport()"
        >
          Cancel import
        </button>
      </div>

      <section
        aria-label="Media connection"
        class="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-ink-850 p-3"
      >
        <div>
          <p class="flex items-center gap-2 text-sm font-medium">
            <span
              class="h-2 w-2 rounded-full"
              :class="connected ? 'bg-signal-400' : 'bg-ink-500'"
              aria-hidden="true"
            />{{
              connected
                ? `Media connected over ${transport === 'usb' ? 'USB' : 'Wi-Fi'}`
                : 'Media disconnected'
            }}
          </p>
          <p v-if="!connected" class="kvm-hint mt-1">
            {{
              transport === 'usb'
                ? 'Use the board’s USB programming port.'
                : onboard
                  ? 'Connect directly to this board over Wi-Fi.'
                  : 'Connect through the local HTTPS helper.'
            }}
          </p>
          <p v-else-if="transport === 'wifi'" class="kvm-hint mt-1">
            {{
              wifiControlActive
                ? 'Keyboard and mouse also connected.'
                : kvm.link.connected.value
                  ? `Keyboard and mouse use ${kvm.link.kind.value === 'ble' ? 'Bluetooth' : 'USB'}.`
                  : 'Keyboard and mouse are paused.'
            }}
          </p>
        </div>
        <button
          v-if="connected && transport === 'wifi' && !kvm.link.connected.value"
          class="kvm-btn"
          :disabled="busy || connecting"
          @click="kvm.link.connect('wifi')"
        >
          Enable keyboard &amp; mouse
        </button>
        <button
          class="kvm-btn"
          :disabled="busy || connecting || locked"
          @click="connectMedia()"
        >
          {{ connectionLabel }}
        </button>
      </section>

      <div
        class="mt-3 grid grid-cols-2 gap-2"
        role="group"
        aria-label="Media connection type"
      >
        <button
          class="kvm-btn media-choice"
          :aria-pressed="transport === 'usb'"
          :disabled="connected || connecting || locked"
          @click="media.selectTransport('usb')"
        >
          USB
        </button>
        <button
          class="kvm-btn media-choice"
          :aria-pressed="transport === 'wifi'"
          :disabled="connected || connecting || locked"
          @click="media.selectTransport('wifi')"
        >
          Wi-Fi
        </button>
      </div>
      <div
        v-if="needsPairing"
        class="mt-3 space-y-3 rounded-lg border border-ink-600 p-3"
      >
        <p v-if="pairingMethod === 'usb'" class="kvm-hint">
          Connect the board’s programming USB port to this computer, then choose
          Pair with USB. The console reads the access token for you.
        </p>
        <p v-else-if="pairingMethod === 'bluetooth'" class="kvm-hint">
          Choose Pair with Bluetooth to read the board’s access token and
          connect over Wi-Fi.
        </p>
        <p v-else class="kvm-hint">
          Enter the board’s access token below. To read it automatically, open
          this page in a browser that supports USB or Bluetooth pairing.
        </p>
        <button
          v-if="
            pairingMethod === 'usb' &&
            (ble.supported.value || ble.connected.value)
          "
          class="kvm-btn"
          :disabled="connected || connecting || locked"
          @click="media.pairWithBluetooth()"
        >
          Pair with Bluetooth instead
        </button>
        <button
          v-else-if="pairingMethod === 'bluetooth' && serial.supported.value"
          class="kvm-btn"
          :disabled="connected || connecting || locked"
          @click="media.pairWithUsb()"
        >
          Pair with USB instead
        </button>
        <details :open="manualPairing || pairingMethod === 'manual'">
          <summary class="cursor-pointer text-sm text-mist-300">
            Enter token manually
          </summary>
          <label class="mt-3 block text-sm"
            >Access token<input
              v-model="boardToken"
              type="password"
              autocomplete="off"
              :spellcheck="false"
              maxlength="80"
              class="kvm-input mt-1 w-full"
              :disabled="connected || connecting || locked"
              @keydown.enter.prevent="media.connect()"
          /></label>
        </details>
        <p class="kvm-hint">
          Pairing is saved as a private browser session. The app does not save
          the token. Pair again after a board restart or when the session
          expires.
        </p>
      </div>
      <details class="mt-3 border-b border-ink-600 pb-3">
        <summary class="cursor-pointer text-sm text-mist-300">
          Connection settings
        </summary>
        <div class="mt-3 space-y-3">
          <label v-if="transport === 'wifi' && !onboard" class="block text-sm"
            >Helper address<input
              v-model="url"
              class="kvm-input mt-1 w-full"
              placeholder="wss://localhost:8443/media"
              :disabled="connected || locked"
          /></label>
          <p v-if="transport === 'wifi' && !onboard" class="kvm-hint">
            Set up the board’s network in Settings → Wi-Fi, then start the HTTPS
            helper. Leave the address blank when using the helper’s own web UI.
          </p>
          <p v-if="transport === 'wifi' && onboard" class="kvm-hint">
            This page is served by the board. Media connects directly over
            HTTPS; no helper is needed.
          </p>
          <p
            v-if="
              transport === 'wifi' &&
              onboard &&
              deviceInfo?.certificateFingerprint
            "
            class="kvm-hint break-all"
          >
            Board certificate SHA-256: {{ deviceInfo.certificateFingerprint }}
          </p>
          <div v-if="transport === 'usb'" class="space-y-2">
            <label class="block text-sm"
              >USB baud rate
              <select
                class="kvm-select mt-1 w-full"
                :value="serial.baudRate.value"
                :disabled="
                  connected || connecting || locked || serial.baudLocked.value
                "
                @change="changeBaud"
              >
                <option
                  v-for="rate in serial.baudRates"
                  :key="rate"
                  :value="rate"
                >
                  {{ rate.toLocaleString() }}
                </option>
              </select>
            </label>
            <p class="kvm-hint">
              Must match the rate built into the board’s firmware. Disconnect
              serial control before changing it.
            </p>
            <p class="kvm-hint">
              Use the programming port for this computer and native USB for the
              target. Media and keyboard control share the cable.
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              class="kvm-btn"
              :disabled="!connected || locked"
              @click="media.benchmark()"
            >
              Test connection speed
            </button>
            <button
              v-if="
                transport === 'wifi' &&
                !wifiControlActive &&
                kvm.link.connected.value
              "
              class="kvm-btn"
              :disabled="!connected || busy"
              @click="kvm.link.connect('wifi')"
            >
              Use Wi-Fi for keyboard &amp; mouse
            </button>
          </div>
          <p v-if="activity.benchmark" class="kvm-hint">
            {{ activity.benchmark }}
          </p>
        </div>
      </details>

      <details class="mt-5" :open="!meta">
        <summary class="cursor-pointer text-sm font-semibold">
          {{ meta ? 'Change disk' : 'Choose a disk' }}
        </summary>
        <fieldset class="mt-3 space-y-4" :disabled="locked">
          <legend class="sr-only">Disk selection</legend>
          <div
            class="grid grid-cols-2 gap-2"
            role="group"
            aria-label="Media mode"
          >
            <button
              class="kvm-btn media-choice"
              :aria-pressed="mode === 'boot'"
              @click="mode = 'boot'"
            >
              Boot image
            </button>
            <button
              class="kvm-btn media-choice"
              :aria-pressed="mode === 'fat32'"
              @click="mode = 'fat32'"
            >
              USB drive
            </button>
          </div>
          <div v-if="mode === 'boot'" class="space-y-2">
            <label class="block text-sm"
              >Disk image<input
                class="mt-2 block w-full text-sm"
                type="file"
                accept=".img,.iso,.img.xz"
                @change="image"
            /></label>
            <p class="kvm-hint">
              Choose .img, .img.xz, or USB-bootable .iso. Compressed images are
              prepared automatically in browser storage. Your original stays
              unchanged.
            </p>
          </div>
          <div v-else class="space-y-3">
            <div class="grid grid-cols-2 gap-3">
              <label class="text-sm"
                >Size (MiB)<input
                  v-model.number="capacity"
                  type="number"
                  min="64"
                  max="32768"
                  step="1"
                  class="kvm-input mt-1 w-full"
              /></label>
              <label class="text-sm"
                >Drive name<input
                  v-model="label"
                  maxlength="11"
                  class="kvm-input mt-1 w-full"
              /></label>
            </div>
            <button class="kvm-btn kvm-btn-primary" @click="createDrive">
              Create USB drive
            </button>
            <p class="kvm-hint">FAT32 · 64 MiB–32 GiB · Files under 4 GiB.</p>
          </div>
          <div
            v-if="saved.length"
            class="flex flex-wrap items-end gap-2 border-t border-ink-600 pt-3"
          >
            <label class="min-w-0 flex-1 text-sm"
              >Or reopen a saved disk<select
                v-model="savedId"
                class="kvm-select mt-1 w-full"
              >
                <option value="">Choose saved disk…</option>
                <option v-for="v in saved" :key="v.id" :value="v.id">
                  {{ v.name }} · {{ v.created.slice(0, 10) }}
                </option>
              </select></label
            >
            <button class="kvm-btn" :disabled="!savedId" @click="restore">
              Open
            </button>
          </div>
        </fieldset>
      </details>

      <section
        v-if="meta"
        aria-label="Selected disk"
        class="mt-5 rounded-lg border border-ink-600 p-4"
      >
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="break-words text-sm font-semibold">{{ meta.name }}</h3>
            <p class="kvm-hint mt-1">
              {{ size(meta.size) }} ·
              {{ meta.kind === 'fat32' ? 'FAT32 USB drive' : 'Boot image' }}
            </p>
          </div>
          <span
            class="rounded-full bg-ink-850 px-2 py-1 text-xs"
            role="status"
            >{{
              meta.needsCheck
                ? 'Repair required'
                : uncertain
                  ? 'Needs synchronization'
                  : inserted
                    ? 'Inserted'
                    : 'Ready to insert'
            }}</span
          >
        </div>
        <p
          v-if="meta.needsCheck"
          role="alert"
          class="mt-3 text-sm text-alert-400"
        >
          An edit was interrupted. Download this disk for filesystem repair
          before using it.
        </p>
        <template v-if="inserted || uncertain">
          <p class="kvm-hint mt-3">
            Keep this tab visible and this computer awake while the disk is in
            use.
          </p>
          <label class="mt-3 flex items-start gap-2 text-sm"
            ><input v-model="unmounted" type="checkbox" class="mt-1" />The disk
            is unmounted on the target, or the target is off.</label
          >
          <button
            class="kvm-btn kvm-btn-primary mt-3"
            :disabled="busy || ((writeMode || uncertain) && !unmounted)"
            @click="media.eject(unmounted)"
          >
            Eject and synchronize
          </button>
        </template>
        <template v-else>
          <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
            <label class="text-sm"
              ><input v-model="writeMode" type="checkbox" :disabled="locked" />
              Allow target to write</label
            >
            <button
              class="kvm-btn kvm-btn-primary"
              :disabled="
                !connected ||
                locked ||
                !!meta.needsCheck ||
                (writeMode && !persistent)
              "
              @click="insertMedia"
            >
              Insert into target
            </button>
          </div>
          <p v-if="meta.kind === 'boot'" class="kvm-hint mt-2">
            Enable writes for a full OS disk. Changes are saved separately;
            your original image stays unchanged.
          </p>
          <div v-if="writeMode && !persistent" class="mt-3">
            <p class="kvm-hint">
              Allow browser storage to keep target writes before inserting.
            </p>
            <button
              class="kvm-btn mt-2"
              :disabled="busy"
              @click="media.grantPersistence()"
            >
              Allow persistent storage
            </button>
          </div>
          <p v-if="!connected" class="kvm-hint mt-3">
            Connect media above to insert this disk.
          </p>
        </template>
        <details class="mt-4 border-t border-ink-600 pt-3">
          <summary class="cursor-pointer text-sm text-mist-300">
            Disk details &amp; download
          </summary>
          <div class="mt-3 space-y-3">
            <p v-if="meta.sourceCache" class="kvm-hint">
              Prepared image saved in this browser. Reopen it from the saved
              disk list.
            </p>
            <p v-if="meta.fingerprint" class="kvm-hint">
              {{
                meta.sourceCache
                  ? 'Prepared image SHA-256'
                  : 'Original image SHA-256'
              }}
              <span class="mt-1 block break-all font-mono text-xs">{{
                meta.fingerprint
              }}</span>
            </p>
            <p class="kvm-hint">
              {{
                dirty
                  ? 'Changes saved in this browser; download a copy to keep them elsewhere.'
                  : 'Downloaded copy is up to date.'
              }}
              Clearing browser data removes saved disks and changes.
            </p>
            <div class="flex flex-wrap gap-2">
              <button
                class="kvm-btn"
                :disabled="locked"
                @click="media.exportDisk()"
              >
                Download disk image
              </button>
              <button
                v-if="dirty"
                class="kvm-btn"
                :disabled="locked"
                @click="media.markExported()"
              >
                Confirm download saved
              </button>
            </div>
            <ul
              v-if="inspection.length"
              class="space-y-1 text-xs text-mist-300"
            >
              <li v-for="line in inspection" :key="line">{{ line }}</li>
            </ul>
            <p class="kvm-hint">
              {{
                persistent
                  ? 'Persistent browser storage enabled.'
                  : 'Browser storage may be cleared automatically.'
              }}
              Revision {{ meta.revision }}. Target writes are saved to browser
              storage; unmount on the target before ejecting to flush its cached
              data.
            </p>
            <p v-if="activity.readRequests" class="kvm-hint">
              Browser read response:
              {{ activity.readRequests.toLocaleString() }}
              requests · average
              {{ (activity.readTotalMs / activity.readRequests).toFixed(1) }} ms
              · max {{ activity.readMaxMs.toFixed(1) }} ms. Includes browser
              storage and response handoff; excludes Wi-Fi transit and target
              processing.
            </p>
          </div>
        </details>
        <p
          v-if="inserted || activity.read || activity.written"
          class="kvm-hint mt-3"
        >
          Read {{ size(activity.read) }} · Written
          {{ size(activity.written) }} · Read speed
          {{ size(Math.round(activity.rate)) }}/s
        </p>
      </section>

      <section
        v-if="meta?.kind === 'fat32'"
        aria-label="Drive files"
        class="mt-5"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="break-all text-sm font-semibold">
            Files
            <span class="font-normal text-mist-400">/{{ path.join('/') }}</span>
          </h3>
          <label v-if="!locked && !meta.needsCheck" class="kvm-btn"
            >Add files<input class="sr-only" type="file" multiple @change="add"
          /></label>
        </div>
        <p v-if="inserted || uncertain" class="kvm-hint mt-3">
          Eject and synchronize the disk to browse files or retrieve changes
          from the target.
        </p>
        <fieldset v-else class="mt-3" :disabled="locked || !!meta.needsCheck">
          <legend class="sr-only">Manage files</legend>
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-if="path.length"
              class="kvm-btn"
              @click="media.navigate()"
            >
              Up one folder
            </button>
            <details class="text-sm">
              <summary class="cursor-pointer text-mist-300">New folder</summary>
              <div class="mt-2 flex gap-2">
                <input
                  v-model="folder"
                  class="kvm-input min-w-0 flex-1"
                  placeholder="Folder name"
                  aria-label="New folder name"
                /><button
                  class="kvm-btn"
                  :disabled="!folder"
                  @click="media.mkdir(folder)"
                >
                  Create
                </button>
              </div>
            </details>
          </div>
          <div class="overflow-x-auto">
            <table class="mt-3 w-full text-left text-sm">
              <thead class="text-mist-400">
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Size</th>
                  <th scope="col"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="entry in entries"
                  :key="entry.name"
                  class="border-t border-ink-600"
                >
                  <td class="max-w-60 break-words py-3">
                    <button
                      v-if="entry.directory"
                      class="underline underline-offset-2"
                      @click="media.navigate(entry.name)"
                    >
                      {{ entry.name }}/</button
                    ><span v-else>{{ entry.name }}</span>
                  </td>
                  <td class="pr-2 text-xs text-mist-400">
                    {{ entry.directory ? 'Folder' : size(entry.size) }}
                  </td>
                  <td class="py-2 text-right">
                    <details>
                      <summary
                        class="cursor-pointer text-xs text-mist-300"
                        :aria-label="`Actions for ${entry.name}`"
                      >
                        Actions
                      </summary>
                      <div class="mt-2 flex flex-wrap justify-end gap-2">
                        <button
                          v-if="!entry.directory"
                          class="kvm-btn"
                          @click="media.downloadFile(entry.name)"
                        >
                          Download</button
                        ><button
                          v-if="!entry.directory"
                          class="kvm-btn"
                          @click="media.inspectFile(entry.name)"
                        >
                          Preview</button
                        ><button
                          class="kvm-btn"
                          @click="media.remove(entry.name)"
                        >
                          Remove
                        </button>
                      </div>
                    </details>
                  </td>
                </tr>
                <tr v-if="!entries.length">
                  <td colspan="3" class="py-6 text-center text-mist-400">
                    No files yet. Add files to share with the target.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <pre
            v-if="preview"
            class="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-ink-600 p-3 text-xs"
            >{{ preview }}</pre>
        </fieldset>
      </section>

      <details class="mt-5 border-t border-ink-600 pt-4">
        <summary class="cursor-pointer text-sm font-semibold">
          Boot key
          <span v-if="repeatActive" class="ml-2 text-signal-400">{{
            connected ? 'Active' : 'Armed'
          }}</span>
        </summary>
        <p class="kvm-hint mt-2">
          Repeat a key while you restart the target to open its boot menu.
        </p>
        <div class="mt-3 flex flex-wrap items-end gap-3">
          <label class="text-sm"
            >Key<select v-model.number="key" class="kvm-select mt-1 w-full">
              <option v-for="n in 12" :key="n" :value="0x39 + n">
                F{{ n }}
              </option>
              <option :value="0x29">Escape</option>
              <option :value="0x4c">Delete</option>
              <option :value="0x28">Enter</option>
            </select></label
          >
          <label class="text-sm"
            >Repeat for (seconds)<input
              v-model.number="duration"
              class="kvm-input mt-1 w-full"
              type="number"
              min="1"
              max="300"
          /></label>
        </div>
        <details class="mt-3">
          <summary class="cursor-pointer text-sm text-mist-300">
            Key timing
          </summary>
          <div class="mt-3 grid grid-cols-3 gap-2">
            <label class="text-xs"
              >Delay (ms)<input
                v-model.number="delay"
                class="kvm-input mt-1 w-full"
                type="number"
                min="0"
                max="120000" /></label
            ><label class="text-xs"
              >Press (ms)<input
                v-model.number="press"
                class="kvm-input mt-1 w-full"
                type="number"
                min="20"
                max="2000" /></label
            ><label class="text-xs"
              >Interval (ms)<input
                v-model.number="interval"
                class="kvm-input mt-1 w-full"
                type="number"
                :min="press + 10"
                max="10000"
            /></label>
          </div>
        </details>
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            class="kvm-btn"
            :disabled="macroBusy || !kvm.link.connected.value"
            @click="boot(repeatActive)"
          >
            {{
              macroBusy
                ? repeat.pending.value === 'stop'
                  ? 'Stopping…'
                  : 'Starting…'
                : repeatActive
                  ? 'Stop and release key'
                  : 'Start repeating'
            }}
          </button>
        </div>
        <p class="kvm-hint mt-2">
          {{
            repeatActive
              ? connected
                ? 'Repeating'
                : 'Armed for the selected duration'
              : 'Not repeating'
          }}.<template v-if="!kvm.link.connected.value">
            Connect Serial, Bluetooth or Wi-Fi control to use this feature.
          </template>
        </p>
      </details>
      <p class="kvm-hint mt-5">
        <NuxtLink class="underline underline-offset-2" to="/docs"
          >Virtual media guide</NuxtLink
        >
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
.media-choice[aria-pressed='true'] {
  color: var(--color-signal-400);
  border-color: var(--color-signal-400);
  background: color-mix(
    in srgb,
    var(--color-signal-400) 10%,
    var(--color-ink-850)
  );
}
.kvm-media th {
  font-weight: 500;
  padding-bottom: 0.5rem;
}
</style>
