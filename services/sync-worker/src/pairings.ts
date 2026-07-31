import { canonicalizeJson } from '../../../src/domain/sync/canonical';
import { SYNC_DOMAIN_LABELS, SYNC_PROTOCOL_VERSION } from '../../../src/domain/sync/constants';
import {
  hashDomainSeparatedCanonical,
  hashPairingClaimToken,
  importSigningPublicKey,
  sha256,
  verifyDomainSeparatedCanonicalSignature,
} from '../../../src/domain/sync/crypto';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  timingSafeEqual,
} from '../../../src/domain/sync/encoding';
import { manifestBodyHash, validateManifestTransition } from '../../../src/domain/sync/manifest';
import {
  pairingApprovalSchema,
  pairingCancelRequestSchema,
  pairingCandidateSchema,
  pairingCreateRequestSchema,
  pairingCreateResponseSchema,
  pairingFinalizeRequestSchema,
  pairingFinalizeResponseSchema,
  pairingInspectRequestSchema,
  pairingPollRequestSchema,
  pairingPollResponseSchema,
  unsignedPairingEnvelopeSchema,
  vaultManifestSchema,
  type PairingEnvelopeV1,
  type VaultManifestV1,
} from '../../../src/domain/sync/schemas';
import { authenticateRequest, consumeSensitiveChallenge, type AuthenticatedDevice } from './auth';
import { assertFreshDeviceAuthorization } from './authorization';
import type { RequestContext } from './context';
import { conflict, forbidden, HttpError, notFound } from './errors';
import { jsonResponse } from './http';
import { readWorkerLimits } from './limits';
import { assertValidDevicePublicKeys } from './public-keys';
import {
  canonicalText,
  encodedToDatabaseBlob,
  hashEncodedSecret,
  isoTimestamp,
  toDatabaseBlob,
} from './server-crypto';
import { readCanonicalJson } from './validation';

interface PairingRequestRow {
  pairing_request_id: string;
  vault_id: string | null;
  new_device_id: string;
  new_signing_public_key_raw: string;
  new_agreement_public_key_raw: string;
  pairing_salt: ArrayBuffer;
  pairing_claim_token_hash: ArrayBuffer;
  polling_token_hash: ArrayBuffer;
  status: 'pending' | 'approved' | 'finalized' | 'cancelled';
  failed_attempts: number;
  max_attempts: number;
  created_at: number;
  expires_at: number;
  finalization_hash: ArrayBuffer | null;
}

interface CurrentVaultRow {
  canonical_manifest: string;
  manifest_hash: ArrayBuffer;
  current_manifest_version: number;
  current_key_epoch: number;
  current_snapshot_id: string | null;
}

interface StoredPairingEnvelopeRow extends PairingRequestRow {
  envelope_id: string;
  canonical_envelope: string;
  envelope_hash: ArrayBuffer;
  candidate_manifest: string;
  candidate_manifest_hash: ArrayBuffer;
  authorizing_device_id: string;
  consumed_at: number | null;
}

interface StoredApprovalRow {
  vault_id: string;
  new_device_id: string;
  authorizing_device_id: string;
  canonical_envelope: string;
  envelope_hash: ArrayBuffer;
  candidate_manifest: string;
  candidate_manifest_hash: ArrayBuffer;
  expires_at: number;
}

const equal = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

const databaseBytes = (value: ArrayBuffer): Uint8Array => new Uint8Array(value);

const isExactPairingRetry = (
  existing: PairingRequestRow,
  input: ReturnType<typeof pairingCreateRequestSchema.parse>,
): boolean =>
  existing.new_device_id === input.deviceId &&
  existing.new_signing_public_key_raw === input.publicKeys.signing.value &&
  existing.new_agreement_public_key_raw === input.publicKeys.agreement.value &&
  timingSafeEqual(databaseBytes(existing.pairing_salt), base64UrlToBytes(input.pairingSalt)) &&
  timingSafeEqual(
    databaseBytes(existing.pairing_claim_token_hash),
    base64UrlToBytes(input.pairingClaimTokenHash),
  ) &&
  timingSafeEqual(
    databaseBytes(existing.polling_token_hash),
    base64UrlToBytes(input.pollingTokenHash),
  );

