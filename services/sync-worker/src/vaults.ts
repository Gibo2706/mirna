import { canonicalizeJson } from '../../../src/domain/sync/canonical';
import { manifestBodyHash, verifyInitialManifest } from '../../../src/domain/sync/manifest';
import {
  vaultCreateRequestSchema,
  vaultCreateResponseSchema,
  type RecoveryRecordV1,
  type VaultManifestV1,
} from '../../../src/domain/sync/schemas';
import { timingSafeEqual } from '../../../src/domain/sync/encoding';
import type { AuthenticatedDevice } from './auth';
import { assertFreshDeviceAuthorization } from './authorization';
import type { RequestContext } from './context';
import { conflict, HttpError, notFound } from './errors';
import { jsonResponse } from './http';
import { readWorkerLimits } from './limits';
import { assertValidDevicePublicKeys, assertValidSigningPublicKey } from './public-keys';
import { canonicalText, encodedToDatabaseBlob } from './server-crypto';
import { readCanonicalJson } from './validation';

interface ExistingVaultRow {
  current_manifest_version: number;
  current_key_epoch: number;
  manifest_hash: ArrayBuffer;
  recovery_lookup_id: string;
  recovery_version: number;
  recovery_key_epoch: number;
  recovery_gate_key_hash: ArrayBuffer;
  recovery_signing_public_key_raw: string;
  recovery_manifest_version: number;
  recovery_manifest_hash: ArrayBuffer;
  recovery_crypto_suite: string;
  canonical_recovery_envelope: string;
  recovery_signed_updated_at: number;
}

const samePublicKey = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

const assertInitialRecoveryBinding = (
  manifest: VaultManifestV1,
  recovery: RecoveryRecordV1,
  manifestHash: string,
): void => {
  const envelope = recovery.recoveryEnvelope;
  const initialDevice = manifest.devices[0];
  if (
    !initialDevice ||
    recovery.protocolVersion !== manifest.protocolVersion ||
    recovery.suite !== manifest.suite ||
    recovery.vaultId !== manifest.vaultId ||
    recovery.recoveryLookupId !== manifest.recoveryLookupId ||
    recovery.keyEpoch !== manifest.keyEpoch ||
    recovery.manifestVersion !== manifest.manifestVersion ||
    recovery.manifestHash !== manifestHash ||
    recovery.updatedAt !== manifest.transition.occurredAt ||
    !samePublicKey(recovery.recoverySigningPublicKey, manifest.recoverySigningPublicKey) ||
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
    envelope.aad.creatingDeviceId !== initialDevice.deviceId ||
    envelope.aad.recoveryLookupId !== manifest.recoveryLookupId ||
    envelope.aad.parentManifestHash !== manifestHash
  ) {
    throw conflict(
      'RECOVERY_BINDING_INVALID',
      'Recovery envelope is not bound to the initial manifest.',
    );
  }
};

const findExistingVault = (
  database: D1Database,
  vaultId: string,
): Promise<ExistingVaultRow | null> =>
  database
    .prepare(
      `SELECT v.current_manifest_version, v.current_key_epoch,
              m.manifest_hash, r.recovery_lookup_id, r.recovery_version,
              r.key_epoch AS recovery_key_epoch,
              r.recovery_gate_key_hash, r.recovery_signing_public_key_raw,
              r.manifest_version AS recovery_manifest_version,
              r.manifest_hash AS recovery_manifest_hash,
              r.crypto_suite AS recovery_crypto_suite,
              r.canonical_recovery_envelope,
              r.signed_updated_at AS recovery_signed_updated_at
         FROM vaults v
         JOIN vault_manifests m
           ON m.vault_id = v.vault_id
          AND m.manifest_version = v.current_manifest_version
         JOIN recovery_records r
           ON r.vault_id = v.vault_id
          AND r.rotated_at IS NULL
        WHERE v.vault_id = ?1
        LIMIT 1`,
    )
    .bind(vaultId)
    .first<ExistingVaultRow>();

