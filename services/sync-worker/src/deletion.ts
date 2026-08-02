import { SYNC_DOMAIN_LABELS } from '../../../src/domain/sync/constants';
import {
  hashDomainSeparatedCanonical,
  importSigningPublicKey,
  verifyDomainSeparatedCanonicalSignature,
} from '../../../src/domain/sync/crypto';
import { base64UrlToBytes, timingSafeEqual } from '../../../src/domain/sync/encoding';
import { manifestBodyHash } from '../../../src/domain/sync/manifest';
import {
  vaultDeletionRequestSchema,
  vaultDeletionResponseSchema,
} from '../../../src/domain/sync/schemas';
import { authenticateRequest } from './auth';
import { markBusinessCommit, type RequestContext } from './context';
import type { Env } from './env';
import { releaseVaultR2Inventory } from './budget';
import { conflict, forbidden, HttpError } from './errors';
import { jsonResponse } from './http';
import { authorizeRecoveryCapability } from './recovery';
import {
  encodedToDatabaseBlob,
  hashEncodedSecret,
  isoTimestamp,
  toDatabaseBlob,
} from './server-crypto';
import { readCanonicalJson } from './validation';

type DeletionState = 'pending' | 'deleting_r2' | 'deleting_d1' | 'completed' | 'failed';

interface DeletionJobRow {
  deletion_request_id: string;
  vault_id: string;
  requested_by_device_id: string;
  idempotency_key_hash: ArrayBuffer;
  authorization_transcript_hash: ArrayBuffer;
  authorization_signature: ArrayBuffer;
  second_factor_proof_hash: ArrayBuffer;
  state: DeletionState;
  resume_after_r2_key: string | null;
  safe_error_code: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

const loadDeletionJob = (
  database: D1Database,
  deletionRequestId: string,
): Promise<DeletionJobRow | null> =>
  database
    .prepare(
      `SELECT deletion_request_id, vault_id, requested_by_device_id,
              idempotency_key_hash, authorization_transcript_hash,
              authorization_signature, second_factor_proof_hash,
              state, resume_after_r2_key, safe_error_code,
              created_at, updated_at, completed_at
         FROM deletion_requests
        WHERE deletion_request_id = ?1
        LIMIT 1`,
    )
    .bind(deletionRequestId)
    .first<DeletionJobRow>();

const responseForJob = (context: RequestContext, job: DeletionJobRow): Response =>
  jsonResponse(
    vaultDeletionResponseSchema.parse({
      protocolVersion: 1,
      vaultId: job.vault_id,
      deletionRequestId: job.deletion_request_id,
      state: job.state,
      deleted: job.state === 'completed',
      completedAt: job.completed_at === null ? null : isoTimestamp(job.completed_at),
    }),
    {
      status: job.state === 'completed' ? 200 : 202,
      requestId: context.requestId,
      allowedOrigin: context.allowedOrigin,
    },
  );

const markDeletionFailed = async (
  env: Env,
  deletionRequestId: string,
  safeErrorCode: string,
): Promise<DeletionJobRow> => {
  await env.MIRNA_SYNC_DB.prepare(
    `UPDATE deletion_requests
        SET state = 'failed', safe_error_code = ?2, updated_at = ?3
      WHERE deletion_request_id = ?1 AND state != 'completed'`,
  )
    .bind(deletionRequestId, safeErrorCode, Date.now())
    .run();
  const failed = await loadDeletionJob(env.MIRNA_SYNC_DB, deletionRequestId);
  if (!failed) throw new Error('Deletion job disappeared.');
  return failed;
};

export const resumeVaultDeletion = async (
  env: Env,
  deletionRequestId: string,
): Promise<DeletionJobRow> => {
  let job = await loadDeletionJob(env.MIRNA_SYNC_DB, deletionRequestId);
  if (!job) throw new HttpError(404, 'DELETION_JOB_NOT_FOUND', 'Deletion job was not found.');
  if (job.state === 'completed') return job;
  await env.MIRNA_SYNC_DB.prepare(
    `UPDATE deletion_requests
        SET state = 'deleting_r2', safe_error_code = NULL, updated_at = ?2
      WHERE deletion_request_id = ?1 AND state != 'completed'`,
  )
    .bind(deletionRequestId, Date.now())
    .run();

  try {
    let cursor = job.resume_after_r2_key ?? undefined;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await env.MIRNA_SYNC_BUCKET.list({
        prefix: `v1/${job.vault_id}/`,
        cursor,
        limit: 1_000,
      });
      if (page.objects.length > 0) {
        await env.MIRNA_SYNC_BUCKET.delete(page.objects.map((object) => object.key));
      }
      cursor = page.truncated ? page.cursor : undefined;
      await env.MIRNA_SYNC_DB.prepare(
        `UPDATE deletion_requests SET resume_after_r2_key = ?2, updated_at = ?3
          WHERE deletion_request_id = ?1 AND state = 'deleting_r2'`,
      )
        .bind(deletionRequestId, cursor ?? null, Date.now())
        .run();
      if (!page.truncated) break;
      if (!cursor || pageNumber === 99) {
        return markDeletionFailed(env, deletionRequestId, 'R2_DELETE_INCOMPLETE');
      }
    }
  } catch {
    return markDeletionFailed(env, deletionRequestId, 'R2_DELETE_FAILED');
  }

