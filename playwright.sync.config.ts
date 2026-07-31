import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'sync.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 180_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [['list']],
  outputDir: 'test-results/sync',
  use: {
    baseURL: 'http://localhost:4173',
    serviceWorkers: 'allow',
    timezoneId: 'Europe/Belgrade',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'Encrypted sync multi-context gate',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
  webServer: [
    {
      command: 'node scripts/run-sync-e2e-worker.mjs',
      url: 'http://localhost:8787/v1/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node scripts/run-sync-e2e-apps.mjs',
      url: 'http://localhost:4173',
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