const isExactVaultRetry = (
  existing: ExistingVaultRow,
  manifest: VaultManifestV1,
  recovery: RecoveryRecordV1,
  manifestHash: string,
): boolean => {
  const expectedManifestHash = new Uint8Array(encodedToDatabaseBlob(manifestHash, 32));
  return (
    existing.current_manifest_version === manifest.manifestVersion &&
    existing.current_key_epoch === manifest.keyEpoch &&
    timingSafeEqual(new Uint8Array(existing.manifest_hash), expectedManifestHash) &&
    existing.recovery_lookup_id === recovery.recoveryLookupId &&
    existing.recovery_version === 1 &&
    existing.recovery_key_epoch === recovery.keyEpoch &&
    timingSafeEqual(
      new Uint8Array(existing.recovery_gate_key_hash),
      new Uint8Array(encodedToDatabaseBlob(recovery.recoveryGateKeyHash, 32)),
    ) &&
    existing.recovery_signing_public_key_raw === recovery.recoverySigningPublicKey.value &&
    existing.recovery_manifest_version === recovery.manifestVersion &&
    timingSafeEqual(new Uint8Array(existing.recovery_manifest_hash), expectedManifestHash) &&
    existing.recovery_crypto_suite === recovery.suite &&
    existing.canonical_recovery_envelope === canonicalText(recovery.recoveryEnvelope) &&
    existing.recovery_signed_updated_at === Date.parse(recovery.updatedAt)
  );
};

const createResponse = (
  context: RequestContext,
  manifest: VaultManifestV1,
  manifestHash: string,
  created: boolean,
): Response =>
  jsonResponse(
    vaultCreateResponseSchema.parse({
      protocolVersion: 1,
      vaultId: manifest.vaultId,
      manifestVersion: manifest.manifestVersion,
      manifestHash,
      created,
    }),
    {
      status: created ? 201 : 200,
      requestId: context.requestId,
      allowedOrigin: context.allowedOrigin,
    },
  );

