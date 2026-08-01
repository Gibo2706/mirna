import type { Env } from './env';
import { resumePendingVaultDeletions } from './deletion';
import { releaseR2Object } from './budget';
import { reconcileR2InventoryPage } from './reconciliation';

// Snapshot cleanup needs two D1 statements per object plus R2 work, so it stays
// deliberately small. Expired metadata is deleted with one bounded SQL
// statement per category and can use a much larger row batch without consuming
// one Worker subrequest per deleted row.
const DEFAULT_SNAPSHOT_BATCH_SIZE = 10;
const MAX_SNAPSHOT_BATCH_SIZE = 10;
const DEFAULT_EPHEMERAL_BATCH_SIZE = 1_000;
const MAX_EPHEMERAL_BATCH_SIZE = 5_000;

interface SnapshotCleanupRow {
  vault_id: string;
  snapshot_id: string;
  r2_object_key: string;
}

export interface CleanupResult {
  authChallenges: number;
  recoveryChallenges: number;
  accessSessions: number;
  pairingEnvelopes: number;
  pairingRequests: number;
  snapshots: number;
  syncChanges: number;
  deletionRequests: number;
  betaDiagnosticEvents: number;
}

const changes = (result: D1Result<unknown>): number => result.meta.changes ?? 0;

const parseBatchSize = (value: string, fallback: number, maximum: number): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
};

const deleteExpiredRows = async (
  database: D1Database,
  query: string,
  now: number,
  batchSize: number,
): Promise<number> => changes(await database.prepare(query).bind(now, batchSize).run());

const cleanupSnapshots = async (env: Env, now: number, batchSize: number): Promise<number> => {
  const candidates = await env.MIRNA_SYNC_DB.prepare(
    `SELECT vault_id, snapshot_id, r2_object_key
       FROM snapshots
      WHERE state IN ('temporary', 'orphaned', 'superseded', 'deleting')
        AND cleanup_after IS NOT NULL
        AND cleanup_after <= ?1
      ORDER BY cleanup_after, vault_id, snapshot_id
      LIMIT ?2`,
  )
    .bind(now, batchSize)
    .all<SnapshotCleanupRow>();

  if (candidates.results.length === 0) return 0;

  // Claim each row before touching R2. A concurrent commit can therefore win
  // the state transition and prevent cleanup from deleting its live object.
  const claimResults = await env.MIRNA_SYNC_DB.batch(
    candidates.results.map((row) =>
      env.MIRNA_SYNC_DB.prepare(
        `UPDATE snapshots
            SET state = 'deleting'
          WHERE vault_id = ?1
            AND snapshot_id = ?2
            AND state IN ('temporary', 'orphaned', 'superseded', 'deleting')
            AND cleanup_after IS NOT NULL
            AND cleanup_after <= ?3`,
      ).bind(row.vault_id, row.snapshot_id, now),
    ),
  );
  const claimed = candidates.results.filter((_, index) => changes(claimResults[index]) > 0);
  if (claimed.length === 0) return 0;

  const objectKeys = [...new Set(claimed.map((row) => row.r2_object_key))];
  await env.MIRNA_SYNC_BUCKET.delete(objectKeys);
  await Promise.all(objectKeys.map((objectKey) => releaseR2Object(env, objectKey)));

  const deleteResults = await env.MIRNA_SYNC_DB.batch(
    claimed.map((row) =>
      env.MIRNA_SYNC_DB.prepare(
        `DELETE FROM snapshots
          WHERE vault_id = ?1
            AND snapshot_id = ?2
            AND state = 'deleting'
            AND cleanup_after IS NOT NULL
            AND cleanup_after <= ?3`,
      ).bind(row.vault_id, row.snapshot_id, now),
    ),
  );

  return deleteResults.reduce((total, result) => total + changes(result), 0);
};

/**
 * Deletes only rows that a request path has already marked as expired or safe
 * to compact. Each category is bounded so one cron invocation cannot turn into
 * an unbounded D1/R2 operation. Retrying after any partial failure is safe.
 */