const pairingCreateResponse = (
  context: RequestContext,
  input: ReturnType<typeof pairingCreateRequestSchema.parse>,
  expiresAt: number,
  created: boolean,
): Response =>
  jsonResponse(
    pairingCreateResponseSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      requestId: input.requestId,
      expiresAt: isoTimestamp(expiresAt),
    }),
    {
      status: created ? 201 : 200,
      requestId: context.requestId,
      allowedOrigin: context.allowedOrigin,
    },
  );

const pairingById = (
  database: D1Database,
  pairingRequestId: string,
): Promise<PairingRequestRow | null> =>
  database
    .prepare(`SELECT * FROM pairing_requests WHERE pairing_request_id = ?1 LIMIT 1`)
    .bind(pairingRequestId)
    .first<PairingRequestRow>();

const recordFailedClaim = async (
  database: D1Database,
  pairingRequestId: string,
  now: number,
): Promise<void> => {
  await database
    .prepare(
      `UPDATE pairing_requests
          SET failed_attempts = MIN(failed_attempts + 1, max_attempts),
              status = CASE
                WHEN failed_attempts + 1 >= max_attempts THEN 'cancelled'
                ELSE status
              END,
              cancelled_at = CASE
                WHEN failed_attempts + 1 >= max_attempts THEN ?2
                ELSE cancelled_at
              END
        WHERE pairing_request_id = ?1
          AND status = 'pending'
          AND expires_at > ?2`,
    )
    .bind(pairingRequestId, now)
    .run();
};

