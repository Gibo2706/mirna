import { canonicalizeJson } from '../../../src/domain/sync/canonical';
import { SYNC_DOMAIN_LABELS } from '../../../src/domain/sync/constants';
import {
  hashDomainSeparatedCanonical,
  hashRecoveryGateKey,
  importSigningPublicKey,
  verifyDomainSeparatedCanonicalSignature,
  verifyRecoveryProof,
} from '../../../src/domain/sync/crypto';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  clearBytes,
  timingSafeEqual,
} from '../../../src/domain/sync/encoding';
import { manifestBodyHash, validateManifestTransition } from '../../../src/domain/sync/manifest';
import {
  recoveryBundleFetchRequestSchema,
  recoveryBundleFetchResponseSchema,
  recoveryChallengeRequestSchema,
  recoveryChallengeSchema,
  recoveryCompleteRequestSchema,
  recoveryCompleteResponseSchema,
  vaultManifestSchema,
  type RecoveryRecordV1,
  type VaultManifestV1,
} from '../../../src/domain/sync/schemas';
import type { RequestContext } from './context';
import { assertFreshDeviceAuthorization } from './authorization';
import { conflict, forbidden, HttpError, notFound } from './errors';
import { jsonResponse } from './http';
import { readWorkerLimits } from './limits';
import { assertValidDevicePublicKeys, assertValidSigningPublicKey } from './public-keys';
import {
  canonicalText,
  domainHashBytes,
  encodedToDatabaseBlob,
  isoTimestamp,
  randomOpaqueId,
  randomSecret,
  toDatabaseBlob,
} from './server-crypto';
import { readCanonicalJson } from './validation';

interface ActiveRecoveryRow {
  recovery_lookup_id: string;
  vault_id: string;
  recovery_version: number;
  key_epoch: number;
  recovery_gate_key_hash: ArrayBuffer;
  recovery_signing_public_key_raw: string;
  manifest_version: number;
  manifest_hash: ArrayBuffer;
  current_manifest_hash: ArrayBuffer;
  canonical_recovery_envelope: string;
  failed_attempts: number;
  locked_until: number | null;
  canonical_manifest: string;
  current_manifest_version: number;
  current_key_epoch: number;
  current_snapshot_revision: number;
}

