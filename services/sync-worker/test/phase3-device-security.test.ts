import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '../../../src/domain/sync/canonical';
import {
  SYNC_CRYPTO_SUITE,
  SYNC_DOMAIN_LABELS,
  SYNC_LIMITS,
  SYNC_PROTOCOL_VERSION,
} from '../../../src/domain/sync/constants';
import {
  createEncryptedKeyEnvelope,
  createEncryptedRecoveryBundleEnvelope,
  createOpaqueId,
  createRecoveryProof,
  deriveDeviceEnvelopeWrappingKey,
  deriveRecoveryKeys,
  exportPublicEcKey,
  exportRecoverySigningPrivateKey,
  generateDeviceKeyPairs,
  hashDomainSeparatedCanonical,
  hashRecoveryGateKey,
  openEncryptedKeyEnvelope,
  randomBytes,
  signDomainSeparatedCanonical,
} from '../../../src/domain/sync/crypto';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  clearBytes,
  timingSafeEqual,
} from '../../../src/domain/sync/encoding';
import {
  manifestBodyHash,
  signVaultManifest,
  validateManifestTransition,
} from '../../../src/domain/sync/manifest';
import {
  deviceKeyEnvelopeResponseSchema,
  deviceKeyEnvelopeSchema,
  deviceRenewRequestSchema,
  deviceRenewResponseSchema,
  manifestChangesResponseSchema,
  recoveryChallengeSchema,
  recoveryRecordSchema,
  secureDeviceRevocationRequestSchema,
  secureDeviceRevocationResponseSchema,
  unsignedVaultManifestSchema,
  vaultDeletionRequestSchema,
  vaultDeletionResponseSchema,
  type DeviceKeyEnvelopeV1,
  type DevicePublicKeysV1,
  type SecureDeviceRevocationRequestV1,
  type VaultManifestV1,
} from '../../../src/domain/sync/schemas';
import {
  createAccessSession,
  createInitialVaultFixture,
  issueChallenge,
  postCanonical,
  registerInitialVault,
  signChallenge,
  TEST_ORIGIN,
  type InitialVaultFixture,
} from './protocol-fixtures';

const databaseBlob = (encoded: string): ArrayBuffer => {
  const bytes = base64UrlToBytes(encoded);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
};

const authenticatedGet = (path: string, accessToken: string): Promise<Response> =>
  SELF.fetch(
    new Request(`https://sync.invalid${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Origin: TEST_ORIGIN,
        'X-Mirna-Protocol-Version': String(SYNC_PROTOCOL_VERSION),
      },
    }),
  );

const authenticatedDelete = (path: string, accessToken: string, body: unknown): Promise<Response> =>
  SELF.fetch(
    new Request(`https://sync.invalid${path}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Origin: TEST_ORIGIN,
        'X-Mirna-Protocol-Version': String(SYNC_PROTOCOL_VERSION),
      },
      body: canonicalizeJson(body),
    }),
  );

const errorCode = async (response: Response): Promise<string | undefined> =>
  (await response.json<{ error?: { code?: string } }>()).error?.code;

const unsigned = (manifest: VaultManifestV1) => {
  const { signature: _signature, ...body } = manifest;
  void _signature;
  return body;
};

interface AddedDevice {
  readonly deviceId: string;
  readonly keys: Awaited<ReturnType<typeof generateDeviceKeyPairs>>;
  readonly publicKeys: DevicePublicKeysV1;
  readonly manifest: VaultManifestV1;
}

