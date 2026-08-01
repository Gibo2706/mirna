import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { commitR2Object, reserveR2Object } from '../src/budget';
import { reconcileR2InventoryPage } from '../src/reconciliation';
import { SEEDED_VAULT_ID, seedVaultAndDevice } from './fixtures';

beforeAll(async () => {
  await seedVaultAndDevice(env, Date.now());
});

describe('R2 inventory reconciliation', () => {
  it('accepts an exact ciphertext inventory row and fails closed for an untracked object', async () => {
    const trackedKey = `v1/${SEEDED_VAULT_ID}/snapshots/tracked/hash`;
    await reserveR2Object(env, {
      objectKey: trackedKey,
      vaultId: SEEDED_VAULT_ID,
      objectType: 'snapshot',
      ciphertextBytes: 3,
    });
    await env.MIRNA_SYNC_BUCKET.put(trackedKey, new Uint8Array([1, 2, 3]));
    await commitR2Object(env, trackedKey);
    await expect(reconcileR2InventoryPage(env, 1_000)).resolves.toBe(1);

    const untrackedKey = `v1/${SEEDED_VAULT_ID}/snapshots/untracked/hash`;
    await env.MIRNA_SYNC_BUCKET.put(untrackedKey, new Uint8Array([4]));
    await expect(reconcileR2InventoryPage(env, 2_000)).resolves.toBe(2);
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        'SELECT maintenance_mode FROM service_flags WHERE singleton_id = 1',
      ).first<number>('maintenance_mode'),
    ).toBe(1);

    await env.MIRNA_SYNC_BUCKET.delete([trackedKey, untrackedKey]);
  });
});