export const handleCreateVault = async (context: RequestContext): Promise<Response> => {
  const input = await readCanonicalJson(context.request, vaultCreateRequestSchema);
  const initialDevice = input.manifest.devices[0];
  if (!initialDevice) throw conflict('MANIFEST_INVALID', 'Initial manifest has no device.');
  await Promise.all([
    assertValidDevicePublicKeys(initialDevice.publicKeys),
    assertValidSigningPublicKey(input.manifest.recoverySigningPublicKey),
  ]);
  await verifyInitialManifest(input.manifest);
  const manifestHash = await manifestBodyHash(input.manifest);
  assertInitialRecoveryBinding(input.manifest, input.recovery, manifestHash);

  const existing = await findExistingVault(context.env.MIRNA_SYNC_DB, input.manifest.vaultId);
  if (existing) {
    if (isExactVaultRetry(existing, input.manifest, input.recovery, manifestHash)) {
      return createResponse(context, input.manifest, manifestHash, false);
    }
    throw conflict('VAULT_ALREADY_EXISTS', 'Vault identifier is already registered.');
  }
  const limits = readWorkerLimits(context.env);
  assertFreshDeviceAuthorization(input.manifest, Date.now(), limits);

  const device = initialDevice;
  const now = Date.now();
  const authorizationExpiresAt = Date.parse(device.authorizationExpiresAt);
  const manifestText = canonicalText(input.manifest);
  const recoveryText = canonicalText(input.recovery.recoveryEnvelope);
  const manifestHashBlob = encodedToDatabaseBlob(manifestHash, 32);

  try {
    await context.env.MIRNA_SYNC_DB.batch([
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO vaults (
           vault_id, protocol_version, crypto_suite, status, current_key_epoch,
           current_manifest_version, current_snapshot_id, current_snapshot_revision,
           created_at, updated_at
         )
         SELECT ?1, 1, ?2, 'active', ?3, ?4, NULL, 0, ?5, ?5
          WHERE (SELECT COUNT(*) FROM vaults) < ?6`,
      ).bind(
        input.manifest.vaultId,
        input.manifest.suite,
        input.manifest.keyEpoch,
        input.manifest.manifestVersion,
        now,
        limits.maxTotalVaults,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO devices (
           vault_id, device_id, signing_public_key_raw, agreement_public_key_raw,
           status, added_in_manifest_version, created_at, revoked_at, last_seen_at
         ) VALUES (?1, ?2, ?3, ?4, 'active', 1, ?5, NULL, NULL)`,
      ).bind(
        input.manifest.vaultId,
        device.deviceId,
        device.publicKeys.signing.value,
        device.publicKeys.agreement.value,
        now,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO vault_manifests (
           vault_id, manifest_version, key_epoch, authorization_kind,
           signed_by_device_id, canonical_manifest, manifest_hash,
           previous_manifest_hash, signature, accepted_at
         ) VALUES (?1, ?2, ?3, 'device', ?4, ?5, ?6, NULL, ?7, ?8)`,
      ).bind(
        input.manifest.vaultId,
        input.manifest.manifestVersion,
        input.manifest.keyEpoch,
        device.deviceId,
        manifestText,
        manifestHashBlob,
        encodedToDatabaseBlob(input.manifest.signature, 64),
        now,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO device_grants (
           grant_id, vault_id, device_id, grant_version, issued_by_device_id,
           authorization_transcript_hash, authorization_signature, issued_at,
           expires_at, revoked_at
         ) VALUES (?1, ?2, ?3, 1, ?3, ?4, ?5, ?6, ?7, NULL)`,
      ).bind(
        input.manifest.transition.transitionId,
        input.manifest.vaultId,
        device.deviceId,
        manifestHashBlob,
        encodedToDatabaseBlob(input.manifest.signature, 64),
        now,
        authorizationExpiresAt,
      ),
      context.env.MIRNA_SYNC_DB.prepare(
        `INSERT INTO recovery_records (
           recovery_lookup_id, vault_id, recovery_version, key_epoch,
           recovery_gate_key_hash, recovery_signing_public_key_raw,
           manifest_version, manifest_hash, crypto_suite,
         canonical_recovery_envelope, failed_attempts, locked_until,
           signed_updated_at, created_at, rotated_at
         ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, NULL, ?10, ?11, NULL)`,
      ).bind(
        input.recovery.recoveryLookupId,
        input.recovery.vaultId,
        input.recovery.keyEpoch,
        encodedToDatabaseBlob(input.recovery.recoveryGateKeyHash, 32),
        input.recovery.recoverySigningPublicKey.value,
        input.recovery.manifestVersion,
        manifestHashBlob,
        input.recovery.suite,
        recoveryText,
        Date.parse(input.recovery.updatedAt),
        now,
      ),
    ]);
  } catch {
    const raced = await findExistingVault(context.env.MIRNA_SYNC_DB, input.manifest.vaultId);
    if (raced) {
      if (isExactVaultRetry(raced, input.manifest, input.recovery, manifestHash)) {
        return createResponse(context, input.manifest, manifestHash, false);
      }
      throw conflict('VAULT_ALREADY_EXISTS', 'Vault identifier is already registered.');
    }
    const vaultCount = await context.env.MIRNA_SYNC_DB.prepare(
      'SELECT COUNT(*) AS count FROM vaults',
    ).first<number>('count');
    if ((vaultCount ?? limits.maxTotalVaults) >= limits.maxTotalVaults) {
      throw new HttpError(503, 'STORAGE_QUOTA_REACHED', 'Staging storage quota is full.');
    }
    throw new Error('Vault transaction failed.');
  }

  return createResponse(context, input.manifest, manifestHash, true);
};

export const handleGetCurrentManifest = async (
  context: RequestContext,
  authenticated: AuthenticatedDevice,
): Promise<Response> => {
  const row = await context.env.MIRNA_SYNC_DB.prepare(
    `SELECT m.canonical_manifest
       FROM vaults v
       JOIN vault_manifests m
         ON m.vault_id = v.vault_id
        AND m.manifest_version = v.current_manifest_version
      WHERE v.vault_id = ?1
        AND v.status = 'active'`,
  )
    .bind(authenticated.vaultId)
    .first<{ canonical_manifest: string }>();
  if (!row) throw notFound();
  return jsonResponse(JSON.parse(row.canonical_manifest), {
    requestId: context.requestId,
    allowedOrigin: context.allowedOrigin,
  });
};