const addSecondDevice = async (fixture: InitialVaultFixture): Promise<AddedDevice> => {
  const keys = await generateDeviceKeyPairs();
  const deviceId = createOpaqueId();
  const publicKeys = {
    signing: await exportPublicEcKey(keys.signing.publicKey),
    agreement: await exportPublicEcKey(keys.agreement.publicKey),
  };
  const occurredAt = new Date().toISOString();
  const manifest = await signVaultManifest(
    unsignedVaultManifestSchema.parse({
      ...unsigned(fixture.manifest),
      manifestVersion: 2,
      devices: [
        ...fixture.manifest.devices,
        {
          deviceId,
          publicKeys,
          authorizedAt: occurredAt,
          authorizationExpiresAt: new Date(
            Date.parse(occurredAt) + 7 * 24 * 60 * 60 * 1_000,
          ).toISOString(),
        },
      ].sort((left, right) =>
        left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0,
      ),
      previousManifestHash: await manifestBodyHash(fixture.manifest),
      transition: {
        transitionId: createOpaqueId(),
        kind: 'add-device',
        authorizationKind: 'device',
        authorizingDeviceId: fixture.deviceId,
        affectedDeviceId: deviceId,
        occurredAt,
      },
    }),
    fixture.deviceKeys.signing.privateKey,
  );
  await validateManifestTransition(fixture.manifest, manifest);
  const manifestHash = await manifestBodyHash(manifest);
  const now = Date.now();
  await env.MIRNA_SYNC_DB.batch([
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO vault_manifests (
         vault_id, manifest_version, key_epoch, authorization_kind,
         signed_by_device_id, canonical_manifest, manifest_hash,
         previous_manifest_hash, signature, accepted_at
       ) VALUES (?1, 2, 1, 'device', ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      fixture.vaultId,
      fixture.deviceId,
      canonicalizeJson(manifest),
      databaseBlob(manifestHash),
      databaseBlob(manifest.previousManifestHash!),
      databaseBlob(manifest.signature),
      now,
    ),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO devices (
         vault_id, device_id, signing_public_key_raw, agreement_public_key_raw,
         status, added_in_manifest_version, created_at, revoked_at, last_seen_at
       ) VALUES (?1, ?2, ?3, ?4, 'active', 2, ?5, NULL, NULL)`,
    ).bind(fixture.vaultId, deviceId, publicKeys.signing.value, publicKeys.agreement.value, now),
    env.MIRNA_SYNC_DB.prepare(
      `INSERT INTO device_grants (
         grant_id, vault_id, device_id, grant_version, issued_by_device_id,
         authorization_transcript_hash, authorization_signature, issued_at,
         expires_at, revoked_at
       ) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, NULL)`,
    ).bind(
      manifest.transition.transitionId,
      fixture.vaultId,
      deviceId,
      fixture.deviceId,
      databaseBlob(manifestHash),
      databaseBlob(manifest.signature),
      now,
      Date.parse(
        manifest.devices.find((device) => device.deviceId === deviceId)!.authorizationExpiresAt,
      ),
    ),
    env.MIRNA_SYNC_DB.prepare(
      `UPDATE vaults SET current_manifest_version = 2, updated_at = ?2
        WHERE vault_id = ?1 AND current_manifest_version = 1`,
    ).bind(fixture.vaultId, now),
  ]);
  return { deviceId, keys, publicKeys, manifest };
};

const createRenewal = async (
  fixture: InitialVaultFixture,
  challenge: Awaited<ReturnType<typeof issueChallenge>>,
) => {
  const current = fixture.manifest;
  const occurredAt = challenge.issuedAt;
  const expiresAt = new Date(
    Date.parse(occurredAt) + SYNC_LIMITS.deviceAuthorizationLifetimeMs,
  ).toISOString();
  const manifest = await signVaultManifest(
    unsignedVaultManifestSchema.parse({
      ...unsigned(current),
      manifestVersion: 2,
      devices: current.devices.map((device) => ({
        ...device,
        authorizedAt: occurredAt,
        authorizationExpiresAt: expiresAt,
      })),
      previousManifestHash: await manifestBodyHash(current),
      transition: {
        transitionId: createOpaqueId(),
        kind: 'renew-device',
        authorizationKind: 'device',
        authorizingDeviceId: fixture.deviceId,
        affectedDeviceId: fixture.deviceId,
        occurredAt,
      },
    }),
    fixture.deviceKeys.signing.privateKey,
  );
  return deviceRenewRequestSchema.parse({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    newManifest: manifest,
    sensitiveChallenge: challenge,
    sensitiveSignature: await signChallenge(fixture, challenge),
  });
};

const createDeviceEnvelope = async (input: {
  readonly fixture: InitialVaultFixture;
  readonly manifest: VaultManifestV1;
  readonly manifestHash: string;
  readonly recipientId: string;
  readonly recipientAgreementPublicKey: CryptoKey;
  readonly vaultMasterKey: Uint8Array;
}): Promise<DeviceKeyEnvelopeV1> => {
  const ecdhSalt = randomBytes(32);
  try {
    const context = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: input.fixture.vaultId,
      keyEpoch: input.manifest.keyEpoch,
      senderDeviceId: input.fixture.deviceId,
      recipientDeviceId: input.recipientId,
      parentManifestHash: input.manifestHash,
    };
    const wrappingKey = await deriveDeviceEnvelopeWrappingKey(
      input.fixture.deviceKeys.agreement.privateKey,
      input.recipientAgreementPublicKey,
      ecdhSalt,
      context,
    );
    return deviceKeyEnvelopeSchema.parse({
      ...context,
      ecdhSalt: bytesToBase64Url(ecdhSalt),
      encryptedKey: await createEncryptedKeyEnvelope(input.vaultMasterKey, wrappingKey, {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        vaultId: input.fixture.vaultId,
        keyEpoch: input.manifest.keyEpoch,
        objectType: 'device-key-envelope',
        objectId: createOpaqueId(),
        creatingDeviceId: input.fixture.deviceId,
        recoveryLookupId: null,
        parentManifestHash: input.manifestHash,
      }),
    });
  } finally {
    clearBytes(ecdhSalt);
  }
};

const createRevocation = async (
  fixture: InitialVaultFixture,
  added: AddedDevice,
): Promise<{
  readonly request: SecureDeviceRevocationRequestV1;
  readonly newVaultMasterKey: Uint8Array;
}> => {
  const challengeResponse = await postCanonical('/v1/recovery/challenge', {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    recoveryLookupId: fixture.recoveryLookupId,
    newDeviceId: fixture.deviceId,
    newDevicePublicKeys: fixture.devicePublicKeys,
    origin: TEST_ORIGIN,
  });
  expect(challengeResponse.status).toBe(201);
  const challenge = recoveryChallengeSchema.parse(await challengeResponse.json());
  const occurredAt = challenge.issuedAt;
  const newManifest = await signVaultManifest(
    unsignedVaultManifestSchema.parse({
      ...unsigned(added.manifest),
      manifestVersion: 3,
      keyEpoch: 2,
      devices: added.manifest.devices.filter((device) => device.deviceId !== added.deviceId),
      revokedDevices: [
        {
          deviceId: added.deviceId,
          publicKeys: added.publicKeys,
          revokedAt: occurredAt,
          revocationAuthority: 'device',
          revokedByDeviceId: fixture.deviceId,
          lastAuthorizedManifestVersion: 2,
        },
      ],
      previousManifestHash: await manifestBodyHash(added.manifest),
      transition: {
        transitionId: createOpaqueId(),
        kind: 'revoke-device',
        authorizationKind: 'device',
        authorizingDeviceId: fixture.deviceId,
        affectedDeviceId: added.deviceId,
        occurredAt,
      },
    }),
    fixture.deviceKeys.signing.privateKey,
  );
  await validateManifestTransition(added.manifest, newManifest);
  const newManifestHash = await manifestBodyHash(newManifest);
  const recoveryKeys = await deriveRecoveryKeys(fixture.recoveryRoot, {
    vaultId: fixture.vaultId,
    recoveryLookupId: fixture.recoveryLookupId,
  });
  const newVaultMasterKey = randomBytes(32);
  const recoveryPublicKey = await exportPublicEcKey(fixture.recoverySigningKeys.publicKey);
  const recoveryEnvelope = await createEncryptedRecoveryBundleEnvelope(
    {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: fixture.vaultId,
      recoveryLookupId: fixture.recoveryLookupId,
      keyEpoch: 2,
      vaultMasterKey: bytesToBase64Url(newVaultMasterKey),
      recoverySigningPrivateKeyPkcs8: await exportRecoverySigningPrivateKey(
        fixture.recoverySigningKeys.privateKey,
      ),
      recoverySigningPublicKey: recoveryPublicKey,
      pinnedManifest: newManifest,
      pinnedManifestHash: newManifestHash,
    },
    recoveryKeys.wrappingKey,
    {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: fixture.vaultId,
      keyEpoch: 2,
      objectType: 'recovery-vault-key',
      objectId: createOpaqueId(),
      creatingDeviceId: fixture.deviceId,
      recoveryLookupId: fixture.recoveryLookupId,
      parentManifestHash: newManifestHash,
    },
  );
  const newRecovery = recoveryRecordSchema.parse({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId: fixture.vaultId,
    recoveryLookupId: fixture.recoveryLookupId,
    keyEpoch: 2,
    recoveryEnvelope,
    recoverySigningPublicKey: recoveryPublicKey,
    recoveryGateKeyHash: await hashRecoveryGateKey(recoveryKeys.gateKey),
    manifestVersion: 3,
    manifestHash: newManifestHash,
    updatedAt: occurredAt,
  });
  const deviceKeyEnvelopes = [
    await createDeviceEnvelope({
      fixture,
      manifest: newManifest,
      manifestHash: newManifestHash,
      recipientId: fixture.deviceId,
      recipientAgreementPublicKey: fixture.deviceKeys.agreement.publicKey,
      vaultMasterKey: newVaultMasterKey,
    }),
  ];
  const transcript = {
    type: 'mirna-secure-device-revocation-v1' as const,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    purpose: 'secure-device-revocation' as const,
    vaultId: fixture.vaultId,
    authorizingDeviceId: fixture.deviceId,
    revokedDeviceId: added.deviceId,
    recoveryChallenge: challenge,
    previousManifestVersion: 2,
    previousManifestHash: await manifestBodyHash(added.manifest),
    newManifestHash,
    newRecoveryHash: await hashDomainSeparatedCanonical(
      SYNC_DOMAIN_LABELS.recoveryRecord,
      newRecovery,
    ),
    deviceEnvelopeSetHash: await hashDomainSeparatedCanonical(
      SYNC_DOMAIN_LABELS.deviceEnvelopeSet,
      deviceKeyEnvelopes,
    ),
    idempotencyKey: newManifest.transition.transitionId,
    origin: TEST_ORIGIN,
    method: 'POST' as const,
    path: `/v1/devices/${added.deviceId}/revoke`,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  };
  return {
    newVaultMasterKey,
    request: secureDeviceRevocationRequestSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      transcript,
      gateKey: bytesToBase64Url(recoveryKeys.gateKey),
      gateProof: await createRecoveryProof(transcript, recoveryKeys.gateKey),
      deviceSignature: await signDomainSeparatedCanonical(
        SYNC_DOMAIN_LABELS.secureRevocation,
        transcript,
        fixture.deviceKeys.signing.privateKey,
      ),
      recoverySignature: await signDomainSeparatedCanonical(
        SYNC_DOMAIN_LABELS.secureRevocation,
        transcript,
        fixture.recoverySigningKeys.privateKey,
      ),
      newManifest,
      newRecovery,
      deviceKeyEnvelopes,
    }),
  };
};

describe('Phase 3 device security transitions', () => {
  it('renews a device with a fresh challenge and preserves exact retry semantics', async () => {
    const fixture = await createInitialVaultFixture();
    expect((await registerInitialVault(fixture)).status).toBe(201);
    const { accessToken } = await createAccessSession(fixture);
    const challenge = await issueChallenge(fixture, '/v1/devices/renew');
    const request = await createRenewal(fixture, challenge);

    const first = await postCanonical(`/v1/devices/${fixture.deviceId}/renew`, request, {
      accessToken,
    });
    expect(first.status).toBe(201);
    expect(deviceRenewResponseSchema.parse(await first.json()).renewed).toBe(true);

    const retry = await postCanonical(`/v1/devices/${fixture.deviceId}/renew`, request, {
      accessToken,
    });
    expect(retry.status).toBe(201);
    expect(deviceRenewResponseSchema.parse(await retry.json()).manifestVersion).toBe(2);

    const reused = structuredClone(request);
    reused.newManifest.signature = `${request.newManifest.signature[0] === 'A' ? 'B' : 'A'}${request.newManifest.signature.slice(1)}`;
    const mismatch = await postCanonical(`/v1/devices/${fixture.deviceId}/renew`, reused, {
      accessToken,
    });
    expect(mismatch.status).toBe(409);
    expect(await errorCode(mismatch)).toBe('SECURITY_TRANSITION_ID_REUSED');
  });

  it('securely revokes access, rotates to a random epoch key and excludes the lost device', async () => {
    const fixture = await createInitialVaultFixture();
    expect((await registerInitialVault(fixture)).status).toBe(201);
    const added = await addSecondDevice(fixture);
    const { accessToken: oldAccessToken } = await createAccessSession(fixture);
    const { request, newVaultMasterKey } = await createRevocation(fixture, added);
    try {
      const response = await postCanonical(`/v1/devices/${added.deviceId}/revoke`, request, {
        accessToken: oldAccessToken,
      });
      expect(response.status).toBe(201);
      const result = secureDeviceRevocationResponseSchema.parse(await response.json());
      expect(result).toMatchObject({ revoked: true, keyEpoch: 2, manifestVersion: 3 });

      const revokedSession = await authenticatedGet('/v1/vault/manifest', oldAccessToken);
      expect(revokedSession.status).toBe(401);

      const { accessToken: freshAccessToken } = await createAccessSession(fixture);
      const retry = await postCanonical(`/v1/devices/${added.deviceId}/revoke`, request, {
        accessToken: freshAccessToken,
      });
      expect(retry.status).toBe(201);
      expect(secureDeviceRevocationResponseSchema.parse(await retry.json()).keyEpoch).toBe(2);

      const manifestHistory = await authenticatedGet('/v1/manifests?after=1', freshAccessToken);
      expect(manifestHistory.status).toBe(200);
      expect(
        manifestChangesResponseSchema
          .parse(await manifestHistory.json())
          .manifests.map((manifest) => manifest.manifestVersion),
      ).toEqual([2, 3]);

      const envelopeResponse = await authenticatedGet('/v1/key-epochs/2', freshAccessToken);
      expect(envelopeResponse.status).toBe(200);
      const envelope = deviceKeyEnvelopeResponseSchema.parse(
        await envelopeResponse.json(),
      ).envelope;
      const salt = base64UrlToBytes(envelope.ecdhSalt);
      const wrappingKey = await deriveDeviceEnvelopeWrappingKey(
        fixture.deviceKeys.agreement.privateKey,
        fixture.deviceKeys.agreement.publicKey,
        salt,
        {
          protocolVersion: envelope.protocolVersion,
          suite: envelope.suite,
          vaultId: envelope.vaultId,
          keyEpoch: envelope.keyEpoch,
          senderDeviceId: envelope.senderDeviceId,
          recipientDeviceId: envelope.recipientDeviceId,
          parentManifestHash: envelope.parentManifestHash,
        },
      );
      clearBytes(salt);
      const opened = await openEncryptedKeyEnvelope(envelope.encryptedKey, wrappingKey);
      expect(timingSafeEqual(opened, newVaultMasterKey)).toBe(true);
      clearBytes(opened);

      const state = await env.MIRNA_SYNC_DB.prepare(
        `SELECT
           (SELECT status FROM devices WHERE vault_id = ?1 AND device_id = ?2) AS target_status,
           (SELECT current_key_epoch FROM vaults WHERE vault_id = ?1) AS key_epoch,
           (SELECT COUNT(*) FROM device_key_envelopes
             WHERE vault_id = ?1 AND recipient_device_id = ?2) AS target_envelopes,
           (SELECT COUNT(*) FROM device_key_envelopes
             WHERE vault_id = ?1 AND recipient_device_id = ?3) AS owner_envelopes`,
      )
        .bind(fixture.vaultId, added.deviceId, fixture.deviceId)
        .first<{
          target_status: string;
          key_epoch: number;
          target_envelopes: number;
          owner_envelopes: number;
        }>();
      expect(state).toEqual({
        target_status: 'revoked',
        key_epoch: 2,
        target_envelopes: 0,
        owner_envelopes: 1,
      });

      const revokedChallenge = await postCanonical('/v1/auth/challenge', {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        vaultId: fixture.vaultId,
        deviceId: added.deviceId,
        audience: '/v1/auth/session',
        origin: TEST_ORIGIN,
      });
      expect(revokedChallenge.status).toBe(403);
      expect(await errorCode(revokedChallenge)).toBe('DEVICE_AUTHORIZATION_REQUIRED');
    } finally {
      clearBytes(newVaultMasterKey);
    }
  });

  it('requires recovery authority and deletes the encrypted cloud vault resumably', async () => {
    const fixture = await createInitialVaultFixture();
    expect((await registerInitialVault(fixture)).status).toBe(201);
    const { accessToken } = await createAccessSession(fixture);
    const challengeResponse = await postCanonical('/v1/recovery/challenge', {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      recoveryLookupId: fixture.recoveryLookupId,
      newDeviceId: fixture.deviceId,
      newDevicePublicKeys: fixture.devicePublicKeys,
      origin: TEST_ORIGIN,
    });
    const challenge = recoveryChallengeSchema.parse(await challengeResponse.json());
    const transcript = {
      type: 'mirna-vault-deletion-v1' as const,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      purpose: 'delete-encrypted-cloud-vault' as const,
      vaultId: fixture.vaultId,
      authorizingDeviceId: fixture.deviceId,
      recoveryChallenge: challenge,
      manifestVersion: fixture.manifest.manifestVersion,
      manifestHash: await manifestBodyHash(fixture.manifest),
      idempotencyKey: createOpaqueId(),
      typedConfirmation: 'DELETE ENCRYPTED CLOUD VAULT' as const,
      origin: TEST_ORIGIN,
      method: 'DELETE' as const,
      path: '/v1/vault' as const,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    };
    const request = vaultDeletionRequestSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      transcript,
      gateKey: bytesToBase64Url(fixture.recoveryGateKey),
      gateProof: await createRecoveryProof(transcript, fixture.recoveryGateKey),
      deviceSignature: await signDomainSeparatedCanonical(
        SYNC_DOMAIN_LABELS.vaultDeletion,
        transcript,
        fixture.deviceKeys.signing.privateKey,
      ),
      recoverySignature: await signDomainSeparatedCanonical(
        SYNC_DOMAIN_LABELS.vaultDeletion,
        transcript,
        fixture.recoverySigningKeys.privateKey,
      ),
    });
    await Promise.all([
      env.MIRNA_SYNC_BUCKET.put(`v1/${fixture.vaultId}/snapshots/test/one`, 'ciphertext-one'),
      env.MIRNA_SYNC_BUCKET.put(`v1/${fixture.vaultId}/snapshots/test/two`, 'ciphertext-two'),
    ]);

    const bearerOnly = await authenticatedDelete('/v1/vault', accessToken, {
      protocolVersion: SYNC_PROTOCOL_VERSION,
    });
    expect(bearerOnly.status).toBe(400);

    const deleted = await authenticatedDelete('/v1/vault', accessToken, request);
    expect(deleted.status).toBe(200);
    expect(vaultDeletionResponseSchema.parse(await deleted.json())).toMatchObject({
      state: 'completed',
      deleted: true,
    });
    expect(
      (await env.MIRNA_SYNC_BUCKET.list({ prefix: `v1/${fixture.vaultId}/` })).objects,
    ).toEqual([]);
    const counts = await env.MIRNA_SYNC_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM vaults WHERE vault_id = ?1) AS vaults,
         (SELECT COUNT(*) FROM devices WHERE vault_id = ?1) AS devices,
         (SELECT COUNT(*) FROM vault_manifests WHERE vault_id = ?1) AS manifests,
         (SELECT COUNT(*) FROM recovery_records WHERE vault_id = ?1) AS recovery_records,
         (SELECT COUNT(*) FROM access_sessions WHERE vault_id = ?1) AS sessions,
         (SELECT COUNT(*) FROM deletion_requests WHERE vault_id = ?1 AND state = 'completed') AS tombstones`,
    )
      .bind(fixture.vaultId)
      .first<{
        vaults: number;
        devices: number;
        manifests: number;
        recovery_records: number;
        sessions: number;
        tombstones: number;
      }>();
    expect(counts).toEqual({
      vaults: 0,
      devices: 0,
      manifests: 0,
      recovery_records: 0,
      sessions: 0,
      tombstones: 1,
    });

    const exactRetry = await authenticatedDelete('/v1/vault', accessToken, request);
    expect(exactRetry.status).toBe(200);
    expect(vaultDeletionResponseSchema.parse(await exactRetry.json()).deleted).toBe(true);

    const mismatched = structuredClone(request);
    mismatched.deviceSignature = `${request.deviceSignature[0] === 'A' ? 'B' : 'A'}${request.deviceSignature.slice(1)}`;
    const rejectedReuse = await authenticatedDelete('/v1/vault', accessToken, mismatched);
    expect(rejectedReuse.status).toBe(409);
    expect(await errorCode(rejectedReuse)).toBe('DELETION_IDEMPOTENCY_REUSED');
  });
});
