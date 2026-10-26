<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useKvm } from '~/composables/useKvm'
import { useVirtualMedia } from '~/composables/useVirtualMedia'
import {
  WifiClient,
  WIFI_FIELD,
  type WifiMode,
  type WifiStatus,
} from '~/utils/wifi'
const kvm = useKvm(),
  media = useVirtualMedia(),
  client = new WifiClient((f, c) => kvm.link.sendAndWait(f, c))
const busy = ref(false),
  loaded = ref(false),
  error = ref(''),
  notice = ref(''),
  mode = ref<WifiMode>(0),
  recovery = ref(true)
const apSsid = ref(''),
  staSsid = ref(''),
  apPassword = ref(''),
  staPassword = ref(''),
  token = ref(''),
  shownToken = ref(''),
  shownApPassword = ref(''),
  openNetwork = ref(false),
  hasStaPassword = ref(false)
const status = ref<WifiStatus | null>(null)
const locked = computed(
  () =>
    busy.value ||
    !!status.value?.pending ||
    media.inserted.value ||
    media.uncertain.value ||
    media.busy.value,
)
const stateLabel = computed(() =>
  busy.value && !loaded.value
    ? 'Reading board settings…'
    : !kvm.link.connected.value
      ? 'Control link disconnected'
      : status.value?.pending
        ? 'Applying saved settings…'
        : [
            'Wi-Fi off',
            'Hotspot active',
            'Joining router…',
            'Connected to router',
            'Connection failed',
          ][status.value?.state ?? 0],
)
let timer: ReturnType<typeof setInterval> | undefined,
  disposed = false
