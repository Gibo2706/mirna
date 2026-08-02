import { canonicalizeJson } from '../../../src/domain/sync/canonical';
import { SYNC_DOMAIN_LABELS } from '../../../src/domain/sync/constants';
import {
  hashDomainSeparatedCanonical,
  importSigningPublicKey,
  verifyDomainSeparatedCanonicalSignature,
} from '../../../src/domain/sync/crypto';
import { timingSafeEqual } from '../../../src/domain/sync/encoding';
import { manifestBodyHash, validateManifestTransition } from '../../../src/domain/sync/manifest';
import {
  deviceKeyEnvelopeResponseSchema,
  deviceKeyEnvelopeSchema,
  deviceRenewRequestSchema,
  deviceRenewResponseSchema,
  recoveryRecordSchema,
  secureDeviceRevocationRequestSchema,
  secureDeviceRevocationResponseSchema,
  vaultManifestSchema,
  type RecoveryRecordV1,
  type VaultManifestV1,
} from '../../../src/domain/sync/schemas';
import { authenticateRequest, consumeSensitiveChallenge } from './auth';
import { assertFreshDeviceAuthorization } from './authorization';
import type { RequestContext } from './context';
import { conflict, forbidden, HttpError } from './errors';
import { jsonResponse } from './http';
import { readWorkerLimits } from './limits';
import { assertValidDevicePublicKeys } from './public-keys';
import { authorizeRecoveryCapability } from './recovery';
import { canonicalText, encodedToDatabaseBlob } from './server-crypto';
import { readCanonicalJson } from './validation';

interface StoredSecurityTransition {
  request_hash: ArrayBuffer;
  canonical_response: string;
}

const equal = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

const storedTransition = (
  database: D1Database,
  transitionId: string,
): Promise<StoredSecurityTransition | null> =>
  database
    .prepare(
      `SELECT request_hash, canonical_response
         FROM device_security_transitions
        WHERE transition_id = ?1
        LIMIT 1`,
    )
    .bind(transitionId)
    .first<StoredSecurityTransition>();

const exactRetry = async (
  context: RequestContext,
  transitionId: string,
  requestHash: string,
): Promise<Response | null> => {
  const stored = await storedTransition(context.env.MIRNA_SYNC_DB, transitionId);
  if (!stored) return null;
  if (
    !timingSafeEqual(
      new Uint8Array(stored.request_hash),
      new Uint8Array(encodedToDatabaseBlob(requestHash, 32)),
    )
  ) {
    throw conflict('SECURITY_TRANSITION_ID_REUSED', 'Transition identity was already used.');
  }
  return jsonResponse(JSON.parse(stored.canonical_response) as unknown, {
    status: 201,
    requestId: context.requestId,
    allowedOrigin: context.allowedOrigin,
  });
};

const readCurrentManifest = async (
  database: D1Database,
  vaultId: string,
): Promise<VaultManifestV1> => {
  const canonical = await database
    .prepare(
      `SELECT m.canonical_manifest
         FROM vaults v
         JOIN vault_manifests m
           ON m.vault_id = v.vault_id
          AND m.manifest_version = v.current_manifest_version
        WHERE v.vault_id = ?1
          AND v.status = 'active'
        LIMIT 1`,
    )
    .bind(vaultId)
    .first<string>('canonical_manifest');
  if (!canonical) throw new HttpError(404, 'VAULT_NOT_FOUND', 'Vault was not found.');
  return vaultManifestSchema.parse(JSON.parse(canonical) as unknown);
};

const assertCurrentManifest = async (
  database: D1Database,
  vaultId: string,
  expected: VaultManifestV1,
): Promise<void> => {
  if (!equal(await readCurrentManifest(database, vaultId), expected)) {
    throw conflict('MANIFEST_STATE_CHANGED', 'Manifest state changed.');
  }
};

