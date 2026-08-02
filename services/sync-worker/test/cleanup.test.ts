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
  runScheduledCleanup,
  scheduledCleanupEstimateInput,
  scheduledCleanupHasWork,
  type ScheduledCleanupPlan,
} from '../src/cleanup';
import worker from '../src/index';
import {
  bytes,
  opaqueId,
  rawP256PublicKey,
} from './fixtures';

const NOW = 2_000_000;
let seedOffset = 0;

const scalar = async (query: string): Promise<number> =>
  (await env.MIRNA_SYNC_DB.prepare(query).first<number>('count')) ?? -1;

const seedExpiredData = async (): Promise<void> => {
  await env.MIRNA_SYNC_DB.batch([
    env.MIRNA_SYNC_DB.prepare('DELETE FROM pairing_envelopes'),
    env.MIRNA_SYNC_DB.prepare('DELETE FROM pairing_requests'),
    env.MIRNA_SYNC_DB.prepare('DELETE FROM snapshots'),
    env.MIRNA_SYNC_DB.prepare('DELETE FROM sync_changes'),
    env.MIRNA_SYNC_DB.prepare('DELETE FROM access_sessions'),
    env.MIRNA_SYNC_DB.prepare('DELETE FROM auth_challenges'),
    env.MIRNA_SYNC_DB.prepare('DELETE FROM recovery_challenges'),
    env.MIRNA_SYNC_DB.prepare('DELETE FROM recovery_records'),
    env.MIRNA_SYNC_DB.prepare('DELETE FROM devices'),
    env.MIRNA_SYNC_DB.prepare('DELETE FROM vaults'),
  ]);

  const vaultId = opaqueId(100 + seedOffset++);
  const deviceId = opaqueId(110 + seedOffset++);
  const recoveryLookupId = opaqueId(120 + seedOffset++);
  const signingPublicKey = rawP256PublicKey(130 + seedOffset++);
  const agreementPublicKey = rawP256PublicKey(140 + seedOffset++);
  let byteSeed = 150 + seedOffset * 30;
  const nextByte = (): number => byteSeed++;
  const nextBytes32 = (): Uint8Array => bytes(32, nextByte());
  const nextBytes64 = (): Uint8Array => bytes(64, nextByte());
  const nextRawP256 = (): string => rawP256PublicKey(nextByte());
  const pairingRequestId = opaqueId(209 + seedOffset++);
  const pairingDeviceId = opaqueId(210 + seedOffset++);
  const temporarySnapshotKey = `opaque/temp/snapshot-${seedOffset++}`;
  const committedSnapshotKey = `opaque/committed/snapshot-${seedOffset++}`;

  await env.MIRNA_SYNC_DB.batch([
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO vaults (
         vault_id, protocol_version, crypto_suite, status, current_key_epoch,
         current_manifest_version, current_snapshot_revision, created_at, updated_at
       ) VALUES (?1, 1, ?2, 'active', 1, 0, 0, ?3, ?3)`,
    ).bind(vaultId, 'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1', NOW - 10_000),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO devices (
         vault_id, device_id, signing_public_key_raw, agreement_public_key_raw, status,
         added_in_manifest_version, created_at
       ) VALUES (?1, ?2, ?3, ?4, 'active', 1, ?5)`,
    ).bind(vaultId, deviceId, signingPublicKey, agreementPublicKey, NOW - 9_000),
  ]);
  await env.MIRNA_SYNC_BUCKET.put(temporarySnapshotKey, bytes(32, 7));
  await env.MIRNA_SYNC_BUCKET.put(committedSnapshotKey, bytes(32, 8));

  await env.MIRNA_SYNC_DB.batch([
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO recovery_records (
         recovery_lookup_id, vault_id, recovery_version, key_epoch,
         recovery_gate_key_hash, recovery_signing_public_key_raw,
         manifest_version, manifest_hash, crypto_suite,
         canonical_recovery_envelope, signed_updated_at, created_at
       ) VALUES (?1, ?2, 1, 1, ?3, ?4, 1, ?5, ?6, '{}', ?7, ?7)`,
    ).bind(
      recoveryLookupId,
      vaultId,
      nextBytes32(),
      nextRawP256(),
      nextBytes32(),
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
      opaqueId(200 + seedOffset++),
      recoveryLookupId,
      opaqueId(201 + seedOffset++),
      nextRawP256(),
      nextRawP256(),
      'http://localhost:5173',
      nextBytes32(),
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
      opaqueId(202 + seedOffset++),
      recoveryLookupId,
      opaqueId(203 + seedOffset++),
      nextRawP256(),
      nextRawP256(),
      'http://localhost:5173',
      nextBytes32(),
      NOW - 5_000,
      NOW - 4_000,
      NOW - 3_000,
      nextBytes32(),
      nextBytes32(),
      NOW + 1_000,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO auth_challenges (
         challenge_id, vault_id, device_id, audience, origin, challenge_hash,
         created_at, expires_at
       ) VALUES (?1, ?2, ?3, '/v1/auth/session', ?4, ?5, ?6, ?7)`,
    ).bind(
      opaqueId(204 + seedOffset++),
      vaultId,
      deviceId,
      'http://localhost:5173',
      nextBytes32(),
      NOW - 2_000,
      NOW - 1_000,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO access_sessions (
         session_id, vault_id, device_id, token_hash, created_at, expires_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      opaqueId(205 + seedOffset++),
      vaultId,
      deviceId,
      nextBytes32(),
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
      vaultId,
      opaqueId(206 + seedOffset++),
      deviceId,
      'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1',
      bytes(12, nextByte()),
      bytes(16, nextByte()),
      nextBytes32(),
      nextBytes64(),
      nextBytes32(),
      temporarySnapshotKey,
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
      vaultId,
      opaqueId(207 + seedOffset++),
      deviceId,
      'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1',
      bytes(12, nextByte()),
      bytes(16, nextByte()),
      nextBytes32(),
      nextBytes32(),
      nextBytes64(),
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
      vaultId,
      opaqueId(208 + seedOffset++),
      deviceId,
      'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1',
      bytes(12, nextByte()),
      bytes(16, nextByte()),
      nextBytes32(),
      nextBytes64(),
      nextBytes32(),
      committedSnapshotKey,
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
      pairingRequestId,
      vaultId,
      pairingDeviceId,
      nextRawP256(),
      nextRawP256(),
      nextBytes32(),
      nextBytes32(),
      nextBytes32(),
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
      opaqueId(211 + seedOffset++),
      pairingRequestId,
      vaultId,
      pairingDeviceId,
      deviceId,
      'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1',
      '{}',
      nextBytes32(),
      '{}',
      nextBytes32(),
      NOW - 4_000,
      NOW - 1_000,
      NOW - 2_000,
      NOW + 1_000,
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

  it('reproduces the current scheduled-cleanup underestimation with real D1 metadata', async () => {
    await seedExpiredData();

    const plan = await planScheduledCleanup(env, NOW);
    const estimated = estimateScheduledCleanupUsage(scheduledCleanupEstimateInput(plan));
    await runCron();

    const reservation = await env.MIRNA_SYNC_DB.prepare(
      `SELECT reserved_worker_requests, reserved_d1_rows_read, reserved_d1_rows_written,
              reserved_r2_class_a, reserved_r2_class_b, measured_worker_requests,
              measured_d1_rows_read, measured_d1_rows_written, measured_r2_class_a,
              measured_r2_class_b, measurement_exact, settlement_failure_code,
              business_committed, reconciled_at, reconciliation_code
         FROM usage_reservations
        WHERE route_key = 'scheduled-cleanup'
        ORDER BY created_at DESC
        LIMIT 1`,
    )
      .first<Record<string, number | string | null>>();

    expect(reservation).toMatchObject({ measurement_exact: 1, settlement_failure_code: null });
    expect(Number(reservation?.reserved_d1_rows_read)).toBeGreaterThanOrEqual(
      Number(reservation?.measured_d1_rows_read),
    );
    expect(Number(reservation?.reserved_d1_rows_written)).toBeGreaterThanOrEqual(
      Number(reservation?.measured_d1_rows_written),
    );
    expect(Number(reservation?.reserved_r2_class_a)).toBeGreaterThanOrEqual(
      Number(reservation?.measured_r2_class_a),
    );
      expect(Number(reservation?.measured_d1_rows_read)).toBeLessThanOrEqual(
        Number(reservation?.reserved_d1_rows_read),
      );
      expect(Number(reservation?.measured_d1_rows_written)).toBeLessThanOrEqual(
        Number(reservation?.reserved_d1_rows_written),
      );
    expect(estimated.d1RowsRead).toBeGreaterThanOrEqual(Number(reservation?.measured_d1_rows_read));
  });

  it('scales one-item and maximum-batch reservations from inspected work', () => {
    const plan = (overrides: Partial<ScheduledCleanupPlan>): ScheduledCleanupPlan => ({
      inspectedRows: 0,
      deletionRows: 0,
      resumedDeletionRequestIds: [],
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
      deletionRows: 100,
      resumedDeletionRequestIds: ['A'.repeat(22), 'B'.repeat(22), 'C'.repeat(22)],
      resumedDeletionRequests: 3,
      reconcileR2: true,
    });

    expect(scheduledCleanupHasWork(empty)).toBe(false);
    expect(scheduledCleanupHasWork(oneItem)).toBe(true);
    const oneUsage = estimateScheduledCleanupUsage(scheduledCleanupEstimateInput(oneItem));
    expect(
      estimateScheduledCleanupUsage(scheduledCleanupEstimateInput(reconciliationOnly)),
    ).toMatchObject({ d1RowsRead: 1_026, d1RowsWritten: 128, r2ClassA: 1 });
    const maximumUsage = estimateScheduledCleanupUsage(
      scheduledCleanupEstimateInput(maximumConfiguredBatch),
    );
    expect(oneUsage.d1RowsRead).toBeLessThan(maximumUsage.d1RowsRead);
    expect(oneUsage.d1RowsWritten).toBeLessThan(maximumUsage.d1RowsWritten);
    expect(maximumUsage.d1RowsWritten).toBeLessThan(80_000);
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

  it('executes only the deletion IDs captured by the inspected plan', async () => {
    const deletionVaultId = opaqueId(80);
    const deletionDeviceId = opaqueId(81);
    await env.MIRNA_SYNC_DB.batch([
      env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO vaults (
           vault_id, protocol_version, crypto_suite, status, current_key_epoch,
           current_manifest_version, current_snapshot_revision, created_at, updated_at
         ) VALUES (?1, 1, ?2, 'deleting', 1, 0, 0, ?3, ?3)`,
      ).bind(deletionVaultId, 'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1', NOW - 10_000),
      env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO devices (
           vault_id, device_id, signing_public_key_raw, agreement_public_key_raw,
           status, added_in_manifest_version, created_at
         ) VALUES (?1, ?2, ?3, ?4, 'active', 1, ?5)`,
      ).bind(
        deletionVaultId,
        deletionDeviceId,
        rawP256PublicKey(82),
        rawP256PublicKey(83),
        NOW - 9_000,
      ),
    ]);
    const insertDeletion = async (requestId: string, hashByte: number, updatedAt: number) => {
      await env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO deletion_requests (
           deletion_request_id, vault_id, requested_by_device_id,
           idempotency_key_hash, authorization_transcript_hash,
           authorization_signature, second_factor_proof_hash, state,
           created_at, updated_at, expires_at, stale_after, retention_expires_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9, ?10, ?11, ?12)`,
      )
        .bind(
          requestId,
          deletionVaultId,
          deletionDeviceId,
          bytes(32, hashByte),
          bytes(32, hashByte + 1),
          bytes(64, hashByte + 2),
          bytes(32, hashByte + 3),
          NOW - 10_000,
          updatedAt,
          NOW + 1_000,
          NOW + 2_000,
          NOW + 20_000,
        )
        .run();
    };

    await insertDeletion('deletion-request-old', 51, NOW - 1_000);
    const inspected = await planScheduledCleanup(env, NOW);
    expect(inspected.resumedDeletionRequestIds).toEqual(['deletion-request-old']);

    await insertDeletion('deletion-request-new', 61, NOW);
    await runScheduledCleanup(env, NOW, inspected);

    expect(
      await env.MIRNA_SYNC_DB.prepare(
        `SELECT state FROM deletion_requests WHERE deletion_request_id = 'deletion-request-old'`,
      ).first<string>('state'),
    ).toBe('completed');
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        `SELECT state FROM deletion_requests WHERE deletion_request_id = 'deletion-request-new'`,
      ).first<string>('state'),
    ).toBe('pending');
  });
});
