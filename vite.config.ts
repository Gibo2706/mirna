/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
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

const betaSearchProtection = (enabled: boolean): Plugin => ({
  name: 'mirna-beta-search-protection',
  apply: 'build',
  transformIndexHtml() {
    if (!enabled) return [];
    return [
      {
        tag: 'meta',
        attrs: { name: 'robots', content: 'noindex, nofollow' },
        injectTo: 'head',
      },
    ];
  },
  generateBundle() {
    if (!enabled) return;
    this.emitFile({
      type: 'asset',
      fileName: 'robots.txt',
      source: 'User-agent: *\nDisallow: /\n',
    });
  },
});

export default defineConfig(({ mode }) => {
  const fileEnvironment = loadEnv(mode, process.cwd(), 'VITE_');
  const appEnvironment = process.env.VITE_MIRNA_APP_ENV ?? fileEnvironment.VITE_MIRNA_APP_ENV;
  const betaOnly = process.env.VITE_MIRNA_BETA_ONLY ?? fileEnvironment.VITE_MIRNA_BETA_ONLY;
  const betaApplication =
    betaOnly === 'true' && (appEnvironment === 'beta' || appEnvironment === 'local-beta');

  return {
    plugins: [
      legalAssets(),
      betaSearchProtection(betaApplication),
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
      exclude: ['e2e/**', 'services/sync-worker/test/**', 'node_modules/**', 'dist/**'],
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
  };
});