export const handleRenewDevice = async (
  context: RequestContext,
  routeDeviceId: string,
): Promise<Response> => {
  const [authenticated, input] = await Promise.all([
    authenticateRequest(context),
    readCanonicalJson(context.request, deviceRenewRequestSchema),
  ]);
  const transitionId = input.newManifest.transition.transitionId;
  const requestHash = await hashDomainSeparatedCanonical(
    SYNC_DOMAIN_LABELS.secureRevocationRequest,
    input,
  );
  const retried = await exactRetry(context, transitionId, requestHash);
  if (retried) return retried;
  const previous = await readCurrentManifest(context.env.MIRNA_SYNC_DB, authenticated.vaultId);
  if (
    routeDeviceId !== input.newManifest.transition.affectedDeviceId ||
    input.newManifest.transition.kind !== 'renew-device' ||
    input.newManifest.transition.authorizationKind !== 'device' ||
    input.newManifest.transition.authorizingDeviceId !== authenticated.deviceId ||
    input.newManifest.vaultId !== authenticated.vaultId
  ) {
    throw forbidden('DEVICE_RENEWAL_CONTEXT_MISMATCH', 'Renewal context is invalid.');
  }
  await validateManifestTransition(previous, input.newManifest);
  assertFreshDeviceAuthorization(input.newManifest, Date.now(), readWorkerLimits(context.env));
  await consumeSensitiveChallenge(
    context,
    input.sensitiveChallenge,
    input.sensitiveSignature,
    '/v1/devices/renew',
    authenticated.deviceId,
  );
  await assertCurrentManifest(context.env.MIRNA_SYNC_DB, authenticated.vaultId, previous);
  const renewed = input.newManifest.devices.find((device) => device.deviceId === routeDeviceId);
  if (!renewed) throw forbidden('DEVICE_RENEWAL_CONTEXT_MISMATCH', 'Renewed device is missing.');
  const newManifestHash = await manifestBodyHash(input.newManifest);
  const previousManifestHash = await manifestBodyHash(previous);
  const response = deviceRenewResponseSchema.parse({
    protocolVersion: 1,
    vaultId: authenticated.vaultId,
    deviceId: routeDeviceId,
    manifestVersion: input.newManifest.manifestVersion,
    authorizationExpiresAt: renewed.authorizationExpiresAt,
    renewed: true,
  });
  const now = Date.now();
  let results: D1Result<unknown>[];
  try {
    results = await context.env.MIRNA_SYNC_DB.batch([
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO vault_manifests (
           vault_id, manifest_version, key_epoch, authorization_kind,
           signed_by_device_id, canonical_manifest, manifest_hash,
           previous_manifest_hash, signature, accepted_at
         ) VALUES (?1, ?2, ?3, 'device', ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(
        authenticated.vaultId,
        input.newManifest.manifestVersion,
        input.newManifest.keyEpoch,
        authenticated.deviceId,
        canonicalText(input.newManifest),
        encodedToDatabaseBlob(newManifestHash, 32),
        encodedToDatabaseBlob(previousManifestHash, 32),
        encodedToDatabaseBlob(input.newManifest.signature, 64),
        now,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE device_grants
            SET revoked_at = ?3
          WHERE vault_id = ?1
            AND device_id = ?2
            AND revoked_at IS NULL`,
      ).bind(authenticated.vaultId, routeDeviceId, now),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO device_grants (
           grant_id, vault_id, device_id, grant_version, issued_by_device_id,
           authorization_transcript_hash, authorization_signature, issued_at,
           expires_at, revoked_at
         )
         SELECT ?1, ?2, ?3, COALESCE(MAX(grant_version), 0) + 1, ?4,
                ?5, ?6, ?7, ?8, NULL
           FROM device_grants
          WHERE vault_id = ?2 AND device_id = ?3`,
      ).bind(
        transitionId,
        authenticated.vaultId,
        routeDeviceId,
        authenticated.deviceId,
        encodedToDatabaseBlob(newManifestHash, 32),
        encodedToDatabaseBlob(input.newManifest.signature, 64),
        now,
        Date.parse(renewed.authorizationExpiresAt),
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `UPDATE vaults
            SET current_manifest_version = ?2, updated_at = ?3
          WHERE vault_id = ?1
            AND status = 'active'
            AND current_manifest_version = ?4`,
      ).bind(
        authenticated.vaultId,
        input.newManifest.manifestVersion,
        now,
        previous.manifestVersion,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO device_security_transitions (
           transition_id, vault_id, kind, affected_device_id,
           request_hash, canonical_response, created_at
         ) VALUES (?1, ?2, 'renew-device', ?3, ?4, ?5, ?6)`,
      ).bind(
        transitionId,
        authenticated.vaultId,
        routeDeviceId,
        encodedToDatabaseBlob(requestHash, 32),
        canonicalText(response),
        now,
      ),
    ]);
  } catch {
    const raced = await exactRetry(context, transitionId, requestHash);
    if (raced) return raced;
    throw conflict('MANIFEST_STATE_CHANGED', 'Manifest state changed.');
  }
  if (
    results[0]?.meta.changes !== 1 ||
    results[2]?.meta.changes !== 1 ||
    results[3]?.meta.changes !== 1 ||
    results[4]?.meta.changes !== 1
  ) {
    throw conflict('MANIFEST_STATE_CHANGED', 'Manifest state changed.');
  }
  return jsonResponse(response, {
    status: 201,
    requestId: context.requestId,
    allowedOrigin: context.allowedOrigin,
  });
};

const assertRecoveryBinding = (
  recovery: RecoveryRecordV1,
  manifest: VaultManifestV1,
  manifestHash: string,
  expectedGateHash: string,
): void => {
  const envelope = recovery.recoveryEnvelope;
  if (
    recovery.protocolVersion !== manifest.protocolVersion ||
    recovery.suite !== manifest.suite ||
    recovery.vaultId !== manifest.vaultId ||
    recovery.recoveryLookupId !== manifest.recoveryLookupId ||
    recovery.keyEpoch !== manifest.keyEpoch ||
    recovery.manifestVersion !== manifest.manifestVersion ||
    recovery.manifestHash !== manifestHash ||
    recovery.recoveryGateKeyHash !== expectedGateHash ||
    !equal(recovery.recoverySigningPublicKey, manifest.recoverySigningPublicKey) ||
    recovery.updatedAt !== manifest.transition.occurredAt ||
    envelope.protocolVersion !== manifest.protocolVersion ||
    envelope.suite !== manifest.suite ||
    envelope.vaultId !== manifest.vaultId ||
    envelope.keyEpoch !== manifest.keyEpoch ||
    envelope.objectId !== envelope.aad.objectId ||
    envelope.aad.protocolVersion !== manifest.protocolVersion ||
    envelope.aad.suite !== manifest.suite ||
    envelope.aad.vaultId !== manifest.vaultId ||
    envelope.aad.keyEpoch !== manifest.keyEpoch ||
    envelope.aad.objectType !== 'recovery-vault-key' ||
    envelope.aad.creatingDeviceId !== manifest.transition.authorizingDeviceId ||
    envelope.aad.recoveryLookupId !== manifest.recoveryLookupId ||
    envelope.aad.parentManifestHash !== manifestHash
  ) {
    throw conflict('NEW_RECOVERY_BINDING_INVALID', 'New recovery binding is invalid.');
  }
};

export const handleSecureRevokeDevice = async (
  context: RequestContext,
  routeDeviceId: string,
): Promise<Response> => {
  const [authenticated, input] = await Promise.all([
    authenticateRequest(context),
    readCanonicalJson(context.request, secureDeviceRevocationRequestSchema),
  ]);
  const transcript = input.transcript;
  const transitionId = input.newManifest.transition.transitionId;
  const requestHash = await hashDomainSeparatedCanonical(
    SYNC_DOMAIN_LABELS.secureRevocationRequest,
    input,
  );
  const retried = await exactRetry(context, transitionId, requestHash);
  if (retried) return retried;
  if (
    routeDeviceId !== transcript.revokedDeviceId ||
    routeDeviceId === authenticated.deviceId ||
    transcript.vaultId !== authenticated.vaultId ||
    transcript.authorizingDeviceId !== authenticated.deviceId ||
    transcript.origin !== context.allowedOrigin ||
    transcript.path !== `/v1/devices/${routeDeviceId}/revoke` ||
    transcript.issuedAt !== transcript.recoveryChallenge.issuedAt ||
    transcript.expiresAt !== transcript.recoveryChallenge.expiresAt ||
    transcript.idempotencyKey !== transitionId ||
    input.newManifest.transition.occurredAt !== transcript.issuedAt ||
    Date.parse(transcript.issuedAt) < Date.now() - 10 * 60 * 1_000 ||
    Date.parse(transcript.issuedAt) > Date.now() + 2 * 60 * 1_000 ||
    Date.parse(transcript.expiresAt) <= Date.now()
  ) {
    throw forbidden('SECURE_REVOCATION_CONTEXT_MISMATCH', 'Revocation context is invalid.');
  }
  const recoveryAuthorization = await authorizeRecoveryCapability(context, {
    challenge: transcript.recoveryChallenge,
    gateKey: input.gateKey,
    transcript,
    gateProof: input.gateProof,
  });
  const previous = recoveryAuthorization.currentManifest;
  const authorizer = previous.devices.find((device) => device.deviceId === authenticated.deviceId);
  if (
    !authorizer ||
    recoveryAuthorization.vaultId !== authenticated.vaultId ||
    transcript.recoveryChallenge.newDeviceId !== authenticated.deviceId ||
    !equal(transcript.recoveryChallenge.newDevicePublicKeys, authorizer.publicKeys) ||
    transcript.previousManifestVersion !== previous.manifestVersion ||
    transcript.previousManifestHash !== (await manifestBodyHash(previous)) ||
    input.newManifest.transition.kind !== 'revoke-device' ||
    input.newManifest.transition.affectedDeviceId !== routeDeviceId ||
    input.newManifest.transition.authorizingDeviceId !== authenticated.deviceId ||
    input.newManifest.keyEpoch !== previous.keyEpoch + 1
  ) {
    throw forbidden('SECURE_REVOCATION_CONTEXT_MISMATCH', 'Revocation manifest is invalid.');
  }
  const [newManifestHash, newRecoveryHash, envelopeSetHash] = await Promise.all([
    manifestBodyHash(input.newManifest),
    hashDomainSeparatedCanonical(SYNC_DOMAIN_LABELS.recoveryRecord, input.newRecovery),
    hashDomainSeparatedCanonical(SYNC_DOMAIN_LABELS.deviceEnvelopeSet, input.deviceKeyEnvelopes),
  ]);
  if (
    transcript.newManifestHash !== newManifestHash ||
    transcript.newRecoveryHash !== newRecoveryHash ||
    transcript.deviceEnvelopeSetHash !== envelopeSetHash
  ) {
    throw forbidden('SECURE_REVOCATION_HASH_MISMATCH', 'Revocation body hashes do not match.');
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
      SYNC_DOMAIN_LABELS.secureRevocation,
      transcript,
      input.deviceSignature,
      deviceKey,
    ),
    verifyDomainSeparatedCanonicalSignature(
      SYNC_DOMAIN_LABELS.secureRevocation,
      transcript,
      input.recoverySignature,
      recoveryKey,
    ),
  ]);
  if (!deviceSignatureValid || !recoverySignatureValid) {
    throw forbidden('SECURE_REVOCATION_SIGNATURE_INVALID', 'Revocation signature is invalid.');
  }
  await validateManifestTransition(previous, input.newManifest);
  await Promise.all(
    input.newManifest.devices.map((device) => assertValidDevicePublicKeys(device.publicKeys)),
  );
  assertRecoveryBinding(
    recoveryRecordSchema.parse(input.newRecovery),
    input.newManifest,
    newManifestHash,
    recoveryAuthorization.recoveryGateKeyHash,
  );
  const expectedRecipients = input.newManifest.devices.map((device) => device.deviceId).sort();
  const actualRecipients = input.deviceKeyEnvelopes.map((envelope) => envelope.recipientDeviceId);
  if (
    !equal(actualRecipients, [...actualRecipients].sort()) ||
    !equal(actualRecipients, expectedRecipients) ||
    input.deviceKeyEnvelopes.some(
      (envelope) =>
        envelope.vaultId !== authenticated.vaultId ||
        envelope.keyEpoch !== input.newManifest.keyEpoch ||
        envelope.senderDeviceId !== authenticated.deviceId ||
        envelope.parentManifestHash !== newManifestHash,
    )
  ) {
    throw forbidden('DEVICE_KEY_ENVELOPE_SET_INVALID', 'Device envelope set is invalid.');
  }
  await assertCurrentManifest(context.env.MIRNA_SYNC_DB, authenticated.vaultId, previous);
  const response = secureDeviceRevocationResponseSchema.parse({
    protocolVersion: 1,
    vaultId: authenticated.vaultId,
    revokedDeviceId: routeDeviceId,
    manifestVersion: input.newManifest.manifestVersion,
    keyEpoch: input.newManifest.keyEpoch,
    revoked: true,
  });
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    context.env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO vault_manifests (
         vault_id, manifest_version, key_epoch, authorization_kind,
         signed_by_device_id, canonical_manifest, manifest_hash,
         previous_manifest_hash, signature, accepted_at
       ) VALUES (?1, ?2, ?3, 'device', ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(
      authenticated.vaultId,
      input.newManifest.manifestVersion,
      input.newManifest.keyEpoch,
      authenticated.deviceId,
      canonicalText(input.newManifest),
      encodedToDatabaseBlob(newManifestHash, 32),
      encodedToDatabaseBlob(transcript.previousManifestHash, 32),
      encodedToDatabaseBlob(input.newManifest.signature, 64),
      now,
    ),
    context.env.MIRNA_SYNC_DB.prepare(
      `UPDATE devices
          SET status = 'revoked', revoked_at = ?3
        WHERE vault_id = ?1 AND device_id = ?2 AND status = 'active'`,
    ).bind(authenticated.vaultId, routeDeviceId, now),
    context.env.MIRNA_SYNC_DB.prepare(
      `UPDATE device_grants SET revoked_at = ?3
        WHERE vault_id = ?1 AND device_id = ?2 AND revoked_at IS NULL`,
    ).bind(authenticated.vaultId, routeDeviceId, now),
    context.env.MIRNA_SYNC_DB.prepare(
      `UPDATE access_sessions SET revoked_at = ?2
        WHERE vault_id = ?1 AND revoked_at IS NULL AND expires_at > ?2`,
    ).bind(authenticated.vaultId, now),
    context.env.MIRNA_SYNC_DB.prepare(
      `UPDATE pairing_requests
          SET status = 'cancelled', cancelled_at = ?2
        WHERE vault_id = ?1 AND status IN ('pending', 'approved') AND expires_at > ?2`,
    ).bind(authenticated.vaultId, now),
    context.env.MIRNA_SYNC_DB.prepare(
      `UPDATE recovery_records
          SET recovery_version = recovery_version + 1,
              key_epoch = ?2, manifest_version = ?3, manifest_hash = ?4,
              canonical_recovery_envelope = ?5, failed_attempts = 0,
              locked_until = NULL, signed_updated_at = ?6, rotated_at = NULL
        WHERE recovery_lookup_id = ?1 AND rotated_at IS NULL`,
    ).bind(
      recoveryAuthorization.recoveryLookupId,
      input.newRecovery.keyEpoch,
      input.newRecovery.manifestVersion,
      encodedToDatabaseBlob(newManifestHash, 32),
      canonicalText(input.newRecovery.recoveryEnvelope),
      Date.parse(input.newRecovery.updatedAt),
    ),
    context.env.MIRNA_SYNC_DB.prepare(
      `UPDATE vaults
          SET current_manifest_version = ?2, current_key_epoch = ?3, updated_at = ?4
        WHERE vault_id = ?1 AND status = 'active'
          AND current_manifest_version = ?5 AND current_key_epoch = ?6`,
    ).bind(
      authenticated.vaultId,
      input.newManifest.manifestVersion,
      input.newManifest.keyEpoch,
      now,
      previous.manifestVersion,
      previous.keyEpoch,
    ),
    context.env.MIRNA_SYNC_DB.prepare(
      `UPDATE recovery_challenges SET consumed_at = ?2
        WHERE challenge_id = ?1 AND consumed_at IS NULL AND expires_at > ?2`,
    ).bind(recoveryAuthorization.challengeId, now),
  ];
  for (const envelopeInput of input.deviceKeyEnvelopes) {
    const envelope = deviceKeyEnvelopeSchema.parse(envelopeInput);
    statements.push(
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO device_key_envelopes (
           vault_id, key_epoch, recipient_device_id, sender_device_id,
           manifest_version, canonical_envelope, envelope_hash, created_at, claimed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)`,
      ).bind(
        authenticated.vaultId,
        envelope.keyEpoch,
        envelope.recipientDeviceId,
        envelope.senderDeviceId,
        input.newManifest.manifestVersion,
        canonicalText(envelope),
        encodedToDatabaseBlob(
          await hashDomainSeparatedCanonical(SYNC_DOMAIN_LABELS.deviceEnvelopeSet, envelope),
          32,
        ),
        now,
      ),
    );
  }
  statements.push(
    context.env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO device_security_transitions (
         transition_id, vault_id, kind, affected_device_id,
         request_hash, canonical_response, created_at
       ) VALUES (?1, ?2, 'secure-revoke-device', ?3, ?4, ?5, ?6)`,
    ).bind(
      transitionId,
      authenticated.vaultId,
      routeDeviceId,
      encodedToDatabaseBlob(requestHash, 32),
      canonicalText(response),
      now,
    ),
  );
  let results: D1Result<unknown>[];
  try {
    results = await context.env.MIRNA_SYNC_DB.batch(statements);
  } catch {
    const raced = await exactRetry(context, transitionId, requestHash);
    if (raced) return raced;
    throw conflict('SECURE_REVOCATION_STATE_CHANGED', 'Revocation state changed.');
  }
  if (
    results[0]?.meta.changes !== 1 ||
    results[1]?.meta.changes !== 1 ||
    results[5]?.meta.changes !== 1 ||
    results[6]?.meta.changes !== 1 ||
    results[7]?.meta.changes !== 1 ||
    results.at(-1)?.meta.changes !== 1
  ) {
    throw conflict('SECURE_REVOCATION_STATE_CHANGED', 'Revocation state changed.');
  }
  return jsonResponse(response, {
    status: 201,
    requestId: context.requestId,
    allowedOrigin: context.allowedOrigin,
  });
};

export const handleGetCurrentDeviceKeyEnvelope = async (
  context: RequestContext,
  requestedKeyEpoch?: number,
): Promise<Response> => {
  const authenticated = await authenticateRequest(context);
  if (
    requestedKeyEpoch !== undefined &&
    (!Number.isSafeInteger(requestedKeyEpoch) || requestedKeyEpoch < 2)
  ) {
    throw new HttpError(400, 'INVALID_REQUEST', 'Key epoch is invalid.');
  }
  const row = await context.env.MIRNA_SYNC_DB.prepare(
    `SELECT e.canonical_envelope
       FROM vaults v
       JOIN device_key_envelopes e
         ON e.vault_id = v.vault_id
        AND e.key_epoch = COALESCE(?3, v.current_key_epoch)
      WHERE v.vault_id = ?1
        AND v.status = 'active'
        AND e.recipient_device_id = ?2
      LIMIT 1`,
  )
    .bind(authenticated.vaultId, authenticated.deviceId, requestedKeyEpoch ?? null)
    .first<string>('canonical_envelope');
  if (!row)
    throw new HttpError(404, 'DEVICE_KEY_ENVELOPE_NOT_FOUND', 'Key envelope was not found.');
  const envelope = deviceKeyEnvelopeSchema.parse(JSON.parse(row) as unknown);
  await context.env.MIRNA_SYNC_DB.prepare(
    `UPDATE device_key_envelopes SET claimed_at = COALESCE(claimed_at, ?4)
      WHERE vault_id = ?1 AND key_epoch = ?2 AND recipient_device_id = ?3`,
  )
    .bind(authenticated.vaultId, envelope.keyEpoch, authenticated.deviceId, Date.now())
    .run();
  return jsonResponse(deviceKeyEnvelopeResponseSchema.parse({ protocolVersion: 1, envelope }), {
    requestId: context.requestId,
    allowedOrigin: context.allowedOrigin,
  });
};
