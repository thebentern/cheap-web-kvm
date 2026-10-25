// SPDX-License-Identifier: GPL-3.0-or-later
import tailwindcss from '@tailwindcss/vite'

// Project-site hosting: https://thebentern.github.io/cheap-web-kvm/
// Override with NUXT_APP_BASE_URL=/ when serving from a domain root or from the
// bundled Go server.
const baseURL = process.env.NUXT_APP_BASE_URL ?? '/cheap-web-kvm/'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },

  app: {
    baseURL,
    head: {
      htmlAttrs: { lang: 'en', class: 'dark' },
      title: '$KVM · Browser console',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1, shrink-to-fit=no' },
        { name: 'color-scheme', content: 'dark' },
        { name: 'theme-color', content: '#211c18' },
        {
          name: 'description',
          content: 'Browser-based USB KVM for headless machines — keyboard, mouse and video over Web Serial.',
        },
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: `${baseURL}brand/favicon.svg` }],
    },
  },

  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },

  // The control surface is entirely client-side (Web Serial, getUserMedia), so
  // it renders inside <ClientOnly>. The docs route prerenders as real HTML.
  ssr: true,
  nitro: {
    prerender: { crawlLinks: true, routes: ['/', '/docs'] },
  },

  typescript: { strict: true },
})
