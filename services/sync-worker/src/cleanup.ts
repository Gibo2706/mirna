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
const R2_RECONCILIATION_INTERVAL_MS = 60 * 60 * 1_000;

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

export interface ScheduledCleanupPlan extends CleanupResult {
  readonly inspectedRows: number;
  readonly deletionRows: number;
  readonly resumedDeletionRequestIds: readonly string[];
  readonly resumedDeletionRequests: number;
  readonly staleDeletionRequests: number;
  readonly retainedDeletionRequests: number;
  readonly reconcileR2: boolean;
}

export const scheduledCleanupHasWork = (plan: ScheduledCleanupPlan): boolean =>
  plan.reconcileR2 ||
  [
    plan.authChallenges,
    plan.recoveryChallenges,
    plan.accessSessions,
    plan.pairingEnvelopes,
    plan.pairingRequests,
    plan.snapshots,
    plan.syncChanges,
    plan.deletionRequests,
    plan.betaDiagnosticEvents,
  ].some((count) => count > 0);

export const scheduledCleanupEstimateInput = (
  plan: ScheduledCleanupPlan,
  expiredUsageBuckets = 0,
) => ({
  expiredUsageBuckets,
  inspectedRows: plan.inspectedRows,
  ordinaryRows:
    plan.authChallenges +
    plan.recoveryChallenges +
    plan.accessSessions +
    plan.pairingEnvelopes +
    plan.pairingRequests +
    plan.syncChanges +
    plan.betaDiagnosticEvents,
  snapshotRows: plan.snapshots,
  deletionRequests: plan.deletionRequests,
  deletionRows: plan.deletionRows,
  reconcileR2: plan.reconcileR2,
});

const changes = (result: D1Result<unknown>): number => result.meta.changes ?? 0;

const parseBatchSize = (value: string, fallback: number, maximum: number): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
};