  try {
    await releaseVaultR2Inventory(env, job.vault_id);
    const now = Date.now();
    await env.MIRNA_SYNC_DB.batch([
      env.MIRNA_SYNC_DB.prepare(
        `UPDATE deletion_requests
            SET state = 'deleting_d1', resume_after_r2_key = NULL, updated_at = ?2
          WHERE deletion_request_id = ?1 AND state != 'completed'`,
      ).bind(deletionRequestId, now),
      env.MIRNA_SYNC_DB.prepare('DELETE FROM vaults WHERE vault_id = ?1').bind(job.vault_id),
      env.MIRNA_SYNC_DB.prepare(
        `UPDATE deletion_requests
            SET state = 'completed', safe_error_code = NULL,
                updated_at = ?2, completed_at = ?2
          WHERE deletion_request_id = ?1 AND state = 'deleting_d1'`,
      ).bind(deletionRequestId, now),
    ]);
  } catch {
    return markDeletionFailed(env, deletionRequestId, 'D1_DELETE_FAILED');
  }
  job = await loadDeletionJob(env.MIRNA_SYNC_DB, deletionRequestId);
  if (!job) throw new Error('Completed deletion tombstone disappeared.');
  return job;
};

export const resumePendingVaultDeletions = async (
  env: Env,
  plannedRequestIds: readonly string[],
  now = Date.now(),
): Promise<number> => {
  if (plannedRequestIds.length === 0) return 0;
  if (plannedRequestIds.length > 3) throw new Error('Deletion cleanup plan exceeds its hard cap.');
  const placeholders = plannedRequestIds.map((_, index) => `?${index + 2}`).join(', ');
  const rows = await env.MIRNA_SYNC_DB.prepare(
    `SELECT deletion_request_id
       FROM deletion_requests
      WHERE deletion_request_id IN (${placeholders})
        AND state IN ('pending', 'deleting_r2', 'deleting_d1', 'failed')
        AND retention_expires_at > ?1
      ORDER BY updated_at, deletion_request_id`,
  )
    .bind(now, ...plannedRequestIds)
    .all<{ deletion_request_id: string }>();
  let completed = 0;
  for (const row of rows.results) {
    const result = await resumeVaultDeletion(env, row.deletion_request_id);
    if (result.state === 'completed') completed += 1;
  }
  return completed;
};

