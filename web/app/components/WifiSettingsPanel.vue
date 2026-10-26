<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { useKvm } from '~/composables/useKvm'
import { useVirtualMedia } from '~/composables/useVirtualMedia'
import {
  WifiClient,
  WIFI_FIELD,
  type WifiMode,
  type WifiStatus,
} from '~/utils/wifi'
const modeId = useId()
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
  kvm.link.connecting.value
    ? 'Connecting to board…'
    : busy.value && !loaded.value
      ? 'Reading board settings…'
      : !kvm.link.connected.value
        ? 'Control link disconnected'
        : status.value?.pending
          ? 'Applying saved settings…'
          : [
              'Wi-Fi off',
              'Hotspot active',
              'Joining network…',
              'Connected',
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
    if (mode.value === 2 && !staPassword.value && !hasStaPassword.value)
      throw new Error(
        'Enter the network password. Open networks are not supported.',
      )
    await client.apply({
      mode: mode.value,
      recovery: recovery.value,
      apSsid: apSsid.value,
      staSsid: staSsid.value,
      apPassword: apPassword.value || undefined,
      staPassword: staPassword.value || undefined,
      token: token.value || undefined,
    })
    notice.value = 'Settings saved. Reconnecting Wi-Fi…'
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
  <section class="space-y-4" aria-label="Wi-Fi configuration">
    <div
      class="flex items-start justify-between gap-3 rounded border border-ink-600 p-3"
    >
      <div class="min-w-0 space-y-1">
        <p role="status" class="text-sm font-medium">{{ stateLabel }}</p>
        <p
          v-if="kvm.link.connected.value && status?.clientIp"
          class="font-mono text-xs"
        >
          {{ status.clientIp }}
        </p>
        <p
          v-else-if="kvm.link.connected.value && status?.apIp"
          class="font-mono text-xs"
        >
          {{ status.apIp }}
        </p>
        <p v-if="!kvm.link.connected.value" class="kvm-hint">
          Connect to the board to change its Wi-Fi settings.
        </p>
      </div>
      <button
        v-if="kvm.link.connected.value"
        type="button"
        class="kvm-btn shrink-0"
        :disabled="busy"
        @click="load()"
      >
        {{ loaded ? 'Reload' : 'Load settings' }}
      </button>
    </div>
    <div v-if="!kvm.link.connected.value" class="flex flex-wrap gap-2">
      <button
        type="button"
        class="kvm-btn kvm-btn-primary"
        :disabled="busy || !kvm.link.serialSupported.value"
        @click="connect('serial')"
      >
        Connect Serial
      </button>
      <button
        type="button"
        class="kvm-btn"
        :disabled="busy || !kvm.link.bleSupported.value"
        @click="connect('ble')"
      >
        Connect Bluetooth
      </button>
    </div>
    <p v-if="error" role="alert" class="text-sm text-alert-400">{{ error }}</p>
    <p v-if="notice && status?.pending" class="kvm-hint">{{ notice }}</p>
    <template v-if="loaded">
      <p v-if="status?.state === 4" class="text-sm text-alert-400">
        Couldn't join the network. Check the name and password, then save to
        retry.
      </p>
      <fieldset
        class="space-y-4"
        :disabled="locked || !kvm.link.connected.value"
      >
        <legend class="sr-only">Saved network settings</legend>
        <div class="space-y-1">
          <label class="block text-sm" :for="modeId">Wi-Fi mode</label>
          <select :id="modeId" v-model.number="mode" class="kvm-select w-full">
            <option :value="0">Off</option>
            <option :value="1">Hotspot</option>
            <option :value="2">Client</option>
          </select>
          <p class="kvm-hint">
            {{
              mode === 2
                ? 'Join an existing 2.4 GHz Wi-Fi network.'
                : mode === 1
                  ? 'Create a Wi-Fi network for this board.'
                  : 'Wi-Fi is disabled. Serial and Bluetooth remain available.'
            }}
          </p>
        </div>
        <div v-if="mode === 2" class="space-y-3">
          <label class="block text-sm">
            Network name (SSID)
            <input
              v-model="staSsid"
              class="kvm-input mt-1 w-full"
              autocomplete="off"
              maxlength="32"
            />
          </label>
          <label class="block text-sm">
            Password
            <input
              v-model="staPassword"
              type="password"
              class="kvm-input mt-1 w-full"
              autocomplete="new-password"
              maxlength="63"
              :placeholder="
                hasStaPassword
                  ? 'Leave blank to keep saved password'
                  : 'Enter network password'
              "
            />
          </label>
          <label class="flex items-start gap-2 text-sm">
            <input v-model="recovery" type="checkbox" class="mt-1" />
            <span>
              Keep a recovery hotspot
              <span class="kvm-hint mt-1 block"
                >Connect to the board even if this network is unavailable.</span
              >
            </span>
          </label>
        </div>
        <component
          :is="mode === 1 ? 'div' : 'details'"
          v-if="mode === 1 || (mode === 2 && recovery)"
          :key="mode"
          class="space-y-3"
        >
          <summary
            v-if="mode === 2"
            class="cursor-pointer text-sm text-mist-300"
          >
            Recovery hotspot settings
          </summary>
          <label class="block text-sm">
            {{ mode === 1 ? 'Network name (SSID)' : 'Hotspot name (SSID)' }}
            <input
              v-model="apSsid"
              class="kvm-input mt-1 w-full"
              autocomplete="off"
              maxlength="32"
            />
          </label>
          <label class="block text-sm">
            {{ mode === 1 ? 'Password' : 'Hotspot password' }}
            <input
              v-model="apPassword"
              type="password"
              class="kvm-input mt-1 w-full"
              autocomplete="new-password"
              maxlength="63"
              placeholder="Leave blank to keep saved password"
            />
          </label>
          <button
            type="button"
            class="kvm-btn"
            @click="secret(WIFI_FIELD.AP_PASSWORD)"
          >
            Show saved password
          </button>
          <p v-if="shownApPassword" class="break-all font-mono text-xs">
            {{ shownApPassword }}
          </p>
        </component>
        <p v-if="mode === 2 && !recovery" class="kvm-hint">
          Use Serial or Bluetooth to reconnect if Wi-Fi setup fails.
        </p>
        <p
          v-if="
            mode === 2 && recovery && status?.clientIp.startsWith('192.168.4.')
          "
          class="kvm-hint"
        >
          This network shares the recovery hotspot's address range. Disable
          recovery if connections fail.
        </p>
        <details class="border-t border-ink-600 pt-3">
          <summary class="cursor-pointer text-sm text-mist-300">
            Advanced
          </summary>
          <div class="mt-3 space-y-3">
            <div v-if="status" class="space-y-1 font-mono text-xs">
              <p>Client: {{ status.clientIp || 'not connected' }}</p>
              <p>Hotspot: {{ status.apIp || 'inactive' }}</p>
              <p v-if="status.state === 4">
                Reason {{ status.reason }} · Device error {{ status.error }}
              </p>
            </div>
            <div v-if="mode !== 0" class="space-y-3">
              <label class="block text-sm">
                Media access token
                <input
                  v-model="token"
                  type="password"
                  class="kvm-input mt-1 w-full"
                  autocomplete="new-password"
                  maxlength="80"
                  placeholder="Leave blank to keep saved token"
                />
              </label>
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="kvm-btn"
                  @click="secret(WIFI_FIELD.TOKEN)"
                >
                  Show saved token
                </button>
                <button type="button" class="kvm-btn" @click="generateToken">
                  Generate new token
                </button>
              </div>
              <p v-if="shownToken" class="break-all font-mono text-xs">
                {{ shownToken }}
              </p>
              <p class="kvm-hint">
                Use this token and the board's IP address with the HTTPS media
                helper. After changing the token, update KVM_MEDIA_TOKEN in the
                helper.
              </p>
            </div>
            <p class="kvm-hint">
              WPA2 or better is required. Enterprise Wi-Fi is not supported.
            </p>
          </div>
        </details>
        <div class="border-t border-ink-600 pt-3">
          <button type="button" class="kvm-btn kvm-btn-primary" @click="save">
            {{ busy ? 'Saving…' : 'Save and apply' }}
          </button>
        </div>
      </fieldset>
      <p v-if="media.inserted.value || media.uncertain.value" class="kvm-hint">
        Eject and synchronize the virtual disk before changing Wi-Fi.
      </p>
    </template>
  </section>
</template>