export const runScheduledCleanup = async (env: Env, now = Date.now()): Promise<CleanupResult> => {
  const snapshotBatchSize = parseBatchSize(
    env.MIRNA_CLEANUP_BATCH_SIZE,
    DEFAULT_SNAPSHOT_BATCH_SIZE,
    MAX_SNAPSHOT_BATCH_SIZE,
  );
  const ephemeralBatchSize = parseBatchSize(
    env.MIRNA_EPHEMERAL_CLEANUP_BATCH_SIZE,
    DEFAULT_EPHEMERAL_BATCH_SIZE,
    MAX_EPHEMERAL_BATCH_SIZE,
  );

  const authChallenges = await deleteExpiredRows(
    env.MIRNA_SYNC_DB,
    `DELETE FROM auth_challenges
      WHERE challenge_id IN (
        SELECT challenge_id
          FROM auth_challenges
         WHERE expires_at <= ?1
         ORDER BY expires_at, challenge_id
         LIMIT ?2
      )`,
    now,
    ephemeralBatchSize,
  );

  const accessSessions = await deleteExpiredRows(
    env.MIRNA_SYNC_DB,
    `DELETE FROM access_sessions
      WHERE session_id IN (
        SELECT session_id
          FROM access_sessions
         WHERE expires_at <= ?1
         ORDER BY expires_at, session_id
         LIMIT ?2
      )`,
    now,
    ephemeralBatchSize,
  );

  const recoveryChallenges = await deleteExpiredRows(
    env.MIRNA_SYNC_DB,
    `DELETE FROM recovery_challenges
      WHERE challenge_id IN (
        SELECT challenge_id
          FROM recovery_challenges
         WHERE (completed_at IS NULL AND expires_at <= ?1)
            OR (completed_at IS NOT NULL AND retention_expires_at <= ?1)
         ORDER BY retention_expires_at, challenge_id
         LIMIT ?2
      )`,
    now,
    ephemeralBatchSize,
  );

  const pairingEnvelopes = await deleteExpiredRows(
    env.MIRNA_SYNC_DB,
    `DELETE FROM pairing_envelopes
      WHERE envelope_id IN (
        SELECT envelope_id
          FROM pairing_envelopes
         WHERE (consumed_at IS NULL AND expires_at <= ?1)
            OR (consumed_at IS NOT NULL AND retention_expires_at <= ?1)
         ORDER BY retention_expires_at, envelope_id
         LIMIT ?2
      )`,
    now,
    ephemeralBatchSize,
  );

  const pairingRequests = await deleteExpiredRows(
    env.MIRNA_SYNC_DB,
    `DELETE FROM pairing_requests
      WHERE pairing_request_id IN (
        SELECT pairing_request_id
          FROM pairing_requests
         WHERE expires_at <= ?1
           AND NOT EXISTS (
             SELECT 1
               FROM pairing_envelopes
              WHERE pairing_envelopes.pairing_request_id = pairing_requests.pairing_request_id
                AND pairing_envelopes.retention_expires_at > ?1
           )
         ORDER BY expires_at, pairing_request_id
         LIMIT ?2
      )`,
    now,
    ephemeralBatchSize,
  );

  const syncChanges = await deleteExpiredRows(
    env.MIRNA_SYNC_DB,
    `DELETE FROM sync_changes
      WHERE server_cursor IN (
        SELECT server_cursor
          FROM sync_changes
         WHERE compacted_at IS NOT NULL
           AND cleanup_after IS NOT NULL
           AND cleanup_after <= ?1
         ORDER BY cleanup_after, server_cursor
         LIMIT ?2
      )`,
    now,
    ephemeralBatchSize,
  );

  const resumedDeletionRequests = await resumePendingVaultDeletions(env);

  const staleDeletionRequests = changes(
    await env.MIRNA_SYNC_DB.prepare(
      `UPDATE deletion_requests
          SET state = 'failed',
              safe_error_code = 'STALE_JOB_RETRY_REQUIRED',
              updated_at = ?1
        WHERE deletion_request_id IN (
          SELECT deletion_request_id
            FROM deletion_requests
           WHERE stale_after <= ?1
             AND state IN ('deleting_r2', 'deleting_d1')
           ORDER BY stale_after, deletion_request_id
           LIMIT ?2
        )`,
    )
      .bind(now, ephemeralBatchSize)
      .run(),
  );

  const retainedDeletionRequests = await deleteExpiredRows(
    env.MIRNA_SYNC_DB,
    `DELETE FROM deletion_requests
      WHERE deletion_request_id IN (
        SELECT deletion_request_id
          FROM deletion_requests
         WHERE retention_expires_at <= ?1
           AND state IN ('pending', 'failed', 'completed')
         ORDER BY retention_expires_at, deletion_request_id
         LIMIT ?2
      )`,
    now,
    ephemeralBatchSize,
  );

  const snapshots = await cleanupSnapshots(env, now, snapshotBatchSize);
  const betaDiagnosticEvents = await deleteExpiredRows(
    env.MIRNA_SYNC_DB,
    `DELETE FROM beta_diagnostic_events
      WHERE event_id IN (
        SELECT event_id
          FROM beta_diagnostic_events
         WHERE expires_at <= ?1
         ORDER BY expires_at, event_id
         LIMIT ?2
      )`,
    now,
    ephemeralBatchSize,
  );
  await reconcileR2InventoryPage(env, now);

  return {
    authChallenges,
    recoveryChallenges,
    accessSessions,
    pairingEnvelopes,
    pairingRequests,
    snapshots,
    syncChanges,
    deletionRequests: resumedDeletionRequests + staleDeletionRequests + retainedDeletionRequests,
    betaDiagnosticEvents,
  };
};
