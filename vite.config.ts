/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const legalAssets = (): Plugin => ({
  name: 'mirna-legal-assets',
  apply: 'build',
  buildStart() {
    for (const fileName of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      this.emitFile({
        type: 'asset',
        fileName,
        source: readFileSync(new URL(fileName, import.meta.url), 'utf8'),
      });
    }
  },
});

export default defineConfig({
  plugins: [
    legalAssets(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: [
        'app-icon.svg',
        'apple-touch-icon.png',
        'pwa-192x192.png',
        'pwa-512x512.png',
        'pwa-maskable-512x512.png',
      ],
      manifest: {
        name: 'Mirna — lične finansije',
        short_name: 'Mirna',
        description: 'Privatni lokalni plan ličnih finansija.',
        theme_color: '#171a18',
        background_color: '#f6f6f3',
        display: 'standalone',
        id: '/',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        lang: 'sr-Latn',
        categories: ['finance', 'productivity'],
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html}'],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    css: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'src/domain/**/*.ts',
        'src/features/export/**/*.ts',
        'src/features/ai-plan/{blueprint,patch}.ts',
        'src/features/onboarding/genericSetup.ts',
        'src/db/commands.ts',
      ],
    },
  },
});
