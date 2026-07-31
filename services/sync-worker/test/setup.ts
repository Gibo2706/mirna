import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.MIRNA_SYNC_DB, env.TEST_MIGRATIONS, 'mirna_d1_migrations');
});
