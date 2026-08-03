import type { Env } from './env';

const RECONCILIATION_PAGE_SIZE = 100;

interface ReconciliationState {
  readonly r2_reconcile_cursor: string | null;
}

interface InventoryVerificationRow {
  readonly object_key: string;
  readonly ciphertext_bytes: number;
}

const pauseForInventoryMismatch = async (env: Env, now: number): Promise<void> => {
  await env.MIRNA_SYNC_DB.prepare(
    `UPDATE service_flags
        SET accept_new_vaults = 0, accept_pairings = 0,
            accept_writes = 0, maintenance_mode = 1,
            state_reason = 'R2_INVENTORY_MISMATCH', state_request_id = NULL,
            updated_at = ?1
      WHERE singleton_id = 1`,
  )
    .bind(now)
    .run();
};

/**
 * Verifies one bounded R2 page against the D1 inventory. Inventory is written
 * before PutObject, so an R2 object without an exact row is never trusted or
 * auto-adopted. Object keys and metadata are deliberately not logged.
 */
export const reconcileR2InventoryPage = async (env: Env, now = Date.now()): Promise<number> => {
  const state = await env.MIRNA_SYNC_DB.prepare(
    'SELECT r2_reconcile_cursor FROM resource_totals WHERE singleton_id = 1',
  ).first<ReconciliationState>();
  if (!state) {
    await pauseForInventoryMismatch(env, now);
    throw new Error('R2 inventory accounting state is unavailable.');
  }

  const page = await env.MIRNA_SYNC_BUCKET.list({
    prefix: 'v1/',
    cursor: state.r2_reconcile_cursor ?? undefined,
    limit: RECONCILIATION_PAGE_SIZE,
  });
  const verification =
    page.objects.length === 0
      ? []
      : await env.MIRNA_SYNC_DB.batch<InventoryVerificationRow>(
          page.objects.map((object) =>
            env.MIRNA_SYNC_DB.prepare(
              `SELECT object_key, ciphertext_bytes
                 FROM resource_inventory WHERE object_key = ?1`,
            ).bind(object.key),
          ),
        );
  const mismatch = page.objects.some((object, index) => {
    const row = verification[index]?.results[0];
    return !row || row.object_key !== object.key || row.ciphertext_bytes !== object.size;
  });
  const cursor = page.truncated ? page.cursor : undefined;
  if (mismatch || (page.truncated && !cursor)) {
    await pauseForInventoryMismatch(env, now);
  }
  await env.MIRNA_SYNC_DB.prepare(
    `UPDATE resource_totals
        SET r2_reconcile_cursor = ?1, r2_reconciled_at = ?2, updated_at = ?2
      WHERE singleton_id = 1`,
  )
    .bind(cursor ?? null, now)
    .run();
  return page.objects.length;
};