/** Read-only bounded inspection used to reserve only work that will be attempted. */
export const planScheduledCleanup = async (
  env: Env,
  now = Date.now(),
): Promise<ScheduledCleanupPlan> => {
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
  const row = await env.MIRNA_SYNC_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM (
          SELECT challenge_id FROM auth_challenges
           WHERE expires_at <= ?1 LIMIT ?2
        )) AS authChallenges,
       (SELECT COUNT(*) FROM (
          SELECT challenge_id FROM recovery_challenges
           WHERE (completed_at IS NULL AND expires_at <= ?1)
              OR (completed_at IS NOT NULL AND retention_expires_at <= ?1)
           LIMIT ?2
        )) AS recoveryChallenges,
       (SELECT COUNT(*) FROM (
          SELECT session_id FROM access_sessions
           WHERE expires_at <= ?1 LIMIT ?2
        )) AS accessSessions,
       (SELECT COUNT(*) FROM (
          SELECT envelope_id FROM pairing_envelopes
           WHERE (consumed_at IS NULL AND expires_at <= ?1)
              OR (consumed_at IS NOT NULL AND retention_expires_at <= ?1)
           LIMIT ?2
        )) AS pairingEnvelopes,
       (SELECT COUNT(*) FROM (
          SELECT pairing_request_id FROM pairing_requests
           WHERE expires_at <= ?1
             AND NOT EXISTS (
               SELECT 1 FROM pairing_envelopes
                WHERE pairing_envelopes.pairing_request_id = pairing_requests.pairing_request_id
                  AND pairing_envelopes.retention_expires_at > ?1
             )
           LIMIT ?2
        )) AS pairingRequests,
       (SELECT COUNT(*) FROM (
          SELECT snapshot_id FROM snapshots
           WHERE state IN ('temporary', 'orphaned', 'superseded', 'deleting')
             AND cleanup_after IS NOT NULL AND cleanup_after <= ?1
           LIMIT ?3
        )) AS snapshots,
       (SELECT COUNT(*) FROM (
          SELECT server_cursor FROM sync_changes
           WHERE compacted_at IS NOT NULL
             AND cleanup_after IS NOT NULL AND cleanup_after <= ?1
           LIMIT ?2
        )) AS syncChanges,
       (SELECT COUNT(*) FROM (
          SELECT deletion_request_id FROM deletion_requests
           WHERE state IN ('pending', 'deleting_r2', 'deleting_d1', 'failed')
             AND retention_expires_at > ?1
           LIMIT 3
        )) AS resumedDeletionRequests,
       (SELECT COUNT(*) FROM (
          SELECT deletion_request_id FROM deletion_requests
           WHERE stale_after <= ?1 AND state IN ('deleting_r2', 'deleting_d1') LIMIT ?2
        )) AS staleDeletionRequests,
       (SELECT COUNT(*) FROM (
          SELECT deletion_request_id FROM deletion_requests
           WHERE retention_expires_at <= ?1
             AND state IN ('pending', 'failed', 'completed') LIMIT ?2
        )) AS retainedDeletionRequests,
       (SELECT COUNT(*) FROM (
          SELECT event_id FROM beta_diagnostic_events
           WHERE expires_at <= ?1 LIMIT ?2
        )) AS betaDiagnosticEvents,
       (SELECT r2_reconciled_at FROM resource_totals WHERE singleton_id = 1) AS r2ReconciledAt`,
  )
    .bind(now, ephemeralBatchSize, snapshotBatchSize)
    .first<Record<string, number>>();
  if (!row) throw new Error('Scheduled cleanup plan is unavailable.');
  let remainingOrdinaryRows = ephemeralBatchSize;
  const takeOrdinaryRows = (count: number | undefined): number => {
    const selected = Math.min(count ?? 0, remainingOrdinaryRows);
    remainingOrdinaryRows -= selected;
    return selected;
  };
  const authChallenges = takeOrdinaryRows(row.authChallenges);
  const recoveryChallenges = takeOrdinaryRows(row.recoveryChallenges);
  const accessSessions = takeOrdinaryRows(row.accessSessions);
  const pairingEnvelopes = takeOrdinaryRows(row.pairingEnvelopes);
  const pairingRequests = takeOrdinaryRows(row.pairingRequests);
  const syncChanges = takeOrdinaryRows(row.syncChanges);
  const betaDiagnosticEvents = takeOrdinaryRows(row.betaDiagnosticEvents);
  const resumedDeletionRequestIds =
    row.resumedDeletionRequests === 0
      ? []
      : (
          await env.MIRNA_SYNC_DB.prepare(
            `SELECT deletion_request_id
               FROM deletion_requests
              WHERE state IN ('pending', 'deleting_r2', 'deleting_d1', 'failed')
                AND retention_expires_at > ?1
              ORDER BY updated_at, deletion_request_id
              LIMIT 3`,
          )
            .bind(now)
            .all<{ deletion_request_id: string }>()
        ).results.map(({ deletion_request_id }) => deletion_request_id);
  const resumedDeletionRequests = resumedDeletionRequestIds.length;
  const staleDeletionRequests = Math.min(row.staleDeletionRequests ?? 0, 3);
  const retainedDeletionRequests = Math.min(row.retainedDeletionRequests ?? 0, 3);
  const deletionRows =
    resumedDeletionRequests === 0
      ? 0
      : ((await env.MIRNA_SYNC_DB.prepare(
          `WITH deletion_vaults AS (
             SELECT vault_id
               FROM deletion_requests
              WHERE deletion_request_id IN (${resumedDeletionRequestIds.map((_, index) => `?${index + 1}`).join(', ')})
           )
           SELECT
             (SELECT COUNT(*) FROM vaults WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM devices WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM vault_manifests WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM device_grants WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM auth_challenges WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM access_sessions WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM pairing_requests WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM pairing_envelopes WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM recovery_records WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM snapshots WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM sync_changes WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM device_acknowledgements WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM device_key_envelopes WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM device_security_transitions WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM resource_inventory WHERE vault_id IN (SELECT vault_id FROM deletion_vaults)) +
             (SELECT COUNT(*) FROM vault_resource_totals WHERE vault_id IN (SELECT vault_id FROM deletion_vaults))
             AS row_count`,
        )
          .bind(...resumedDeletionRequestIds)
          .first<number>('row_count')) ?? 0);
  return {
    inspectedRows:
      [
        row.authChallenges,
        row.recoveryChallenges,
        row.accessSessions,
        row.pairingEnvelopes,
        row.pairingRequests,
        row.snapshots,
        row.syncChanges,
        row.resumedDeletionRequests,
        row.staleDeletionRequests,
        row.retainedDeletionRequests,
        row.betaDiagnosticEvents,
      ].reduce((total, count) => total + (count ?? 0), 0) + deletionRows,
    deletionRows,
    resumedDeletionRequestIds,
    authChallenges,
    recoveryChallenges,
    accessSessions,
    pairingEnvelopes,
    pairingRequests,
    snapshots: row.snapshots ?? 0,
    syncChanges,
    deletionRequests: resumedDeletionRequests + staleDeletionRequests + retainedDeletionRequests,
    resumedDeletionRequests,
    staleDeletionRequests,
    retainedDeletionRequests,
    betaDiagnosticEvents,
    reconcileR2: (row.r2ReconciledAt ?? 0) <= now - R2_RECONCILIATION_INTERVAL_MS,
  };
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
export const runScheduledCleanup = async (
  env: Env,
  now = Date.now(),
  inspectedPlan?: ScheduledCleanupPlan,
): Promise<CleanupResult> => {
  const plan = inspectedPlan ?? (await planScheduledCleanup(env, now));

  const authChallenges =
    plan.authChallenges === 0
      ? 0
      : await deleteExpiredRows(
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
          plan.authChallenges,
        );

  const accessSessions =
    plan.accessSessions === 0
      ? 0
      : await deleteExpiredRows(
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
          plan.accessSessions,
        );

  const recoveryChallenges =
    plan.recoveryChallenges === 0
      ? 0
      : await deleteExpiredRows(
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
          plan.recoveryChallenges,
        );

  const pairingEnvelopes =
    plan.pairingEnvelopes === 0
      ? 0
      : await deleteExpiredRows(
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
          plan.pairingEnvelopes,
        );

  const pairingRequests =
    plan.pairingRequests === 0
      ? 0
      : await deleteExpiredRows(
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
          plan.pairingRequests,
        );

  const syncChanges =
    plan.syncChanges === 0
      ? 0
      : await deleteExpiredRows(
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
          plan.syncChanges,
        );

  const resumedDeletionRequests =
    plan.resumedDeletionRequests === 0
      ? 0
      : await resumePendingVaultDeletions(env, plan.resumedDeletionRequestIds, now);

  const staleDeletionRequests =
    plan.staleDeletionRequests === 0
      ? 0
      : changes(
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
            .bind(now, plan.staleDeletionRequests)
            .run(),
        );

  const retainedDeletionRequests =
    plan.retainedDeletionRequests === 0
      ? 0
      : await deleteExpiredRows(
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
          plan.retainedDeletionRequests,
        );

  const snapshots = plan.snapshots === 0 ? 0 : await cleanupSnapshots(env, now, plan.snapshots);
  const betaDiagnosticEvents =
    plan.betaDiagnosticEvents === 0
      ? 0
      : await deleteExpiredRows(
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
          plan.betaDiagnosticEvents,
        );
  if (plan.reconcileR2) await reconcileR2InventoryPage(env, now);

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