export const handleCreatePairing = async (context: RequestContext): Promise<Response> => {
  const input = await readCanonicalJson(context.request, pairingCreateRequestSchema);
  await assertValidDevicePublicKeys(input.publicKeys);
  const existingBeforeInsert = await pairingById(context.env.MIRNA_SYNC_DB, input.requestId);
  if (existingBeforeInsert) {
    if (!isExactPairingRetry(existingBeforeInsert, input)) {
      throw conflict('PAIRING_ID_REUSED', 'Pairing identifier was already used.');
    }
    return pairingCreateResponse(context, input, existingBeforeInsert.expires_at, false);
  }
  const now = Date.now();
  const activeForDevice = await context.env.MIRNA_SYNC_DB.prepare(
    `SELECT COUNT(*) AS count
       FROM pairing_requests
      WHERE new_device_id = ?1
        AND status IN ('pending', 'approved', 'finalized')
        AND expires_at > ?2`,
  )
    .bind(input.deviceId, now)
    .first<{ count: number }>();
  if ((activeForDevice?.count ?? 0) >= 3) {
    throw new HttpError(429, 'PAIRING_LIMIT_REACHED', 'Too many active pairing requests.');
  }
  const limits = readWorkerLimits(context.env);
  const expiresAt = now + limits.pairingLifetimeMs;
  try {
    const inserted = await context.env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO pairing_requests (
         pairing_request_id, vault_id, new_device_id, new_signing_public_key_raw,
         new_agreement_public_key_raw, pairing_salt, pairing_claim_token_hash,
         polling_token_hash, status, failed_attempts, max_attempts, created_at,
         expires_at, finalized_at, cancelled_at, finalization_hash
       )
       SELECT ?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', 0, 5, ?8, ?9, NULL, NULL, NULL
        WHERE (
          SELECT COUNT(*)
            FROM pairing_requests
           WHERE new_device_id = ?2
             AND status IN ('pending', 'approved')
             AND expires_at > ?8
        ) < 3
          AND (SELECT COUNT(*) FROM pairing_requests) < ?10`,
    )
      .bind(
        input.requestId,
        input.deviceId,
        input.publicKeys.signing.value,
        input.publicKeys.agreement.value,
        encodedToDatabaseBlob(input.pairingSalt, 32),
        encodedToDatabaseBlob(input.pairingClaimTokenHash, 32),
        encodedToDatabaseBlob(input.pollingTokenHash, 32),
        now,
        expiresAt,
        limits.maxTotalPairingRequests,
      )
      .run();
    if (inserted.meta.changes !== 1) {
      throw new HttpError(429, 'PAIRING_LIMIT_REACHED', 'Too many active pairing requests.');
    }
  } catch (error) {
    const existing = await pairingById(context.env.MIRNA_SYNC_DB, input.requestId);
    if (!existing) {
      if (error instanceof HttpError) throw error;
      throw conflict('PAIRING_CREATE_CONFLICT', 'Pairing request could not be created.');
    }
    if (!isExactPairingRetry(existing, input)) {
      throw conflict('PAIRING_ID_REUSED', 'Pairing identifier was already used.');
    }
    return pairingCreateResponse(context, input, existing.expires_at, false);
  }

  return pairingCreateResponse(context, input, expiresAt, true);
};

const inspectPairing = async (
  context: RequestContext,
  pairingRequestId: string,
  claimToken: string,
  allowApproved = false,
): Promise<PairingRequestRow> => {
  const now = Date.now();
  let claimHash: string;
  try {
    claimHash = await hashPairingClaimToken(base64UrlToBytes(claimToken));
  } catch {
    await recordFailedClaim(context.env.MIRNA_SYNC_DB, pairingRequestId, now);
    throw notFound();
  }
  const row = await context.env.MIRNA_SYNC_DB.prepare(
    `SELECT *
       FROM pairing_requests
      WHERE pairing_request_id = ?1
        AND pairing_claim_token_hash = ?2
        AND status IN ('pending', 'approved', 'finalized')
        AND failed_attempts < max_attempts
        AND expires_at > ?3
      LIMIT 1`,
  )
    .bind(pairingRequestId, encodedToDatabaseBlob(claimHash, 32), now)
    .first<PairingRequestRow>();
  if (!row || (!allowApproved && row.status !== 'pending')) {
    await recordFailedClaim(context.env.MIRNA_SYNC_DB, pairingRequestId, now);
    throw notFound();
  }
  return row;
};

const exactStoredApproval = async (
  context: RequestContext,
  request: PairingRequestRow,
  authenticated: AuthenticatedDevice,
  envelope: PairingEnvelopeV1,
  candidateManifest: VaultManifestV1,
  envelopeHash: string,
): Promise<Response | null> => {
  const stored = await context.env.MIRNA_SYNC_DB.prepare(
    `SELECT vault_id, new_device_id, authorizing_device_id, canonical_envelope,
            envelope_hash, candidate_manifest, candidate_manifest_hash, expires_at
       FROM pairing_envelopes
      WHERE pairing_request_id = ?1
      LIMIT 1`,
  )
    .bind(request.pairing_request_id)
    .first<StoredApprovalRow>();
  if (!stored) return null;
  const candidateHash = await manifestBodyHash(candidateManifest);
  if (
    stored.vault_id !== authenticated.vaultId ||
    stored.new_device_id !== request.new_device_id ||
    stored.authorizing_device_id !== authenticated.deviceId ||
    stored.expires_at !== request.expires_at ||
    stored.canonical_envelope !== canonicalText(envelope) ||
    stored.candidate_manifest !== canonicalText(candidateManifest) ||
    !timingSafeEqual(databaseBytes(stored.envelope_hash), base64UrlToBytes(envelopeHash)) ||
    !timingSafeEqual(databaseBytes(stored.candidate_manifest_hash), base64UrlToBytes(candidateHash))
  ) {
    throw conflict('PAIRING_STATE_CHANGED', 'Pairing request was approved with different data.');
  }
  return jsonResponse(
    { protocolVersion: 1, status: 'approved', expiresAt: isoTimestamp(request.expires_at) },
    { requestId: context.requestId, allowedOrigin: context.allowedOrigin },
  );
};

export const handleInspectPairing = async (
  context: RequestContext,
  pairingRequestId: string,
): Promise<Response> => {
  const input = await readCanonicalJson(context.request, pairingInspectRequestSchema);
  const row = await inspectPairing(context, pairingRequestId, input.claimToken);
  return jsonResponse(
    pairingCandidateSchema.parse({
      protocolVersion: 1,
      suite: 'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1',
      requestId: row.pairing_request_id,
      deviceId: row.new_device_id,
      publicKeys: {
        signing: { format: 'raw-p256', value: row.new_signing_public_key_raw },
        agreement: { format: 'raw-p256', value: row.new_agreement_public_key_raw },
      },
      pairingSalt: bytesToBase64Url(databaseBytes(row.pairing_salt)),
      expiresAt: isoTimestamp(row.expires_at),
    }),
    { requestId: context.requestId, allowedOrigin: context.allowedOrigin },
  );
};

const currentVault = (database: D1Database, vaultId: string): Promise<CurrentVaultRow | null> =>
  database
    .prepare(
      `SELECT v.current_manifest_version, v.current_key_epoch, v.current_snapshot_id,
              m.canonical_manifest, m.manifest_hash
         FROM vaults v
         JOIN vault_manifests m
           ON m.vault_id = v.vault_id
          AND m.manifest_version = v.current_manifest_version
        WHERE v.vault_id = ?1
          AND v.status = 'active'
        LIMIT 1`,
    )
    .bind(vaultId)
    .first<CurrentVaultRow>();

const unsignedEnvelope = (envelope: PairingEnvelopeV1) => {
  const {
    signature: _signature,
    transcriptMac: _transcriptMac,
    keyConfirmation: _keyConfirmation,
    ...unsigned
  } = envelope;
  void _signature;
  void _transcriptMac;
  void _keyConfirmation;
  return unsignedPairingEnvelopeSchema.parse(unsigned);
};

const verifyApprovalEnvelope = async (
  context: RequestContext,
  authenticated: AuthenticatedDevice,
  request: PairingRequestRow,
  envelope: PairingEnvelopeV1,
  candidateManifest: VaultManifestV1,
): Promise<{ current: VaultManifestV1; currentHash: string; envelopeHash: string }> => {
  const vault = await currentVault(context.env.MIRNA_SYNC_DB, authenticated.vaultId);
  if (!vault) throw notFound();
  const current = vaultManifestSchema.parse(JSON.parse(vault.canonical_manifest));
  const currentHash = await manifestBodyHash(current);
  const candidateHash = await manifestBodyHash(candidateManifest);
  const contextHash = await hashDomainSeparatedCanonical(
    SYNC_DOMAIN_LABELS.pairingContext,
    envelope.context,
  );
  const ciphertextBytes = base64UrlToBytes(envelope.ciphertext);
  const actualCiphertextHash = bytesToBase64Url(await sha256(ciphertextBytes));
  const authorizer = current.devices.find((device) => device.deviceId === authenticated.deviceId);
  const candidate = candidateManifest.devices.find(
    (device) => device.deviceId === request.new_device_id,
  );
  const pairingSalt = bytesToBase64Url(databaseBytes(request.pairing_salt));

  if (
    !authorizer ||
    !candidate ||
    envelope.context.origin !== context.allowedOrigin ||
    envelope.context.vaultId !== authenticated.vaultId ||
    envelope.context.pairingRequestId !== request.pairing_request_id ||
    envelope.context.pairingExpiresAt !== isoTimestamp(request.expires_at) ||
    envelope.context.currentManifestVersion !== current.manifestVersion ||
    envelope.context.currentManifestHash !== currentHash ||
    envelope.context.keyEpoch !== current.keyEpoch ||
    envelope.context.snapshotCommitId !== vault.current_snapshot_id ||
    envelope.context.operationFrontierHash !== null ||
    envelope.context.authorizingDeviceId !== authenticated.deviceId ||
    !equal(envelope.context.authorizingDevicePublicKeys, authorizer.publicKeys) ||
    envelope.context.newDeviceId !== request.new_device_id ||
    candidate.publicKeys.signing.value !== request.new_signing_public_key_raw ||
    candidate.publicKeys.agreement.value !== request.new_agreement_public_key_raw ||
    !equal(envelope.context.newDevicePublicKeys, candidate.publicKeys) ||
    envelope.context.ecdhSalt !== pairingSalt ||
    envelope.aad.vaultId !== authenticated.vaultId ||
    envelope.aad.keyEpoch !== current.keyEpoch ||
    envelope.aad.creatingDeviceId !== authenticated.deviceId ||
    envelope.aad.parentManifestHash !== currentHash ||
    envelope.aad.pairingContextHash !== contextHash ||
    envelope.ciphertextLength !== ciphertextBytes.length ||
    envelope.ciphertextHash !== actualCiphertextHash ||
    envelope.candidateManifestHash !== candidateHash ||
    candidateManifest.transition.kind !== 'add-device' ||
    candidateManifest.transition.authorizingDeviceId !== authenticated.deviceId ||
    candidateManifest.transition.affectedDeviceId !== request.new_device_id
  ) {
    throw forbidden('PAIRING_TRANSCRIPT_MISMATCH', 'Pairing transcript is inconsistent.');
  }
  await validateManifestTransition(current, candidateManifest);
  const signingKey = await importSigningPublicKey(authorizer.publicKeys.signing);
  if (
    !(await verifyDomainSeparatedCanonicalSignature(
      SYNC_DOMAIN_LABELS.pairingEnvelope,
      unsignedEnvelope(envelope),
      envelope.signature,
      signingKey,
    ))
  ) {
    throw forbidden('PAIRING_SIGNATURE_INVALID', 'Pairing envelope signature is invalid.');
  }
  return {
    current,
    currentHash,
    envelopeHash: await hashDomainSeparatedCanonical(
      SYNC_DOMAIN_LABELS.pairingEnvelopeHash,
      envelope,
    ),
  };
};

export const handleApprovePairing = async (
  context: RequestContext,
  pairingRequestId: string,
): Promise<Response> => {
  const input = await readCanonicalJson(context.request, pairingApprovalSchema);
  if (input.pairingRequestId !== pairingRequestId) {
    throw forbidden('PAIRING_CONTEXT_MISMATCH', 'Pairing request identifier does not match.');
  }
  const authenticated = await authenticateRequest(context);
  const request = await inspectPairing(context, pairingRequestId, input.claimToken, true);
  const limits = readWorkerLimits(context.env);
  if (request.status !== 'pending') {
    await consumeSensitiveChallenge(
      context,
      input.sensitiveChallenge,
      input.sensitiveSignature,
      '/v1/pairings/approve',
      authenticated.deviceId,
    );
    const retry = await exactStoredApproval(
      context,
      request,
      authenticated,
      input.envelope,
      input.candidateManifest,
      await hashDomainSeparatedCanonical(SYNC_DOMAIN_LABELS.pairingEnvelopeHash, input.envelope),
    );
    if (retry) return retry;
    throw conflict('PAIRING_STATE_CHANGED', 'Pairing approval is incomplete.');
  }
  const currentPairings = await context.env.MIRNA_SYNC_DB.prepare(
    `SELECT COUNT(*) AS count
       FROM pairing_requests
      WHERE vault_id = ?1
        AND status IN ('pending', 'approved')
        AND expires_at > ?2`,
  )
    .bind(authenticated.vaultId, Date.now())
    .first<{ count: number }>();
  if ((currentPairings?.count ?? 0) >= limits.maxActivePairingsPerVault) {
    throw new HttpError(429, 'PAIRING_LIMIT_REACHED', 'Vault has too many active pairings.');
  }
  const verified = await verifyApprovalEnvelope(
    context,
    authenticated,
    request,
    input.envelope,
    input.candidateManifest,
  );
  if (input.candidateManifest.devices.length > limits.maxDevicesPerVault) {
    throw conflict('DEVICE_LIMIT_REACHED', 'Vault device limit has been reached.');
  }
  assertFreshDeviceAuthorization(input.candidateManifest, Date.now(), limits);
  await consumeSensitiveChallenge(
    context,
    input.sensitiveChallenge,
    input.sensitiveSignature,
    '/v1/pairings/approve',
    authenticated.deviceId,
  );

  const now = Date.now();
  let results: D1Result<unknown>[];
  try {
    results = await context.env.MIRNA_SYNC_DB.batch([
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE pairing_requests
          SET vault_id = ?2,
              status = 'approved'
        WHERE pairing_request_id = ?1
          AND vault_id IS NULL
          AND status = 'pending'
          AND expires_at > ?3
          AND (
            SELECT COUNT(*)
              FROM pairing_requests active_pairing
             WHERE active_pairing.vault_id = ?2
               AND active_pairing.status IN ('pending', 'approved')
               AND active_pairing.expires_at > ?3
          ) < ?4`,
      ).bind(pairingRequestId, authenticated.vaultId, now, limits.maxActivePairingsPerVault),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO pairing_envelopes (
         envelope_id, pairing_request_id, vault_id, new_device_id,
         authorizing_device_id, key_epoch, crypto_suite, canonical_envelope,
         envelope_hash, candidate_manifest, candidate_manifest_hash,
         created_at, expires_at, consumed_at, retention_expires_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, ?14)`,
      ).bind(
        input.envelope.aad.objectId,
        pairingRequestId,
        authenticated.vaultId,
        request.new_device_id,
        authenticated.deviceId,
        verified.current.keyEpoch,
        verified.current.suite,
        canonicalText(input.envelope),
        encodedToDatabaseBlob(verified.envelopeHash, 32),
        canonicalText(input.candidateManifest),
        encodedToDatabaseBlob(input.envelope.candidateManifestHash, 32),
        now,
        request.expires_at,
        request.expires_at + 60 * 60 * 1_000,
      ),
    ]);
  } catch {
    const raced = await exactStoredApproval(
      context,
      request,
      authenticated,
      input.envelope,
      input.candidateManifest,
      verified.envelopeHash,
    );
    if (raced) return raced;
    throw conflict('PAIRING_STATE_CHANGED', 'Pairing request is no longer pending.');
  }
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    const raced = await exactStoredApproval(
      context,
      request,
      authenticated,
      input.envelope,
      input.candidateManifest,
      verified.envelopeHash,
    );
    if (raced) return raced;
    throw conflict('PAIRING_STATE_CHANGED', 'Pairing request is no longer pending.');
  }

  return jsonResponse(
    { protocolVersion: 1, status: 'approved', expiresAt: isoTimestamp(request.expires_at) },
    { requestId: context.requestId, allowedOrigin: context.allowedOrigin },
  );
};

const pollingHash = (pollingToken: string): Promise<Uint8Array> =>
  hashEncodedSecret(SYNC_DOMAIN_LABELS.pollingTokenHash, pollingToken);

const storedEnvelope = async (
  context: RequestContext,
  pairingRequestId: string,
  pollingToken: string,
): Promise<StoredPairingEnvelopeRow | null> => {
  let tokenHash: Uint8Array;
  try {
    tokenHash = await pollingHash(pollingToken);
  } catch {
    return null;
  }
  return context.env.MIRNA_SYNC_DB.prepare(
    `SELECT p.*, e.envelope_id, e.canonical_envelope, e.envelope_hash,
            e.candidate_manifest, e.candidate_manifest_hash,
            e.authorizing_device_id, e.consumed_at
       FROM pairing_requests p
       LEFT JOIN pairing_envelopes e
         ON e.pairing_request_id = p.pairing_request_id
      WHERE p.pairing_request_id = ?1
        AND p.polling_token_hash = ?2
      LIMIT 1`,
  )
    .bind(pairingRequestId, toDatabaseBlob(tokenHash))
    .first<StoredPairingEnvelopeRow>();
};

export const handlePollPairing = async (
  context: RequestContext,
  pairingRequestId: string,
): Promise<Response> => {
  const input = await readCanonicalJson(context.request, pairingPollRequestSchema);
  const row = await storedEnvelope(context, pairingRequestId, input.pollingToken);
  if (!row) throw notFound();
  const status =
    row.expires_at <= Date.now() ? 'expired' : row.status === 'finalized' ? 'consumed' : row.status;
  const response =
    status === 'approved'
      ? {
          protocolVersion: 1 as const,
          status,
          expiresAt: isoTimestamp(row.expires_at),
          envelope: JSON.parse(row.canonical_envelope) as unknown,
          candidateManifest: JSON.parse(row.candidate_manifest) as unknown,
        }
      : {
          protocolVersion: 1 as const,
          status,
          expiresAt: isoTimestamp(row.expires_at),
        };
  return jsonResponse(pairingPollResponseSchema.parse(response), {
    requestId: context.requestId,
    allowedOrigin: context.allowedOrigin,
  });
};

export const handleCancelPairing = async (
  context: RequestContext,
  pairingRequestId: string,
): Promise<Response> => {
  const input = await readCanonicalJson(context.request, pairingCancelRequestSchema);
  const tokenHash = await pollingHash(input.pollingToken).catch(() => null);
  if (!tokenHash) throw notFound();
  const now = Date.now();
  const result = await context.env.MIRNA_SYNC_DB.prepare(
    `UPDATE pairing_requests
        SET status = 'cancelled', cancelled_at = ?3
      WHERE pairing_request_id = ?1
        AND polling_token_hash = ?2
        AND status IN ('pending', 'approved')
        AND expires_at > ?3`,
  )
    .bind(pairingRequestId, toDatabaseBlob(tokenHash), now)
    .run();
  if (result.meta.changes !== 1) throw notFound();
  return jsonResponse(
    { protocolVersion: 1, status: 'cancelled', expiresAt: isoTimestamp(now) },
    { requestId: context.requestId, allowedOrigin: context.allowedOrigin },
  );
};

const exactFinalizedPairing = async (
  context: RequestContext,
  pairingRequestId: string,
  pollingToken: string,
  finalizationHash: string,
  newDeviceId: string,
): Promise<Response | null> => {
  const stored = await storedEnvelope(context, pairingRequestId, pollingToken);
  if (
    !stored ||
    stored.status !== 'finalized' ||
    !stored.finalization_hash ||
    !stored.candidate_manifest ||
    bytesToBase64Url(databaseBytes(stored.finalization_hash)) !== finalizationHash ||
    stored.new_device_id !== newDeviceId
  ) {
    return null;
  }
  const candidateManifest = vaultManifestSchema.parse(JSON.parse(stored.candidate_manifest));
  const candidate = candidateManifest.devices.find((device) => device.deviceId === newDeviceId);
  if (
    !candidate ||
    candidate.publicKeys.signing.value !== stored.new_signing_public_key_raw ||
    candidate.publicKeys.agreement.value !== stored.new_agreement_public_key_raw
  ) {
    throw forbidden(
      'PAIRING_FINALIZATION_MISMATCH',
      'Pairing finalization does not match approval.',
    );
  }
  return jsonResponse(
    pairingFinalizeResponseSchema.parse({
      protocolVersion: 1,
      vaultId: stored.vault_id,
      deviceId: newDeviceId,
      manifestVersion: candidateManifest.manifestVersion,
      finalized: true,
    }),
    { requestId: context.requestId, allowedOrigin: context.allowedOrigin },
  );
};

export const handleFinalizePairing = async (
  context: RequestContext,
  pairingRequestId: string,
): Promise<Response> => {
  const input = await readCanonicalJson(context.request, pairingFinalizeRequestSchema);
  const stored = await storedEnvelope(context, pairingRequestId, input.pollingToken);
  if (!stored || !stored.canonical_envelope || !stored.candidate_manifest) throw notFound();
  const envelope = JSON.parse(stored.canonical_envelope) as PairingEnvelopeV1;
  const candidateManifest = vaultManifestSchema.parse(JSON.parse(stored.candidate_manifest));
  const newDevice = candidateManifest.devices.find(
    (device) => device.deviceId === stored.new_device_id,
  );
  if (!newDevice) throw forbidden('PAIRING_DEVICE_MISSING', 'Candidate device is missing.');
  if (
    newDevice.publicKeys.signing.value !== stored.new_signing_public_key_raw ||
    newDevice.publicKeys.agreement.value !== stored.new_agreement_public_key_raw ||
    !equal(envelope.context.newDevicePublicKeys, newDevice.publicKeys)
  ) {
    throw forbidden(
      'PAIRING_FINALIZATION_MISMATCH',
      'Pairing finalization does not match approval.',
    );
  }
  const finalizationHash = await hashDomainSeparatedCanonical(
    SYNC_DOMAIN_LABELS.pairingFinalize,
    input.transcript,
  );
  if (stored.status === 'finalized' && stored.finalization_hash) {
    const retry = await exactFinalizedPairing(
      context,
      pairingRequestId,
      input.pollingToken,
      finalizationHash,
      input.transcript.newDeviceId,
    );
    if (retry) return retry;
    throw conflict('PAIRING_ALREADY_FINALIZED', 'Pairing was finalized with different data.');
  }
  const envelopeHash = bytesToBase64Url(databaseBytes(stored.envelope_hash));
  const candidateHash = bytesToBase64Url(databaseBytes(stored.candidate_manifest_hash));
  if (
    stored.status !== 'approved' ||
    stored.expires_at <= Date.now() ||
    input.transcript.pairingRequestId !== pairingRequestId ||
    input.transcript.vaultId !== stored.vault_id ||
    input.transcript.newDeviceId !== stored.new_device_id ||
    input.transcript.envelopeHash !== envelopeHash ||
    input.transcript.candidateManifestHash !== candidateHash ||
    input.transcript.keyConfirmation !== envelope.keyConfirmation
  ) {
    throw forbidden(
      'PAIRING_FINALIZATION_MISMATCH',
      'Pairing finalization does not match approval.',
    );
  }
  const newDeviceSigningKey = await importSigningPublicKey(newDevice.publicKeys.signing);
  if (
    !(await verifyDomainSeparatedCanonicalSignature(
      SYNC_DOMAIN_LABELS.pairingFinalize,
      input.transcript,
      input.signature,
      newDeviceSigningKey,
    ))
  ) {
    throw forbidden('PAIRING_FINALIZATION_SIGNATURE_INVALID', 'Finalization signature is invalid.');
  }
  const current = await currentVault(context.env.MIRNA_SYNC_DB, stored.vault_id ?? '');
  if (!current || current.current_manifest_version + 1 !== candidateManifest.manifestVersion) {
    throw conflict('MANIFEST_STATE_CHANGED', 'Vault manifest changed during pairing.');
  }

  const now = Date.now();
  const authorizer = stored.authorizing_device_id;
  let results: D1Result<unknown>[];
  try {
    results = await context.env.MIRNA_SYNC_DB.batch([
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE pairing_requests
          SET status = 'finalized', finalized_at = ?2, finalization_hash = ?3
        WHERE pairing_request_id = ?1
          AND status = 'approved'
          AND expires_at > ?2`,
      ).bind(pairingRequestId, now, encodedToDatabaseBlob(finalizationHash, 32)),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO vault_manifests (
         vault_id, manifest_version, key_epoch, authorization_kind,
         signed_by_device_id, canonical_manifest, manifest_hash,
         previous_manifest_hash, signature, accepted_at
       )
       SELECT ?1, ?2, ?3, 'device', ?4, ?5, ?6, ?7, ?8, ?9
         FROM vaults v
         JOIN pairing_requests p ON p.pairing_request_id = ?10
        WHERE v.vault_id = ?1
          AND v.status = 'active'
          AND v.current_manifest_version = ?11
          AND p.status = 'finalized'`,
      ).bind(
        stored.vault_id,
        candidateManifest.manifestVersion,
        candidateManifest.keyEpoch,
        authorizer,
        canonicalText(candidateManifest),
        encodedToDatabaseBlob(candidateHash, 32),
        encodedToDatabaseBlob(candidateManifest.previousManifestHash ?? '', 32),
        encodedToDatabaseBlob(candidateManifest.signature, 64),
        now,
        pairingRequestId,
        current.current_manifest_version,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO devices (
         vault_id, device_id, signing_public_key_raw, agreement_public_key_raw,
         status, added_in_manifest_version, created_at, revoked_at, last_seen_at
       ) VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, NULL, NULL)`,
      ).bind(
        stored.vault_id,
        newDevice.deviceId,
        newDevice.publicKeys.signing.value,
        newDevice.publicKeys.agreement.value,
        candidateManifest.manifestVersion,
        now,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO device_grants (
         grant_id, vault_id, device_id, grant_version, issued_by_device_id,
         authorization_transcript_hash, authorization_signature, issued_at,
         expires_at, revoked_at
       ) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, NULL)`,
      ).bind(
        candidateManifest.transition.transitionId,
        stored.vault_id,
        newDevice.deviceId,
        authorizer,
        encodedToDatabaseBlob(candidateHash, 32),
        encodedToDatabaseBlob(candidateManifest.signature, 64),
        now,
        Date.parse(newDevice.authorizationExpiresAt),
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE vaults
          SET current_manifest_version = ?2,
              current_key_epoch = ?3,
              updated_at = ?4
        WHERE vault_id = ?1
          AND current_manifest_version = ?5`,
      ).bind(
        stored.vault_id,
        candidateManifest.manifestVersion,
        candidateManifest.keyEpoch,
        now,
        current.current_manifest_version,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE pairing_envelopes SET consumed_at = ?2 WHERE pairing_request_id = ?1`,
      ).bind(pairingRequestId, now),
    ]);
  } catch {
    const raced = await exactFinalizedPairing(
      context,
      pairingRequestId,
      input.pollingToken,
      finalizationHash,
      input.transcript.newDeviceId,
    );
    if (raced) return raced;
    throw conflict('PAIRING_FINALIZATION_CONFLICT', 'Pairing finalization lost its state race.');
  }
  if (results.some((result) => result.meta.changes !== 1)) {
    const raced = await exactFinalizedPairing(
      context,
      pairingRequestId,
      input.pollingToken,
      finalizationHash,
      input.transcript.newDeviceId,
    );
    if (raced) return raced;
    throw conflict('PAIRING_FINALIZATION_CONFLICT', 'Pairing finalization lost its state race.');
  }

  return jsonResponse(
    pairingFinalizeResponseSchema.parse({
      protocolVersion: 1,
      vaultId: stored.vault_id,
      deviceId: newDevice.deviceId,
      manifestVersion: candidateManifest.manifestVersion,
      finalized: true,
    }),
    { status: 201, requestId: context.requestId, allowedOrigin: context.allowedOrigin },
  );
};