interface StoredRecoveryChallengeRow extends ActiveRecoveryRow {
  challenge_id: string;
  new_device_id: string;
  new_signing_public_key_raw: string;
  new_agreement_public_key_raw: string;
  origin: string;
  challenge_hash: ArrayBuffer;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

interface CompletedRecoveryRow {
  idempotency_key_hash: ArrayBuffer;
  complete_request_hash: ArrayBuffer;
  canonical_complete_response: string;
}

const completedRecoveryRetry = async (
  context: RequestContext,
  challengeId: string,
  idempotencyHash: Uint8Array,
  requestHash: string,
): Promise<Response | null> => {
  const completed = await context.env.MIRNA_SYNC_DB.prepare(
    `SELECT idempotency_key_hash, complete_request_hash, canonical_complete_response
       FROM recovery_challenges
      WHERE challenge_id = ?1
        AND completed_at IS NOT NULL
      LIMIT 1`,
  )
    .bind(challengeId)
    .first<CompletedRecoveryRow>();
  if (!completed) return null;
  if (
    !timingSafeEqual(new Uint8Array(completed.idempotency_key_hash), idempotencyHash) ||
    !timingSafeEqual(new Uint8Array(completed.complete_request_hash), base64UrlToBytes(requestHash))
  ) {
    throw conflict(
      'RECOVERY_IDEMPOTENCY_REUSED',
      'Recovery retry does not match the completed request.',
    );
  }
  return jsonResponse(
    recoveryCompleteResponseSchema.parse(JSON.parse(completed.canonical_complete_response)),
    { requestId: context.requestId, allowedOrigin: context.allowedOrigin },
  );
};

const RECOVERY_RETRY_RETENTION_MS = 24 * 60 * 60 * 1_000;

const equal = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

const activeRecovery = (
  database: D1Database,
  recoveryLookupId: string,
): Promise<ActiveRecoveryRow | null> =>
  database
    .prepare(
      `SELECT r.*, v.current_manifest_version, v.current_key_epoch,
              v.current_snapshot_revision, m.canonical_manifest,
              m.manifest_hash AS current_manifest_hash
         FROM recovery_records r
         JOIN vaults v
           ON v.vault_id = r.vault_id
          AND v.status = 'active'
         JOIN vault_manifests m
           ON m.vault_id = v.vault_id
          AND m.manifest_version = v.current_manifest_version
        WHERE r.recovery_lookup_id = ?1
          AND r.rotated_at IS NULL
        LIMIT 1`,
    )
    .bind(recoveryLookupId)
    .first<ActiveRecoveryRow>();

export const handleRecoveryChallenge = async (context: RequestContext): Promise<Response> => {
  const input = await readCanonicalJson(context.request, recoveryChallengeRequestSchema);
  await assertValidDevicePublicKeys(input.newDevicePublicKeys);
  if (context.allowedOrigin === null || input.origin !== context.allowedOrigin) {
    throw forbidden('ORIGIN_MISMATCH', 'Recovery origin does not match the request origin.');
  }
  const now = Date.now();
  await context.env.MIRNA_SYNC_DB.prepare(
    `UPDATE recovery_records
        SET failed_attempts = 0, locked_until = NULL
      WHERE recovery_lookup_id = ?1
        AND rotated_at IS NULL
        AND locked_until IS NOT NULL
        AND locked_until <= ?2`,
  )
    .bind(input.recoveryLookupId, now)
    .run();
  const recovery = await activeRecovery(context.env.MIRNA_SYNC_DB, input.recoveryLookupId);
  if (!recovery || (recovery.locked_until !== null && recovery.locked_until > now)) {
    throw notFound();
  }
  const activeChallenges = await context.env.MIRNA_SYNC_DB.prepare(
    `SELECT COUNT(*) AS count
       FROM recovery_challenges
      WHERE recovery_lookup_id = ?1
        AND consumed_at IS NULL
        AND expires_at > ?2`,
  )
    .bind(input.recoveryLookupId, now)
    .first<{ count: number }>();
  if ((activeChallenges?.count ?? 0) >= 3) {
    throw new HttpError(429, 'RECOVERY_CHALLENGE_LIMIT', 'Too many recovery attempts.');
  }

  const challengeId = randomOpaqueId();
  const challenge = randomSecret();
  const expiresAt = now + readWorkerLimits(context.env).challengeLifetimeMs;
  const previousManifestHash = bytesToBase64Url(new Uint8Array(recovery.current_manifest_hash));
  const response = recoveryChallengeSchema.parse({
    type: 'mirna-recovery-challenge-v1',
    protocolVersion: 1,
    suite: input.suite,
    recoveryLookupId: input.recoveryLookupId,
    vaultId: recovery.vault_id,
    challengeId,
    challenge,
    newDeviceId: input.newDeviceId,
    newDevicePublicKeys: input.newDevicePublicKeys,
    previousManifestVersion: recovery.current_manifest_version,
    previousManifestHash,
    origin: input.origin,
    issuedAt: isoTimestamp(now),
    expiresAt: isoTimestamp(expiresAt),
  });
  const challengeHash = await domainHashBytes(
    SYNC_DOMAIN_LABELS.recoveryChallengeHash,
    base64UrlToBytes(challenge),
  );
  const inserted = await context.env.MIRNA_SYNC_DB.prepare(
    `INSERT INTO recovery_challenges (
       challenge_id, recovery_lookup_id, new_device_id,
       new_signing_public_key_raw, new_agreement_public_key_raw, origin,
       challenge_hash, created_at, expires_at, consumed_at,
       idempotency_key_hash, complete_request_hash, canonical_complete_response,
       completed_at, retention_expires_at
     )
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, NULL, NULL, NULL, ?10
      WHERE (
        SELECT COUNT(*)
          FROM recovery_challenges
         WHERE recovery_lookup_id = ?2
           AND consumed_at IS NULL
           AND expires_at > ?8
      ) < 3`,
  )
    .bind(
      challengeId,
      input.recoveryLookupId,
      input.newDeviceId,
      input.newDevicePublicKeys.signing.value,
      input.newDevicePublicKeys.agreement.value,
      input.origin,
      toDatabaseBlob(challengeHash),
      now,
      expiresAt,
      expiresAt + RECOVERY_RETRY_RETENTION_MS,
    )
    .run();
  if (inserted.meta.changes !== 1) {
    throw new HttpError(429, 'RECOVERY_CHALLENGE_LIMIT', 'Too many recovery attempts.');
  }
  return jsonResponse(response, {
    status: 201,
    requestId: context.requestId,
    allowedOrigin: context.allowedOrigin,
  });
};

const storedRecoveryChallenge = async (
  database: D1Database,
  challengeId: string,
): Promise<StoredRecoveryChallengeRow | null> =>
  database
    .prepare(
      `SELECT c.*, r.vault_id, r.recovery_version, r.key_epoch,
              r.recovery_gate_key_hash,
              r.recovery_signing_public_key_raw, r.manifest_version,
              r.manifest_hash, r.canonical_recovery_envelope,
              r.failed_attempts, r.locked_until,
              v.current_manifest_version, v.current_key_epoch,
              v.current_snapshot_revision, m.canonical_manifest,
              m.manifest_hash AS current_manifest_hash
         FROM recovery_challenges c
         JOIN recovery_records r
           ON r.recovery_lookup_id = c.recovery_lookup_id
          AND r.rotated_at IS NULL
         JOIN vaults v
           ON v.vault_id = r.vault_id
          AND v.status = 'active'
         JOIN vault_manifests m
           ON m.vault_id = v.vault_id
          AND m.manifest_version = v.current_manifest_version
        WHERE c.challenge_id = ?1
        LIMIT 1`,
    )
    .bind(challengeId)
    .first<StoredRecoveryChallengeRow>();

const registerRecoveryFailure = async (
  context: RequestContext,
  row: StoredRecoveryChallengeRow,
): Promise<void> => {
  const now = Date.now();
  const maximum = readWorkerLimits(context.env).maxRecoveryAttempts;
  await context.env.MIRNA_SYNC_DB.prepare(
    `UPDATE recovery_records
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE
              WHEN failed_attempts + 1 >= ?2 THEN ?3
              ELSE locked_until
            END
      WHERE recovery_lookup_id = ?1
        AND rotated_at IS NULL
        AND failed_attempts < ?2`,
  )
    .bind(row.recovery_lookup_id, maximum, now + 15 * 60 * 1_000)
    .run();
};

const verifyGate = async (
  context: RequestContext,
  row: StoredRecoveryChallengeRow,
  gateKey: string,
  transcript: unknown,
  proof: string,
): Promise<void> => {
  let gateBytes: Uint8Array | undefined;
  try {
    gateBytes = base64UrlToBytes(gateKey);
    const actualHash = await hashRecoveryGateKey(gateBytes);
    const expectedHash = bytesToBase64Url(new Uint8Array(row.recovery_gate_key_hash));
    if (
      gateBytes.length !== 32 ||
      !timingSafeEqual(base64UrlToBytes(actualHash), base64UrlToBytes(expectedHash)) ||
      !(await verifyRecoveryProof(transcript, proof, gateBytes))
    ) {
      throw new Error('Invalid gate proof.');
    }
    if (row.failed_attempts > 0 || row.locked_until !== null) {
      await context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE recovery_records
            SET failed_attempts = 0, locked_until = NULL
          WHERE recovery_lookup_id = ?1
            AND rotated_at IS NULL`,
      )
        .bind(row.recovery_lookup_id)
        .run();
    }
  } catch {
    await registerRecoveryFailure(context, row);
    throw forbidden('RECOVERY_PROOF_INVALID', 'Recovery authorization failed.');
  } finally {
    if (gateBytes) clearBytes(gateBytes);
  }
};

const assertFetchChallenge = (
  context: RequestContext,
  row: StoredRecoveryChallengeRow,
  challenge: ReturnType<typeof recoveryChallengeSchema.parse>,
): void => {
  if (
    row.consumed_at !== null ||
    row.expires_at <= Date.now() ||
    row.failed_attempts >= readWorkerLimits(context.env).maxRecoveryAttempts ||
    (row.locked_until !== null && row.locked_until > Date.now()) ||
    row.recovery_lookup_id !== challenge.recoveryLookupId ||
    row.vault_id !== challenge.vaultId ||
    row.new_device_id !== challenge.newDeviceId ||
    row.new_signing_public_key_raw !== challenge.newDevicePublicKeys.signing.value ||
    row.new_agreement_public_key_raw !== challenge.newDevicePublicKeys.agreement.value ||
    row.origin !== context.allowedOrigin ||
    row.origin !== challenge.origin ||
    row.created_at !== Date.parse(challenge.issuedAt) ||
    row.expires_at !== Date.parse(challenge.expiresAt) ||
    row.current_manifest_version !== challenge.previousManifestVersion ||
    bytesToBase64Url(new Uint8Array(row.current_manifest_hash)) !== challenge.previousManifestHash
  ) {
    throw forbidden('RECOVERY_CHALLENGE_MISMATCH', 'Recovery challenge context is invalid.');
  }
};

export const handleFetchRecoveryBundle = async (context: RequestContext): Promise<Response> => {
  const input = await readCanonicalJson(context.request, recoveryBundleFetchRequestSchema);
  const row = await storedRecoveryChallenge(
    context.env.MIRNA_SYNC_DB,
    input.transcript.challenge.challengeId,
  );
  if (!row) throw notFound();
  assertFetchChallenge(context, row, input.transcript.challenge);
  const expectedChallengeHash = await domainHashBytes(
    SYNC_DOMAIN_LABELS.recoveryChallengeHash,
    base64UrlToBytes(input.transcript.challenge.challenge),
  );
  if (!timingSafeEqual(expectedChallengeHash, new Uint8Array(row.challenge_hash))) {
    throw forbidden('RECOVERY_CHALLENGE_MISMATCH', 'Recovery challenge is invalid.');
  }
  await verifyGate(context, row, input.gateKey, input.transcript, input.gateProof);
  const afterManifestVersion = input.transcript.afterManifestVersion;
  if (
    afterManifestVersion !== null &&
    (afterManifestVersion < row.manifest_version ||
      afterManifestVersion >= row.current_manifest_version)
  ) {
    throw forbidden('RECOVERY_MANIFEST_CURSOR_INVALID', 'Recovery manifest cursor is invalid.');
  }
  const manifests = await context.env.MIRNA_SYNC_DB.prepare(
    `SELECT manifest_version, canonical_manifest
       FROM vault_manifests
      WHERE vault_id = ?1
        AND manifest_version >= ?2
        AND (?4 IS NULL OR manifest_version > ?4)
        AND manifest_version <= ?3
      ORDER BY manifest_version
      LIMIT 26`,
  )
    .bind(
      row.vault_id,
      row.manifest_version,
      row.current_manifest_version,
      input.transcript.afterManifestVersion,
    )
    .all<{ manifest_version: number; canonical_manifest: string }>();
  const page = manifests.results.slice(0, 25);
  if (page.length === 0) {
    throw forbidden('RECOVERY_MANIFEST_CURSOR_INVALID', 'Recovery manifest cursor is invalid.');
  }
  const nextAfterManifestVersion =
    manifests.results.length > page.length ? (page.at(-1)?.manifest_version ?? null) : null;
  return jsonResponse(
    recoveryBundleFetchResponseSchema.parse({
      protocolVersion: 1,
      recoveryEnvelope: JSON.parse(row.canonical_recovery_envelope) as unknown,
      manifestChain: page.map((manifest) => JSON.parse(manifest.canonical_manifest) as unknown),
      nextAfterManifestVersion,
    }),
    { requestId: context.requestId, allowedOrigin: context.allowedOrigin },
  );
};

const assertNewRecoveryBinding = (
  newManifest: VaultManifestV1,
  newRecovery: RecoveryRecordV1,
  newManifestHash: string,
): void => {
  const envelope = newRecovery.recoveryEnvelope;
  if (
    newRecovery.protocolVersion !== newManifest.protocolVersion ||
    newRecovery.suite !== newManifest.suite ||
    newRecovery.vaultId !== newManifest.vaultId ||
    newRecovery.recoveryLookupId !== newManifest.recoveryLookupId ||
    newRecovery.keyEpoch !== newManifest.keyEpoch ||
    newRecovery.manifestVersion !== newManifest.manifestVersion ||
    newRecovery.manifestHash !== newManifestHash ||
    newRecovery.updatedAt !== newManifest.transition.occurredAt ||
    !equal(newRecovery.recoverySigningPublicKey, newManifest.recoverySigningPublicKey) ||
    envelope.protocolVersion !== newManifest.protocolVersion ||
    envelope.suite !== newManifest.suite ||
    envelope.vaultId !== newManifest.vaultId ||
    envelope.keyEpoch !== newManifest.keyEpoch ||
    envelope.objectId !== envelope.aad.objectId ||
    envelope.aad.protocolVersion !== newManifest.protocolVersion ||
    envelope.aad.suite !== newManifest.suite ||
    envelope.aad.vaultId !== newManifest.vaultId ||
    envelope.aad.keyEpoch !== newManifest.keyEpoch ||
    envelope.aad.objectType !== 'recovery-vault-key' ||
    envelope.aad.creatingDeviceId !== newManifest.transition.affectedDeviceId ||
    envelope.aad.recoveryLookupId !== newManifest.recoveryLookupId ||
    envelope.aad.parentManifestHash !== newManifestHash
  ) {
    throw conflict('NEW_RECOVERY_BINDING_INVALID', 'New recovery record is inconsistent.');
  }
};

export const handleCompleteRecovery = async (
  context: RequestContext,
  routeVaultId: string,
): Promise<Response> => {
  const input = await readCanonicalJson(context.request, recoveryCompleteRequestSchema);
  if (
    routeVaultId !== input.transcript.vaultId ||
    input.transcript.path !== `/v1/vaults/${routeVaultId}/recover`
  ) {
    throw forbidden('RECOVERY_TRANSCRIPT_MISMATCH', 'Recovery transition context is invalid.');
  }
  const requestHash = await hashDomainSeparatedCanonical(
    SYNC_DOMAIN_LABELS.recoveryCompleteRequest,
    input,
  );
  const idempotencyHash = await domainHashBytes(
    SYNC_DOMAIN_LABELS.recoveryIdempotencyHash,
    base64UrlToBytes(input.transcript.idempotencyKey),
  );
  const completed = await completedRecoveryRetry(
    context,
    input.transcript.challengeId,
    idempotencyHash,
    requestHash,
  );
  if (completed) return completed;
  const row = await storedRecoveryChallenge(
    context.env.MIRNA_SYNC_DB,
    input.transcript.challengeId,
  );
  if (!row) throw notFound();
  const previousManifest = vaultManifestSchema.parse(JSON.parse(row.canonical_manifest));
  const previousManifestHash = await manifestBodyHash(previousManifest);
  const newManifestHash = await manifestBodyHash(input.newManifest);
  const newRecoveryHash = await hashDomainSeparatedCanonical(
    SYNC_DOMAIN_LABELS.recoveryRecord,
    input.newRecovery,
  );
  if (
    row.consumed_at !== null ||
    row.expires_at <= Date.now() ||
    row.failed_attempts >= readWorkerLimits(context.env).maxRecoveryAttempts ||
    (row.locked_until !== null && row.locked_until > Date.now()) ||
    row.current_snapshot_revision !== 0 ||
    routeVaultId !== row.vault_id ||
    input.transcript.recoveryLookupId !== row.recovery_lookup_id ||
    input.transcript.vaultId !== row.vault_id ||
    input.transcript.newDeviceId !== row.new_device_id ||
    !equal(input.transcript.newDevicePublicKeys, {
      signing: { format: 'raw-p256', value: row.new_signing_public_key_raw },
      agreement: { format: 'raw-p256', value: row.new_agreement_public_key_raw },
    }) ||
    input.transcript.previousManifestVersion !== row.current_manifest_version ||
    input.transcript.previousManifestHash !== previousManifestHash ||
    input.transcript.transitionBodyHash !== newManifestHash ||
    input.transcript.newRecoveryBundleHash !== newRecoveryHash ||
    input.transcript.newRecoveryLookupId !== input.newRecovery.recoveryLookupId ||
    input.transcript.issuedAt !== isoTimestamp(row.created_at) ||
    input.transcript.expiresAt !== isoTimestamp(row.expires_at) ||
    input.transcript.origin !== context.allowedOrigin ||
    input.transcript.method !== 'POST' ||
    input.transcript.path !== `/v1/vaults/${row.vault_id}/recover`
  ) {
    throw forbidden('RECOVERY_TRANSCRIPT_MISMATCH', 'Recovery transition context is invalid.');
  }
  const expectedChallengeHash = await domainHashBytes(
    SYNC_DOMAIN_LABELS.recoveryChallengeHash,
    base64UrlToBytes(input.transcript.challenge),
  );
  if (!timingSafeEqual(expectedChallengeHash, new Uint8Array(row.challenge_hash))) {
    throw forbidden('RECOVERY_CHALLENGE_MISMATCH', 'Recovery challenge is invalid.');
  }
  await verifyGate(context, row, input.gateKey, input.transcript, input.gateProof);
  const recoverySigningKey = await importSigningPublicKey(
    previousManifest.recoverySigningPublicKey,
  );
  if (
    !(await verifyDomainSeparatedCanonicalSignature(
      SYNC_DOMAIN_LABELS.recoveryTransition,
      input.transcript,
      input.recoveryAuthorizationSignature,
      recoverySigningKey,
    ))
  ) {
    throw forbidden('RECOVERY_SIGNATURE_INVALID', 'Recovery transition signature is invalid.');
  }
  await validateManifestTransition(previousManifest, input.newManifest);
  assertNewRecoveryBinding(input.newManifest, input.newRecovery, newManifestHash);
  assertFreshDeviceAuthorization(input.newManifest, Date.now(), readWorkerLimits(context.env));
  const newDevice = input.newManifest.devices[0];
  if (
    !newDevice ||
    newDevice.deviceId !== row.new_device_id ||
    newDevice.publicKeys.signing.value !== row.new_signing_public_key_raw ||
    newDevice.publicKeys.agreement.value !== row.new_agreement_public_key_raw
  ) {
    throw forbidden('RECOVERY_DEVICE_MISMATCH', 'Recovered device does not match the challenge.');
  }
  await Promise.all([
    assertValidDevicePublicKeys(newDevice.publicKeys),
    assertValidSigningPublicKey(input.newManifest.recoverySigningPublicKey),
  ]);

  const now = Date.now();
  const response = recoveryCompleteResponseSchema.parse({
    protocolVersion: 1,
    vaultId: row.vault_id,
    deviceId: newDevice.deviceId,
    manifestVersion: input.newManifest.manifestVersion,
    recovered: true,
  });
  let results: D1Result<unknown>[];
  try {
    results = await context.env.MIRNA_SYNC_DB.batch([
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO vault_manifests (
         vault_id, manifest_version, key_epoch, authorization_kind,
         signed_by_device_id, canonical_manifest, manifest_hash,
         previous_manifest_hash, signature, accepted_at
       )
       SELECT ?1, ?2, ?3, 'recovery', NULL, ?4, ?5, ?6, ?7, ?8
         FROM vaults v
         JOIN recovery_challenges c ON c.challenge_id = ?9
        WHERE v.vault_id = ?1
          AND v.status = 'active'
          AND v.current_manifest_version = ?10
          AND c.consumed_at IS NULL
          AND c.expires_at > ?8`,
      ).bind(
        row.vault_id,
        input.newManifest.manifestVersion,
        input.newManifest.keyEpoch,
        canonicalText(input.newManifest),
        encodedToDatabaseBlob(newManifestHash, 32),
        encodedToDatabaseBlob(previousManifestHash, 32),
        encodedToDatabaseBlob(input.newManifest.signature, 64),
        now,
        row.challenge_id,
        row.current_manifest_version,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO devices (
         vault_id, device_id, signing_public_key_raw, agreement_public_key_raw,
         status, added_in_manifest_version, created_at, revoked_at, last_seen_at
       ) VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, NULL, NULL)`,
      ).bind(
        row.vault_id,
        newDevice.deviceId,
        newDevice.publicKeys.signing.value,
        newDevice.publicKeys.agreement.value,
        input.newManifest.manifestVersion,
        now,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE devices
          SET status = 'revoked', revoked_at = ?2
        WHERE vault_id = ?1
          AND device_id <> ?3
          AND status = 'active'`,
      ).bind(row.vault_id, now, newDevice.deviceId),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE device_grants
          SET revoked_at = ?2
        WHERE vault_id = ?1
          AND revoked_at IS NULL`,
      ).bind(row.vault_id, now),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO device_grants (
         grant_id, vault_id, device_id, grant_version, issued_by_device_id,
         authorization_transcript_hash, authorization_signature, issued_at,
         expires_at, revoked_at
       ) VALUES (?1, ?2, ?3, 1, NULL, ?4, ?5, ?6, ?7, NULL)`,
      ).bind(
        input.newManifest.transition.transitionId,
        row.vault_id,
        newDevice.deviceId,
        encodedToDatabaseBlob(newManifestHash, 32),
        encodedToDatabaseBlob(input.newManifest.signature, 64),
        now,
        Date.parse(newDevice.authorizationExpiresAt),
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE access_sessions SET revoked_at = ?2 WHERE vault_id = ?1 AND revoked_at IS NULL`,
      ).bind(row.vault_id, now),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE pairing_requests
          SET status = 'cancelled', cancelled_at = ?2
        WHERE vault_id = ?1
          AND status IN ('pending', 'approved')`,
      ).bind(row.vault_id, now),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE recovery_records
          SET rotated_at = ?2
        WHERE recovery_lookup_id = ?1
          AND rotated_at IS NULL`,
      ).bind(row.recovery_lookup_id, now),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO recovery_records (
         recovery_lookup_id, vault_id, recovery_version, key_epoch,
         recovery_gate_key_hash, recovery_signing_public_key_raw,
         manifest_version, manifest_hash, crypto_suite,
         canonical_recovery_envelope, failed_attempts, locked_until,
         signed_updated_at, created_at, rotated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, NULL, ?11, ?12, NULL)`,
      ).bind(
        input.newRecovery.recoveryLookupId,
        row.vault_id,
        row.recovery_version + 1,
        input.newRecovery.keyEpoch,
        encodedToDatabaseBlob(input.newRecovery.recoveryGateKeyHash, 32),
        input.newRecovery.recoverySigningPublicKey.value,
        input.newRecovery.manifestVersion,
        encodedToDatabaseBlob(newManifestHash, 32),
        input.newRecovery.suite,
        canonicalText(input.newRecovery.recoveryEnvelope),
        Date.parse(input.newRecovery.updatedAt),
        now,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE vaults
          SET current_manifest_version = ?2,
              current_key_epoch = ?3,
              updated_at = ?4
        WHERE vault_id = ?1
          AND current_manifest_version = ?5`,
      ).bind(
        row.vault_id,
        input.newManifest.manifestVersion,
        input.newManifest.keyEpoch,
        now,
        row.current_manifest_version,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE recovery_challenges
          SET consumed_at = ?2,
              idempotency_key_hash = ?3,
              complete_request_hash = ?4,
              canonical_complete_response = ?5,
              completed_at = ?2,
              retention_expires_at = ?6
        WHERE challenge_id = ?1
          AND consumed_at IS NULL
          AND expires_at > ?2`,
      ).bind(
        row.challenge_id,
        now,
        toDatabaseBlob(idempotencyHash),
        encodedToDatabaseBlob(requestHash, 32),
        canonicalText(response),
        now + RECOVERY_RETRY_RETENTION_MS,
      ),
    ]);
  } catch {
    const raced = await completedRecoveryRetry(
      context,
      input.transcript.challengeId,
      idempotencyHash,
      requestHash,
    );
    if (raced) return raced;
    throw conflict('RECOVERY_STATE_CONFLICT', 'Recovery lost its state race.');
  }
  if (
    results[0]?.meta.changes !== 1 ||
    results[1]?.meta.changes !== 1 ||
    results[7]?.meta.changes !== 1 ||
    results[8]?.meta.changes !== 1 ||
    results[9]?.meta.changes !== 1 ||
    results[10]?.meta.changes !== 1
  ) {
    const raced = await completedRecoveryRetry(
      context,
      input.transcript.challengeId,
      idempotencyHash,
      requestHash,
    );
    if (raced) return raced;
    throw conflict('RECOVERY_STATE_CONFLICT', 'Recovery lost its state race.');
  }

  return jsonResponse(response, {
    status: 201,
    requestId: context.requestId,
    allowedOrigin: context.allowedOrigin,
  });
};