export const handleDeleteVault = async (context: RequestContext): Promise<Response> => {
  const input = await readCanonicalJson(context.request, vaultDeletionRequestSchema);
  const [idempotencyHash, transcriptHash, secondFactorHash] = await Promise.all([
    hashEncodedSecret(SYNC_DOMAIN_LABELS.vaultDeletionRequest, input.transcript.idempotencyKey, 16),
    hashDomainSeparatedCanonical(SYNC_DOMAIN_LABELS.vaultDeletion, input.transcript),
    hashDomainSeparatedCanonical(SYNC_DOMAIN_LABELS.vaultDeletionRequest, {
      gateProof: input.gateProof,
      recoverySignature: input.recoverySignature,
    }),
  ]);
  const existing = await loadDeletionJob(
    context.env.MIRNA_SYNC_DB,
    input.transcript.idempotencyKey,
  );
  if (existing) {
    if (
      existing.vault_id !== input.transcript.vaultId ||
      existing.requested_by_device_id !== input.transcript.authorizingDeviceId ||
      !timingSafeEqual(new Uint8Array(existing.idempotency_key_hash), idempotencyHash) ||
      !timingSafeEqual(
        new Uint8Array(existing.authorization_transcript_hash),
        base64UrlToBytes(transcriptHash),
      ) ||
      !timingSafeEqual(
        new Uint8Array(existing.authorization_signature),
        base64UrlToBytes(input.deviceSignature),
      ) ||
      !timingSafeEqual(
        new Uint8Array(existing.second_factor_proof_hash),
        base64UrlToBytes(secondFactorHash),
      )
    ) {
      throw conflict('DELETION_IDEMPOTENCY_REUSED', 'Deletion identity was already used.');
    }
    markBusinessCommit(context, 'vault-delete-init', true);
    return responseForJob(context, existing);
  }

  const authenticated = await authenticateRequest(context);
  const transcript = input.transcript;
  const recoveryAuthorization = await authorizeRecoveryCapability(context, {
    challenge: transcript.recoveryChallenge,
    gateKey: input.gateKey,
    transcript,
    gateProof: input.gateProof,
  });
  const manifest = recoveryAuthorization.currentManifest;
  const authorizer = manifest.devices.find((device) => device.deviceId === authenticated.deviceId);
  if (
    !authorizer ||
    transcript.vaultId !== authenticated.vaultId ||
    transcript.authorizingDeviceId !== authenticated.deviceId ||
    transcript.recoveryChallenge.newDeviceId !== authenticated.deviceId ||
    transcript.recoveryChallenge.newDevicePublicKeys.signing.value !==
      authorizer.publicKeys.signing.value ||
    transcript.recoveryChallenge.newDevicePublicKeys.agreement.value !==
      authorizer.publicKeys.agreement.value ||
    transcript.manifestVersion !== manifest.manifestVersion ||
    transcript.manifestHash !== (await manifestBodyHash(manifest)) ||
    transcript.origin !== context.allowedOrigin ||
    transcript.issuedAt !== transcript.recoveryChallenge.issuedAt ||
    transcript.expiresAt !== transcript.recoveryChallenge.expiresAt ||
    Date.parse(transcript.expiresAt) <= Date.now()
  ) {
    throw forbidden('DELETION_CONTEXT_MISMATCH', 'Deletion context is invalid.');
  }
  const [deviceKey, recoveryKey] = await Promise.all([
    importSigningPublicKey({ format: 'raw-p256', value: authenticated.signingPublicKeyRaw }),
    importSigningPublicKey({
      format: 'raw-p256',
      value: recoveryAuthorization.recoverySigningPublicKeyRaw,
    }),
  ]);
  const [deviceSignatureValid, recoverySignatureValid] = await Promise.all([
    verifyDomainSeparatedCanonicalSignature(
      SYNC_DOMAIN_LABELS.vaultDeletion,
      transcript,
      input.deviceSignature,
      deviceKey,
    ),
    verifyDomainSeparatedCanonicalSignature(
      SYNC_DOMAIN_LABELS.vaultDeletion,
      transcript,
      input.recoverySignature,
      recoveryKey,
    ),
  ]);
  if (!deviceSignatureValid || !recoverySignatureValid) {
    throw forbidden('DELETION_SIGNATURE_INVALID', 'Deletion signature is invalid.');
  }

  const now = Date.now();
  let results: D1Result<unknown>[];
  try {
    results = await context.env.MIRNA_SYNC_DB.batch([
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO deletion_requests (
           deletion_request_id, vault_id, requested_by_device_id,
           idempotency_key_hash, authorization_transcript_hash,
           authorization_signature, second_factor_proof_hash,
           state, resume_after_r2_key, safe_error_code,
           created_at, updated_at, expires_at, stale_after,
           retention_expires_at, completed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', NULL, NULL,
                   ?8, ?8, ?9, ?10, ?11, NULL)`,
      ).bind(
        transcript.idempotencyKey,
        authenticated.vaultId,
        authenticated.deviceId,
        toDatabaseBlob(idempotencyHash),
        encodedToDatabaseBlob(transcriptHash, 32),
        encodedToDatabaseBlob(input.deviceSignature, 64),
        encodedToDatabaseBlob(secondFactorHash, 32),
        now,
        Date.parse(transcript.expiresAt),
        now + 15 * 60 * 1_000,
        now + 24 * 60 * 60 * 1_000,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE vaults SET status = 'deleting', updated_at = ?2
          WHERE vault_id = ?1 AND status = 'active'
            AND current_manifest_version = ?3`,
      ).bind(authenticated.vaultId, now, manifest.manifestVersion),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE access_sessions SET revoked_at = ?2
          WHERE vault_id = ?1 AND revoked_at IS NULL AND expires_at > ?2`,
      ).bind(authenticated.vaultId, now),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE recovery_challenges SET consumed_at = ?2
          WHERE challenge_id = ?1 AND consumed_at IS NULL AND expires_at > ?2`,
      ).bind(recoveryAuthorization.challengeId, now),
    ]);
  } catch {
    const raced = await loadDeletionJob(context.env.MIRNA_SYNC_DB, transcript.idempotencyKey);
    if (raced) {
      markBusinessCommit(context, 'vault-delete-init', true);
      return responseForJob(context, raced);
    }
    throw conflict('DELETION_STATE_CHANGED', 'Deletion state changed.');
  }
  if (
    results[0]?.meta.changes !== 1 ||
    results[1]?.meta.changes !== 1 ||
    results[3]?.meta.changes !== 1
  ) {
    throw conflict('DELETION_STATE_CHANGED', 'Deletion state changed.');
  }
  const created = await loadDeletionJob(context.env.MIRNA_SYNC_DB, transcript.idempotencyKey);
  if (!created) throw new Error('Deletion job disappeared after creation.');
  markBusinessCommit(context, 'vault-delete-init');
  return responseForJob(context, created);
};
