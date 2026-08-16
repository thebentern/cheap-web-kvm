<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
// /docs — a plain, prerendered document page. Unlike the KVM app itself this is
// not an overlay over live video: it scrolls, it renders server-side, and it
// pulls in none of the KVM composables.
import { useHead } from '#imports'

const REPO = 'https://github.com/thebentern/cheap-web-kvm'

interface DocLink {
  icon: string
  title: string
  blurb: string
  href: string
  cta: string
}

const links: DocLink[] = [
  {
    icon: 'terminal',
    title: 'CH9329 wire protocol',
    blurb:
      'Frame format, checksums, the four commands this UI actually emits, and how replies are parsed. Written from the bytes on the wire rather than from the datasheet — the firmware parser is written against it.',
    href: `${REPO}/blob/main/docs/PROTOCOL.md`,
    cta: 'docs/PROTOCOL.md',
  },
  {
    icon: 'wrench',
    title: 'Hardware and setup',
    blurb:
      'Parts list, port wiring, the bring-up checks worth doing before you plug anything into the target, and how to build and flash the ESP32-S3 firmware with ESP-IDF.',
    href: `${REPO}#hardware`,
    cta: 'README',
  },
  {
    icon: 'github',
    title: 'Source repository',
    blurb:
      'The complete corresponding source for this interface and the firmware, plus the change list against the upstream DezKVM-Go project.',
    href: REPO,
    cta: 'thebentern/cheap-web-kvm',
  },
]

/* Kept as a string rather than inline markup so the box-drawing characters and
 * the column alignment survive template whitespace handling untouched. */
const topology = `  laptop ──USB-C──> [UART port: CP2102N/CH340] ─UART0─┐
                                                      ├── ESP32-S3 ──USB HID──> target
  target <──USB-C── [USB port: native OTG, GPIO19/20] ┘

  target ──HDMI──> MS2130 ──USB-A──> laptop     (independent, no firmware involvement)`

interface Requirement {
  icon: string
  title: string
  detail: string
}

const requirements: Requirement[] = [
  {
    icon: 'monitor',
    title: 'A Chromium-based browser',
    detail:
      'Chrome, Edge, Brave or Opera. Web Serial is not implemented in Firefox or Safari, so the control half of the KVM cannot work there — video alone still would.',
  },
  {
    icon: 'lock',
    title: 'A secure context',
    detail:
      'HTTPS, or http://localhost. Both Web Serial and getUserMedia refuse to hand out devices on a plain-HTTP origin.',
  },
  {
    icon: 'usb',
    title: 'An ESP32-S3 running the CH9329-compatible firmware',
    detail:
      'Serial at 115200 8N1, no flow control, over the board’s UART bridge port. A genuine CH9329 module works too, once it has been moved off its 9600 baud default.',
  },
  {
    icon: 'film',
    title: 'An MS2130 HDMI capture stick',
    detail:
      '1080p60 with audio, and cleaner UVC descriptors than the alternative. An MS2109 also works, at 1080p30 — or 25 fps behind a hub.',
  },
]

useHead({
  title: 'cheap-web-kvm — docs',
  meta: [
    {
      name: 'description',
      content:
        'How cheap-web-kvm is wired, what it needs from the browser, and where the wire protocol and hardware notes live.',
    },
  ],
  // The app shell sets `overflow: hidden` on <body> so the KVM stage can never
  // scroll behind its overlays. This page is an ordinary document, so hand the
  // scrollbar back for as long as the route is mounted.
  bodyAttrs: { style: 'overflow: auto; height: auto; min-height: 100%' },
})
</script>

