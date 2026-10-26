<script setup lang="ts">
// SPDX-License-Identifier: GPL-3.0-or-later
// /docs — a plain, prerendered document page. Unlike the KVM app itself this is
// not an overlay over live video: it scrolls, it renders server-side, and it
// pulls in none of the KVM composables.
import { useHead } from '#imports'

const REPO = 'https://github.com/thebentern/cheap-web-kvm'

interface DocLink {
  title: string
  blurb: string
  href: string
  cta: string
}

const links: DocLink[] = [
  {
    title: 'Virtual media and FAT32 file sharing (experimental)',
    blurb: 'Stream a local boot image, create a FAT32 thumb drive, save target writes, export files, and arm F12 repetition. Includes Wi-Fi helper setup and outstanding hardware checks.',
    href: `${REPO}/blob/main/docs/VIRTUAL_MEDIA.md`,
    cta: 'Virtual media guide',
  },
  {
    title: 'CH9329 wire protocol',
    blurb:
      'Frame format, checksums, HID commands, boot repetition, the versioned media protocol, and how replies are parsed. Written from the bytes on the wire rather than from the datasheet — the firmware parser is written against it.',
    href: `${REPO}/blob/main/docs/PROTOCOL.md`,
    cta: 'docs/PROTOCOL.md',
  },
  {
    title: 'Hardware and setup',
    blurb:
      'Parts list, port wiring, the bring-up checks worth doing before you plug anything into the target, and how to build and flash the ESP32-S3 firmware with ESP-IDF.',
    href: `${REPO}#hardware`,
    cta: 'README',
  },
  {
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
  title: string
  detail: string
}

const requirements: Requirement[] = [
  {
    title: 'A Chromium-based browser, or Bluefy on iPad',
    detail:
      'Chrome, Edge, Brave or Opera, over Web Serial or Web Bluetooth. Firefox and Safari have neither, so the control half of the KVM cannot work there — video alone still would. On an iPad, use a Web Bluetooth browser such as Bluefy; Safari there shows the capture stick fine on iPadOS 17 and later.',
  },
  {
    title: 'A secure context',
    detail:
      'HTTPS, or http://localhost. Web Serial, Web Bluetooth and getUserMedia all refuse to hand out devices on a plain-HTTP origin.',
  },
  {
    title: 'An ESP32-S3 running the CH9329-compatible firmware',
    detail:
      'Serial at 115200 8N1, no flow control, over the board’s UART bridge port — or Bluetooth LE, paired once with a six-digit PIN you can change under Settings → Advanced. A genuine CH9329 module works too over serial, once it has been moved off its 9600 baud default.',
  },
  {
    title: 'An MS2130 HDMI capture stick',
    detail:
      '1080p60 with audio, and cleaner UVC descriptors than the alternative. An MS2109 also works, at 1080p30 — or 25 fps behind a hub.',
  },
]

useHead({
  title: '$KVM — Documentation',
  htmlAttrs: { 'data-theme': 'light' },
  meta: [
    { name: 'color-scheme', content: 'light' },
    { name: 'theme-color', content: '#f7f1e8' },
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
  <div class="site-page docs-page" data-theme="light">
    <header class="site-header">
      <NuxtLink to="/" aria-label="$KVM console" class="docs-brand"><BrandLogo /></NuxtLink>
      <nav class="site-nav" aria-label="Main navigation">
        <NuxtLink to="/">Console</NuxtLink>
        <NuxtLink to="/docs" aria-current="page">Docs</NuxtLink>
        <a :href="REPO" target="_blank" rel="noopener noreferrer">GitHub</a>
      </nav>
    </header>

    <main class="site-content docs-content">
      <header class="docs-intro">
        <p class="docs-eyebrow">Documentation</p>
        <h1>Using $KVM</h1>
        <p class="docs-lead">Keyboard, mouse and video from your browser.</p>
        <p>
          Video and audio arrive from a USB capture stick. Keystrokes and pointer movement
          travel over Web Serial or Bluetooth to an ESP32-S3, which the target sees as a
          USB keyboard and mouse. It works without a server, software on the target, or
          an internet connection.
        </p>
      </header>

      <section class="docs-section" aria-labelledby="reference-title">
        <h2 id="reference-title">Reference</h2>
        <div class="docs-references">
          <NuxtLink to="/flash" class="docs-reference">
            <span class="docs-reference-title">Install firmware<AppIcon name="chevron-right" aria-hidden="true" /></span>
            <span class="docs-reference-description">Flash the packaged $KVM firmware on an ESP32-S3-DevKitC-1-N8R8 from desktop Chrome or Edge, using its UART USB port. Existing Bluetooth PIN and pairings are preserved.</span>
            <span class="docs-path">Browser installer</span>
          </NuxtLink>
          <a
            v-for="link in links"
            :key="link.href"
            class="docs-reference"
            :href="link.href"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span class="docs-reference-title">
              {{ link.title }}
              <AppIcon name="chevron-right" aria-hidden="true" />
            </span>
            <span class="docs-reference-description">{{ link.blurb }}</span>
            <span class="docs-path">{{ link.cta }}</span>
          </a>
        </div>
      </section>

      <section class="docs-section" aria-labelledby="wiring-title">
        <h2 id="wiring-title">How it connects</h2>
        <p>
          Control and video take separate paths. Control goes from the laptop through the
          ESP32-S3 to the target’s USB port. Video goes from the target’s HDMI port through
          the capture stick to the laptop.
        </p>
        <div class="docs-topology" tabindex="0" role="region" aria-label="Connection diagram">
          <pre>{{ topology }}</pre>
        </div>
        <p class="docs-note">
          Port order varies between board revisions. On a blank ESP32-S3, only the UART
          bridge appears as a serial device; use that to identify the two USB-C ports.
        </p>
      </section>

      <section class="docs-section" aria-labelledby="requirements-title">
        <h2 id="requirements-title">What you need</h2>
        <dl class="docs-requirements">
          <div v-for="req in requirements" :key="req.title">
            <dt>{{ req.title }}</dt>
            <dd>{{ req.detail }}</dd>
          </div>
        </dl>
      </section>

      <section class="docs-section" aria-labelledby="credits-title">
        <h2 id="credits-title">Heavily inspired by DezKVM-Go</h2>
        <!-- The web interface is tobychui's work; see NOTICE in the repository. -->
        <p>
          cheap-web-kvm is a fork of
          <a href="https://github.com/tobychui/DezKVM-Go" target="_blank" rel="noopener noreferrer">DezKVM-Go</a>,
          by tobychui. The web interface originates from that project: settings, the paste
          box, OCR copy, the on-screen keyboard, quick access, screen recording, stacked
          keys and CH9329 byte serialisation. This fork adds ESP32-S3 firmware, MS2130
          capture support and the current theme.
        </p>
      </section>

      <!-- GPLv3 section 5(d): Appropriate Legal Notices. -->
      <section class="docs-section docs-licence" aria-labelledby="licence-title">
        <h2 id="licence-title">Licence</h2>
        <p class="docs-copyright">cheap-web-kvm — Copyright (C) 2026 Ben Meadors<br />DezKVM-Go — Copyright (C) tobychui</p>
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
        <p class="docs-legal-links">
          <a :href="REPO" target="_blank" rel="noopener noreferrer">Source code</a>
          <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noopener noreferrer">Full GPLv3 text</a>
        </p>
        <p class="docs-note">
          The complete corresponding source for this interface, including the modifications
          to DezKVM-Go, is linked above. Hardware designs inherited from the upstream project
          remain under CC BY-NC-ND 4.0.
        </p>
      </section>
    </main>

    <footer class="site-footer docs-footer">
      <span>$KVM <span class="docs-footer-project">/ cheap-web-kvm</span></span>
      <NuxtLink to="/">Open console <span aria-hidden="true">→</span></NuxtLink>
    </footer>
  </div>
</template>

<style scoped>
.docs-brand {
  display: inline-flex;
  flex: none;
  align-items: center;
}

.docs-content {
  width: min(100% - 48px, 760px);
  margin-inline: auto;
  padding-block: 64px 72px;
}

.docs-intro {
  margin-bottom: 48px;
}

.docs-eyebrow {
  margin: 0 0 16px;
  color: var(--color-mist-400);
  font-size: 13px;
  font-weight: 600;
}

.docs-intro h1 {
  margin: 0;
  color: var(--color-mist-100);
  font-size: 36px;
  line-height: 1.2;
  font-weight: 650;
  letter-spacing: -0.035em;
}

.docs-content p,
.docs-requirements dd {
  max-width: 68ch;
  margin: 16px 0 0;
  font-size: 16px;
  line-height: 1.65;
}

.docs-intro .docs-lead {
  margin-top: 20px;
  color: var(--color-mist-100);
  font-size: 19px;
  line-height: 1.5;
}

.docs-content .docs-eyebrow {
  margin-top: 0;
  margin-bottom: 16px;
  font-size: 13px;
}

.docs-section {
  margin-top: 40px;
  border-top: 1px solid var(--color-ink-600);
  padding-top: 28px;
}

.docs-section h2 {
  margin: 0 0 20px;
  color: var(--color-mist-100);
  font-size: 24px;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.025em;
}

.docs-content a,
.docs-footer a {
  color: var(--color-signal-400);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.docs-content a:hover,
.docs-footer a:hover {
  text-decoration-thickness: 2px;
}

.docs-references {
  display: grid;
}

.docs-content .docs-reference {
  display: grid;
  gap: 7px;
  padding-block: 19px;
  color: inherit;
  text-decoration: none;
}

.docs-reference + .docs-reference {
  border-top: 1px solid var(--color-ink-700);
}

.docs-reference:first-child {
  padding-top: 0;
}

.docs-reference-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  color: var(--color-signal-400);
  font-size: 16px;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.docs-reference:hover .docs-reference-title {
  text-decoration-thickness: 2px;
}

.docs-reference-description {
  max-width: 68ch;
  font-size: 15px;
  line-height: 1.6;
}

.docs-path {
  color: var(--color-mist-400);
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 12px;
}

.docs-topology {
  overflow-x: auto;
  margin-top: 24px;
  border: 1px solid var(--color-ink-600);
  border-radius: 8px;
  background: var(--color-ink-900);
  padding: 24px 20px;
}

.docs-topology pre {
  width: max-content;
  margin: 0;
  color: var(--color-mist-100);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.8;
}

.docs-content .docs-note {
  color: var(--color-mist-400);
  font-size: 14px;
  line-height: 1.65;
}

.docs-requirements {
  display: grid;
  gap: 24px;
  margin: 0;
}

.docs-requirements dt {
  color: var(--color-mist-100);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
}

.docs-requirements dd {
  margin-top: 6px;
  font-size: 15px;
}

.docs-licence p {
  font-size: 14px;
}

.docs-licence .docs-copyright {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.8;
}

.docs-legal-links {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.docs-footer-project {
  color: var(--color-mist-400);
}

@media (max-width: 600px) {
  .docs-content {
    width: calc(100% - 40px);
    padding-block: 40px 48px;
  }

  .docs-intro h1 {
    font-size: 32px;
  }

  .docs-intro {
    margin-bottom: 36px;
  }

  .docs-section {
    margin-top: 32px;
    padding-top: 24px;
  }
}
</style>