async function act(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function load() {
  await act(async () => {
    const c = await client.ready()
    if (disposed) return
    mode.value = c.mode
    recovery.value = c.recovery
    apSsid.value = c.apSsid
    staSsid.value = c.staSsid
    hasStaPassword.value = c.staPasswordSet
    openNetwork.value = c.mode === 2 && !c.staPasswordSet
    apPassword.value = ''
    staPassword.value = ''
    token.value = ''
    shownToken.value = ''
    shownApPassword.value = ''
    status.value = await client.status()
    loaded.value = true
  })
}
async function connect(which: 'serial' | 'ble') {
  await act(async () => {
    if (!(await kvm.link.connect(which)))
      throw new Error(kvm.link.lastError.value ?? 'Connection was cancelled')
  })
  if (kvm.link.connected.value) await load()
}
async function save() {
  await act(async () => {
    if (media.inserted.value || media.uncertain.value)
      throw new Error(
        'Eject and synchronize virtual media before changing Wi-Fi.',
      )
    if (
      mode.value === 2 &&
      !openNetwork.value &&
      !staPassword.value &&
      !hasStaPassword.value
    )
      throw new Error(
        'Enter the network password or explicitly select an open network.',
      )
    await client.apply({
      mode: mode.value,
      recovery: recovery.value,
      apSsid: apSsid.value,
      staSsid: staSsid.value,
      apPassword: apPassword.value || undefined,
      staPassword: openNetwork.value ? '' : staPassword.value || undefined,
      token: token.value || undefined,
    })
    notice.value =
      'Saved on the board. Wi-Fi changes now; USB keyboard/mouse stay connected. Client mode obtains its address automatically. Keep Serial/Bluetooth connected to see status.'
    apPassword.value = ''
    staPassword.value = ''
    token.value = ''
    shownToken.value = ''
    shownApPassword.value = ''
    if (kvm.link.kind.value === 'wifi') await media.disconnect()
    else {
      hasStaPassword.value = (await client.config()).staPasswordSet
      status.value = await client.status()
    }
  })
}
async function secret(field: number) {
  await act(async () => {
    const value = await client.field(field)
    if (field === WIFI_FIELD.TOKEN) shownToken.value = value
    else shownApPassword.value = value
  })
}
function generateToken() {
  const b = crypto.getRandomValues(new Uint8Array(24))
  token.value = [...b].map((n) => n.toString(16).padStart(2, '0')).join('')
}
onMounted(() => {
  if (kvm.link.connected.value) void load()
  timer = setInterval(() => {
    if (loaded.value && !busy.value && kvm.link.connected.value)
      void client
        .status()
        .then((value) => {
          if (!disposed) status.value = value
        })
        .catch((e) => {
          if (!disposed && !error.value) error.value = (e as Error).message
        })
  }, 2000)
})
onBeforeUnmount(() => {
  disposed = true
  if (timer) clearInterval(timer)
  apPassword.value = ''
  staPassword.value = ''
  token.value = ''
  shownToken.value = ''
  shownApPassword.value = ''
})
</script>
<template>
  <section class="space-y-3" aria-label="Wi-Fi configuration">
    <p class="kvm-hint">
      Hotspot creates the board’s own Wi-Fi network. Client joins your
      existing 2.4 GHz personal Wi-Fi network. Neither uses ad-hoc mode.
      Settings are saved on the board.
    </p>
    <div class="flex flex-wrap gap-2">
      <button
        class="kvm-btn"
        :disabled="busy || !kvm.link.serialSupported.value"
        @click="connect('serial')"
      >
        Connect Serial for setup
      </button>
      <button
        class="kvm-btn"
        :disabled="busy || !kvm.link.bleSupported.value"
        @click="connect('ble')"
      >
        Connect Bluetooth for setup
      </button>
      <button
        class="kvm-btn"
        :disabled="busy || !kvm.link.connected.value"
        @click="load()"
      >
        Load board settings
      </button>
    </div>
    <p role="status" class="text-sm">{{ stateLabel }}</p>
    <p v-if="error" role="alert" class="text-sm text-alert-400">{{ error }}</p>
    <p v-if="notice" class="kvm-hint">{{ notice }}</p>
    <p v-if="!loaded" class="kvm-hint">
      Connect through the UART/programming port or pair over Bluetooth, then
      load settings. Older firmware needs an update before these controls work.
    </p>
    <template v-else>
      <p v-if="status?.apIp || status?.clientIp" class="text-sm">
        Hotspot IP: {{ status?.apIp || 'inactive' }} · Client IP:
        {{ status?.clientIp || 'not connected' }}
      </p>
      <p
        v-if="
          mode === 2 && recovery && status?.clientIp.startsWith('192.168.4.')
        "
        class="kvm-hint"
      >
        The router and recovery hotspot share the 192.168.4.x subnet. Disable
        recovery and use Serial/Bluetooth if routing fails.
      </p>
      <p v-if="status?.state === 4" class="kvm-hint">
        Check the network name, password, signal and 2.4 GHz support. The board
        stops retrying after five retries; Save and apply retries. Reason
        {{ status?.reason }}, device error {{ status?.error }}.
      </p>
      <fieldset
        class="space-y-3"
        :disabled="locked || !kvm.link.connected.value"
      >
        <legend class="sr-only">Saved network settings</legend>
        <label class="block text-sm"
          >Wi-Fi mode<select
            v-model.number="mode"
            class="kvm-select mt-1 w-full"
          >
            <option :value="0">Off</option>
            <option :value="1">Hotspot (access point)</option>
            <option :value="2">Client</option>
          </select></label
        >
        <div
          v-if="mode === 2"
          class="space-y-3 rounded border border-ink-600 p-3"
        >
          <label class="block text-sm"
            >Network name (SSID)<input
              v-model="staSsid"
              class="kvm-input mt-1 w-full"
              autocomplete="off"
              maxlength="32"
          /></label>
          <label class="block text-sm"
            >Network password<input
              v-model="staPassword"
              type="password"
              class="kvm-input mt-1 w-full"
              autocomplete="new-password"
              maxlength="63"
              :disabled="openNetwork"
              :placeholder="
                hasStaPassword
                  ? 'Leave blank to keep saved password'
                  : 'Enter network password'
              "
          /></label>
          <label class="block text-sm"
            ><input v-model="openNetwork" type="checkbox" /> This is an open
            network (no password)</label
          >
          <label class="block text-sm"
            ><input v-model="recovery" type="checkbox" /> Keep recovery hotspot
            available while joining/using the router</label
          >
          <p class="kvm-hint">
            Recovery hotspot stays available even if the router password is
            wrong. With it disabled, use Serial or Bluetooth to recover.
            Enterprise Wi-Fi is not supported.
          </p>
        </div>
        <component
          :is="mode === 1 ? 'div' : 'details'"
          v-if="mode === 1 || (mode === 2 && recovery)"
          :key="mode"
          class="space-y-3 rounded border border-ink-600 p-3"
        >
          <summary v-if="mode === 2" class="cursor-pointer text-sm">
            Recovery hotspot settings
          </summary>
          <label class="block text-sm"
            >Hotspot network name (SSID)<input
              v-model="apSsid"
              class="kvm-input mt-1 w-full"
              autocomplete="off"
              maxlength="32"
          /></label>
          <label class="block text-sm"
            >New hotspot password<input
              v-model="apPassword"
              type="password"
              class="kvm-input mt-1 w-full"
              autocomplete="new-password"
              maxlength="63"
              placeholder="Leave blank to keep saved password"
          /></label>
          <button class="kvm-btn" @click="secret(WIFI_FIELD.AP_PASSWORD)">
            Show saved hotspot password
          </button>
          <p v-if="shownApPassword" class="break-all font-mono text-xs">
            {{ shownApPassword }}
          </p>
        </component>
        <label class="block text-sm"
          >New helper access token<input
            v-model="token"
            type="password"
            class="kvm-input mt-1 w-full"
            autocomplete="new-password"
            maxlength="80"
            placeholder="Leave blank to keep saved token"
        /></label>
        <div class="flex flex-wrap gap-2">
          <button class="kvm-btn" @click="generateToken">
            Generate replacement token</button
          ><button class="kvm-btn" @click="secret(WIFI_FIELD.TOKEN)">
            Show saved helper token
          </button>
        </div>
        <p v-if="shownToken" class="break-all font-mono text-xs">
          {{ shownToken }}
        </p>
        <p class="kvm-hint">
          The router password is never read back. Hotspot passwords and helper
          tokens are shown only on request; they are not saved in browser
          settings. Changing the token also requires updating KVM_MEDIA_TOKEN
          for the HTTPS helper.
        </p>
        <button class="kvm-btn" @click="save">Save and apply Wi-Fi</button>
      </fieldset>
      <p v-if="media.inserted.value || media.uncertain.value" class="kvm-hint">
        Eject and synchronize the virtual disk before changing the network.
      </p>
      <p class="kvm-hint">
        For media, point the local HTTPS helper at the hotspot IP or router IP
        shown above, then reconnect the media backend. Saving over Wi-Fi
        disconnects that link; Serial/Bluetooth setup avoids losing control.
      </p>
    </template>
  </section>
</template>