<template>
  <div class="min-h-screen bg-ink-950 text-mist-200">
    <div class="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <NuxtLink to="/" class="kvm-btn">
        <AppIcon name="chevron-left" />
        Open the KVM app
      </NuxtLink>

      <header class="mt-8">
        <h1 class="text-3xl font-semibold tracking-tight text-mist-100 sm:text-4xl">
          cheap<span class="text-signal-400">-web-</span>kvm
        </h1>
        <p class="mt-4 text-sm leading-relaxed text-mist-400 sm:text-[15px]">
          A browser-based USB KVM for headless machines. Video and audio arrive from an ordinary
          UVC capture stick; keystrokes and pointer movement leave over Web Serial to an ESP32-S3
          speaking the CH9329 protocol, which the target sees as a plain USB keyboard and mouse.
          There is no server, no agent on the target and nothing to reach over the network — it
          works on a bench with no internet at all.
        </p>
      </header>

      <!-- Reference material -->
      <section class="mt-12">
        <h2 class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-signal-400">
          <AppIcon name="list" />
          Reference
        </h2>

        <div class="mt-4 grid gap-3">
          <a
            v-for="link in links"
            :key="link.href"
            class="group flex gap-3.5 rounded-xl border border-ink-600 bg-ink-900 p-4 transition-colors hover:border-signal-600 hover:bg-ink-850"
            :href="link.href"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span
              class="mt-0.5 flex size-8 flex-none items-center justify-center rounded-lg border border-ink-600 bg-ink-800 text-signal-400"
            >
              <AppIcon :name="link.icon" size="1.05rem" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5 text-[13px] font-semibold text-mist-100">
                {{ link.title }}
                <AppIcon
                  name="chevron-right"
                  class="text-mist-400 transition-transform group-hover:translate-x-0.5 group-hover:text-signal-400"
                />
              </span>
              <span class="kvm-hint mt-1 block">{{ link.blurb }}</span>
              <span class="mt-2 block truncate font-mono text-[11px] text-mist-400">{{ link.cta }}</span>
            </span>
          </a>
        </div>
      </section>

      <!-- Topology -->
      <section class="mt-12">
        <h2 class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-signal-400">
          <AppIcon name="usb" />
          Topology
        </h2>
        <p class="kvm-hint mt-2">
          Two independent paths. Control goes laptop → UART → ESP32-S3 → target USB; video goes
          target HDMI → capture stick → laptop, with no firmware involvement at all.
        </p>

        <div class="kvm-panel mt-4 overflow-x-auto p-4">
          <pre class="w-max font-mono text-[11px] leading-relaxed text-mist-200 sm:text-xs">{{ topology }}</pre>
        </div>

        <p class="kvm-hint mt-3">
          Port order is not guaranteed between board revisions: on a blank ESP32-S3 only the UART
          bridge enumerates as a serial device, which is the reliable way to tell the two USB-C
          ports apart.
        </p>
      </section>

      <!-- Requirements -->
      <section class="mt-12">
        <h2 class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-signal-400">
          <AppIcon name="check-circle" />
          Requirements
        </h2>

        <ul class="mt-4 space-y-2">
          <li
            v-for="req in requirements"
            :key="req.title"
            class="flex gap-3 rounded-lg border border-ink-600 bg-ink-900 p-3.5"
          >
            <AppIcon :name="req.icon" size="1.05rem" class="mt-0.5 flex-none text-signal-400" />
            <div class="min-w-0">
              <div class="text-[13px] font-semibold text-mist-100">{{ req.title }}</div>
              <p class="kvm-hint mt-1">{{ req.detail }}</p>
            </div>
          </li>
        </ul>
      </section>

      <!-- Attribution and licence -->
      <footer class="mt-14 border-t border-ink-700 pt-8">
        <!-- The web interface is tobychui's work; see NOTICE in the repository. -->
        <div class="rounded-lg border border-ink-600 bg-ink-900 p-4">
          <div class="flex items-center gap-2 text-[13px] font-semibold text-mist-100">
            <AppIcon name="github" />
            A fork of DezKVM-Go
          </div>
          <p class="kvm-hint mt-2">
            cheap-web-kvm is a fork of
            <strong class="font-medium text-mist-200">DezKVM-Go</strong>, by tobychui. The entire
            web interface originates from that project — the settings panel, the paste box, the OCR
            copy box, the on-screen keyboard, quick access, the screen recorder, stacked keys and
            the CH9329 byte serialisation. This fork adds the ESP32-S3 firmware, MS2130 capture
            support and the current theme.
          </p>
          <a
            class="kvm-btn mt-3"
            href="https://github.com/tobychui/DezKVM-Go"
            target="_blank"
            rel="noopener noreferrer"
          >
            <AppIcon name="github" />
            tobychui/DezKVM-Go
          </a>
        </div>

        <!-- GPLv3 section 5(d): Appropriate Legal Notices. -->
        <div class="mt-3 rounded-lg border border-ink-600 bg-ink-950 p-4">
          <div class="flex items-center gap-2 text-[13px] font-semibold text-mist-100">
            <AppIcon name="lock" />
            Licence
          </div>
          <div class="mt-2.5 space-y-2 font-mono text-[11px] leading-relaxed text-mist-400">
            <p>cheap-web-kvm — Copyright (C) 2026 Ben Meadors</p>
            <p>DezKVM-Go — Copyright (C) tobychui</p>
            <p>
              This program is free software: you can redistribute it and/or modify it under the
              terms of the GNU General Public License as published by the Free Software Foundation,
              either version 3 of the License, or (at your option) any later version.
            </p>
            <p>
              This program is distributed in the hope that it will be useful, but WITHOUT ANY
              WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
              PARTICULAR PURPOSE. See the GNU General Public License for more details.
            </p>
          </div>
          <div class="mt-3.5 flex flex-wrap gap-2">
            <a class="kvm-btn" :href="REPO" target="_blank" rel="noopener noreferrer">
              <AppIcon name="github" />
              Source code
            </a>
            <a
              class="kvm-btn"
              href="https://www.gnu.org/licenses/gpl-3.0.html"
              target="_blank"
              rel="noopener noreferrer"
            >
              <AppIcon name="folder" />
              Full GPLv3 text
            </a>
          </div>
          <p class="kvm-hint mt-3">
            The complete corresponding source for this interface, including the modifications made
            to DezKVM-Go, is at the link above. Hardware designs inherited from the upstream project
            remain under CC BY-NC-ND 4.0.
          </p>
        </div>

        <NuxtLink to="/" class="kvm-btn kvm-btn-primary mt-8">
          <AppIcon name="monitor" />
          Open the KVM app
        </NuxtLink>
      </footer>
    </div>
  </div>
</template>
