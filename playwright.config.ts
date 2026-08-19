import { defineConfig, devices } from '@playwright/test';

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  testIgnore: 'sync.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: externalBaseUrl ?? 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'Mobile Chrome',
      use: {
        ...devices['Pixel 7'],
        timezoneId: 'Europe/Belgrade',
      },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command:
          'VITE_MIRNA_SYNC_ENABLED=false VITE_MIRNA_SYNC_API_URL= VITE_TURNSTILE_SITE_KEY= VITE_MIRNA_APP_ENV= VITE_MIRNA_BETA_ONLY=false npm run build && npm run preview -- --host 127.0.0.1',
        url: 'http://127.0.0.1:4173',
        // Never attach a release gate to an unrelated/stale preview process.
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
