import { env } from 'cloudflare:workers';
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { estimateScheduledCleanupUsage } from '../src/budget';
import {
  planScheduledCleanup,
  scheduledCleanupEstimateInput,
  scheduledCleanupHasWork,
  type ScheduledCleanupPlan,
} from '../src/cleanup';
import worker from '../src/index';
import {
  bytes,
  opaqueId,
  rawP256PublicKey,
  SEEDED_DEVICE_ID,
  SEEDED_RECOVERY_LOOKUP_ID,
  SEEDED_VAULT_ID,
  seedVaultAndDevice,
} from './fixtures';

const NOW = 2_000_000;

const scalar = async (query: string): Promise<number> =>
  (await env.MIRNA_SYNC_DB.prepare(query).first<number>('count')) ?? -1;

const seedExpiredData = async (): Promise<void> => {
  await seedVaultAndDevice(env, NOW);
  await env.MIRNA_SYNC_BUCKET.put('opaque/temp/snapshot-01', bytes(32, 7));
  await env.MIRNA_SYNC_BUCKET.put('opaque/committed/snapshot-02', bytes(32, 8));

  await env.MIRNA_SYNC_DB.batch([
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO recovery_records (
         recovery_lookup_id, vault_id, recovery_version, key_epoch,
         recovery_gate_key_hash, recovery_signing_public_key_raw,
         manifest_version, manifest_hash, crypto_suite,
         canonical_recovery_envelope, signed_updated_at, created_at
       ) VALUES (?1, ?2, 1, 1, ?3, ?4, 1, ?5, ?6, '{}', ?7, ?7)`,
    ).bind(
      SEEDED_RECOVERY_LOOKUP_ID,
      SEEDED_VAULT_ID,
      bytes(32, 30),
      rawP256PublicKey(31),
      bytes(32, 32),
      'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1',
      NOW - 3_000,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO recovery_challenges (
         challenge_id, recovery_lookup_id, new_device_id,
         new_signing_public_key_raw, new_agreement_public_key_raw,
         origin, challenge_hash, created_at, expires_at, retention_expires_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(
      opaqueId(33),
      SEEDED_RECOVERY_LOOKUP_ID,
      opaqueId(34),
      rawP256PublicKey(35),
      rawP256PublicKey(36),
      'http://localhost:5173',
      bytes(32, 37),
      NOW - 2_000,
      NOW - 1_000,
      NOW + 60_000,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO recovery_challenges (
         challenge_id, recovery_lookup_id, new_device_id,
         new_signing_public_key_raw, new_agreement_public_key_raw,
         origin, challenge_hash, created_at, expires_at, consumed_at,
         idempotency_key_hash, complete_request_hash, canonical_complete_response,
         completed_at, retention_expires_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, '{}', ?10, ?13)`,
    ).bind(
      opaqueId(38),
      SEEDED_RECOVERY_LOOKUP_ID,
      opaqueId(39),
      rawP256PublicKey(40),
      rawP256PublicKey(41),
      'http://localhost:5173',
      bytes(32, 42),
      NOW - 5_000,
      NOW - 4_000,
      NOW - 3_000,
      bytes(32, 43),
      bytes(32, 44),
      NOW + 1_000,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO auth_challenges (
         challenge_id, vault_id, device_id, audience, origin, challenge_hash,
         created_at, expires_at
       ) VALUES (?1, ?2, ?3, '/v1/auth/session', ?4, ?5, ?6, ?7)`,
    ).bind(
      opaqueId(35),
      SEEDED_VAULT_ID,
      SEEDED_DEVICE_ID,
      'http://localhost:5173',
      bytes(32, 1),
      NOW - 2_000,
      NOW - 1_000,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO access_sessions (
         session_id, vault_id, device_id, token_hash, created_at, expires_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      'session-opaque-id-01',
      SEEDED_VAULT_ID,
      SEEDED_DEVICE_ID,
      bytes(32, 2),
      NOW - 2_000,
      NOW - 1_000,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO snapshots (
         vault_id, snapshot_id, revision, base_revision, key_epoch,
         creating_device_id, crypto_suite, nonce, aad, ciphertext_hash,
         ciphertext_size, envelope_signature, idempotency_key_hash,
         r2_object_key, state, created_at, cleanup_after
       ) VALUES (
         ?1, ?2, 1, 0, 1, ?3, ?4, ?5, ?6, ?7, 32, ?8, ?9, ?10,
         'temporary', ?11, ?12
       )`,
    ).bind(
      SEEDED_VAULT_ID,
      'snapshot-opaque-id-01',
      SEEDED_DEVICE_ID,
      'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1',
      bytes(12, 3),
      bytes(16, 4),
      bytes(32, 5),
      bytes(64, 6),
      bytes(32, 7),
      'opaque/temp/snapshot-01',
      NOW - 2_000,
      NOW - 1_000,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO sync_changes (
         vault_id, operation_id, device_id, device_sequence, key_epoch,
         crypto_suite, nonce, aad, ciphertext, ciphertext_hash, signature,
         accepted_at, compacted_at, cleanup_after
       ) VALUES (?1, ?2, ?3, 1, 1, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    ).bind(
      SEEDED_VAULT_ID,
      'operation-id-000001',
      SEEDED_DEVICE_ID,
      'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1',
      bytes(12, 8),
      bytes(16, 9),
      bytes(32, 10),
      bytes(32, 11),
      bytes(64, 12),
      NOW - 3_000,
      NOW - 2_000,
      NOW - 1_000,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO snapshots (
         vault_id, snapshot_id, revision, base_revision, key_epoch,
         creating_device_id, crypto_suite, nonce, aad, ciphertext_hash,
         ciphertext_size, envelope_signature, idempotency_key_hash,
         r2_object_key, state, created_at, committed_at
       ) VALUES (
         ?1, ?2, 2, 1, 1, ?3, ?4, ?5, ?6, ?7, 32, ?8, ?9, ?10,
         'committed', ?11, ?12
       )`,
    ).bind(
      SEEDED_VAULT_ID,
      'snapshot-opaque-id-02',
      SEEDED_DEVICE_ID,
      'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1',
      bytes(12, 13),
      bytes(16, 14),
      bytes(32, 15),
      bytes(64, 16),
      bytes(32, 17),
      'opaque/committed/snapshot-02',
      NOW - 2_000,
      NOW - 1_500,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO pairing_requests (
         pairing_request_id, vault_id, new_device_id, new_signing_public_key_raw,
         new_agreement_public_key_raw, pairing_salt, pairing_claim_token_hash, polling_token_hash,
         status, created_at, expires_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'approved', ?9, ?10)`,
    ).bind(
      opaqueId(40),
      SEEDED_VAULT_ID,
      opaqueId(41),
      rawP256PublicKey(42),
      rawP256PublicKey(43),
      bytes(32, 18),
      bytes(32, 19),
      bytes(32, 20),
      NOW - 5_000,
      NOW - 1_000,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO pairing_envelopes (
         envelope_id, pairing_request_id, vault_id, new_device_id,
         authorizing_device_id, key_epoch, crypto_suite,
         canonical_envelope, envelope_hash, candidate_manifest, candidate_manifest_hash,
         created_at, expires_at, consumed_at, retention_expires_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    ).bind(
      opaqueId(44),
      opaqueId(40),
      SEEDED_VAULT_ID,
      opaqueId(41),
      SEEDED_DEVICE_ID,
      'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1',
      '{}',
      bytes(32, 21),
      '{}',
      bytes(32, 22),
      NOW - 4_000,
      NOW - 1_000,
      NOW - 2_000,
      NOW + 1_000,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO deletion_requests (
         deletion_request_id, vault_id, requested_by_device_id,
         idempotency_key_hash, authorization_transcript_hash,
         authorization_signature, second_factor_proof_hash, state,
         created_at, updated_at, expires_at, stale_after, retention_expires_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'deleting_r2', ?8, ?9, ?10, ?11, ?12)`,
    ).bind(
      'deletion-request-001',
      SEEDED_VAULT_ID,
      SEEDED_DEVICE_ID,
      bytes(32, 24),
      bytes(32, 25),
      bytes(64, 26),
      bytes(32, 27),
      NOW - 10_000,
      NOW - 5_000,
      NOW - 4_000,
      NOW - 1_000,
      NOW + 5_000,
    ),
  ]);
};

const runCron = async (scheduledTime = NOW): Promise<void> => {
  const controller = createScheduledController({
    scheduledTime: new Date(scheduledTime),
    cron: '7 * * * *',
  });
  const context = createExecutionContext();
  await worker.scheduled?.(controller, env, context);
  await waitOnExecutionContext(context);
};

describe('scheduled cleanup', () => {
  it('skips empty work across repeated daily runs without self-exhaustion', async () => {
    await env.MIRNA_SYNC_DB.prepare(
      'UPDATE resource_totals SET r2_reconciled_at = ?1 WHERE singleton_id = 1',
    )
      .bind(NOW)
      .run();

    expect(scheduledCleanupHasWork(await planScheduledCleanup(env, NOW))).toBe(false);
    for (let run = 0; run < 24; run += 1) {
      await runCron(NOW + run);
    }

    expect(
      await scalar(
        `SELECT COUNT(*) AS count FROM usage_reservations
          WHERE route_key = 'scheduled-cleanup'`,
      ),
    ).toBe(0);
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        `SELECT accounting_fault, maintenance_mode, accept_writes
           FROM service_flags WHERE singleton_id = 1`,
      ).first(),
    ).toEqual({ accounting_fault: 0, maintenance_mode: 0, accept_writes: 1 });
  });

  it('scales one-item and maximum-batch reservations from inspected work', () => {
    const plan = (overrides: Partial<ScheduledCleanupPlan>): ScheduledCleanupPlan => ({
      inspectedRows: 0,
      authChallenges: 0,
      recoveryChallenges: 0,
      accessSessions: 0,
      pairingEnvelopes: 0,
      pairingRequests: 0,
      snapshots: 0,
      syncChanges: 0,
      deletionRequests: 0,
      resumedDeletionRequests: 0,
      staleDeletionRequests: 0,
      retainedDeletionRequests: 0,
      betaDiagnosticEvents: 0,
      reconcileR2: false,
      ...overrides,
    });
    const empty = plan({});
    const oneItem = plan({ authChallenges: 1 });
    const reconciliationOnly = plan({ reconcileR2: true });
    const maximumConfiguredBatch = plan({
      authChallenges: 1_000,
      snapshots: 10,
      deletionRequests: 3,
      resumedDeletionRequests: 3,
      reconcileR2: true,
    });

    expect(scheduledCleanupHasWork(empty)).toBe(false);
    expect(scheduledCleanupHasWork(oneItem)).toBe(true);
    const oneUsage = estimateScheduledCleanupUsage(scheduledCleanupEstimateInput(oneItem));
    expect(
      estimateScheduledCleanupUsage(scheduledCleanupEstimateInput(reconciliationOnly)),
    ).toMatchObject({ d1RowsRead: 514, d1RowsWritten: 64, r2ClassA: 1 });
    const maximumUsage = estimateScheduledCleanupUsage(
      scheduledCleanupEstimateInput(maximumConfiguredBatch),
    );
    expect(oneUsage.d1RowsRead).toBeLessThan(maximumUsage.d1RowsRead);
    expect(oneUsage.d1RowsWritten).toBeLessThan(maximumUsage.d1RowsWritten);
    expect(maximumUsage.d1RowsWritten).toBeLessThan(40_000);
    expect(maximumUsage).toMatchObject({ workerRequests: 0, r2ClassB: 0 });
  });

  it('removes only eligible D1/R2 data in bounded, idempotent batches', async () => {
    await seedExpiredData();

    await runCron();
    expect(await scalar('SELECT COUNT(*) AS count FROM auth_challenges')).toBe(0);
    expect(await scalar('SELECT COUNT(*) AS count FROM recovery_challenges')).toBe(1);
    expect(await scalar('SELECT COUNT(*) AS count FROM access_sessions')).toBe(0);
    expect(await scalar('SELECT COUNT(*) AS count FROM snapshots')).toBe(1);
    expect(await scalar('SELECT COUNT(*) AS count FROM sync_changes')).toBe(0);
    expect(await env.MIRNA_SYNC_BUCKET.head('opaque/temp/snapshot-01')).toBeNull();
    expect(await env.MIRNA_SYNC_BUCKET.head('opaque/committed/snapshot-02')).not.toBeNull();
    expect(await scalar('SELECT COUNT(*) AS count FROM pairing_envelopes')).toBe(1);
    expect(await scalar('SELECT COUNT(*) AS count FROM pairing_requests')).toBe(1);

    const deletionState = await env.MIRNA_SYNC_DB.prepare(
      `SELECT state, safe_error_code
         FROM deletion_requests
        WHERE deletion_request_id = 'deletion-request-001'`,
    ).first<{ state: string; safe_error_code: string }>();
    expect(deletionState).toEqual({
      state: 'failed',
      safe_error_code: 'STALE_JOB_RETRY_REQUIRED',
    });

    await runCron();
    expect(await scalar('SELECT COUNT(*) AS count FROM snapshots')).toBe(1);
    expect(await scalar('SELECT COUNT(*) AS count FROM sync_changes')).toBe(0);
    expect(await scalar('SELECT COUNT(*) AS count FROM pairing_envelopes')).toBe(1);
    expect(await scalar('SELECT COUNT(*) AS count FROM recovery_challenges')).toBe(1);

    await runCron(NOW + 2_000);
    expect(await scalar('SELECT COUNT(*) AS count FROM pairing_envelopes')).toBe(0);
    expect(await scalar('SELECT COUNT(*) AS count FROM pairing_requests')).toBe(0);
    expect(await scalar('SELECT COUNT(*) AS count FROM recovery_challenges')).toBe(0);
  });
});
