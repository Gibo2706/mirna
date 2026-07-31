import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const workerRoot = new URL('./', import.meta.url).pathname;

export default defineConfig({
  root: workerRoot,
  plugins: [
    cloudflareTest(async () => ({
      wrangler: {
        configPath: new URL('./wrangler.jsonc', import.meta.url).pathname,
      },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            new URL('./migrations', import.meta.url).pathname,
          ),
        },
      },
    })),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
