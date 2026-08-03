import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  SYNC_CRYPTO_SUITE,
  SYNC_DOMAIN_LABELS,
  SYNC_PROTOCOL_VERSION,
} from '../../../src/domain/sync/constants';
import {
  createEncryptedRecoveryBundleEnvelope,
  createOpaqueId,
  createRecoveryCode,
  createRecoveryProof,
  deriveRecoveryKeys,
  exportPublicEcKey,
  exportRecoverySigningPrivateKey,
  generateDeviceKeyPairs,
  generateRecoverySigningKeyPair,
  hashDomainSeparatedCanonical,
  hashRecoveryGateKey,
  importRecoverySigningPrivateKey,
  openEncryptedRecoveryBundleEnvelope,
  parseRecoveryCode,
  randomBytes,
  signDomainSeparatedCanonical,
} from '../../../src/domain/sync/crypto';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  timingSafeEqual,
  utf8,
} from '../../../src/domain/sync/encoding';
import {
  manifestBodyHash,
  signVaultManifest,
  validateManifestTransition,
} from '../../../src/domain/sync/manifest';
import {
  recoveryBundleFetchResponseSchema,
  recoveryChallengeSchema,
  recoveryCompleteResponseSchema,
  recoveryRecordSchema,
  unsignedVaultManifestSchema,
  type DevicePublicKeysV1,
  type RecoveryBundleV1,
  type RecoveryRecordV1,
  type VaultManifestV1,
} from '../../../src/domain/sync/schemas';
import {
  createAccessSession,
  createInitialVaultFixture,
  postCanonical,
  randomEncoded,
  registerInitialVault,
  TEST_ORIGIN,
  type InitialVaultFixture,
} from './protocol-fixtures';
import { rawP256PublicKey } from './fixtures';

interface RecoveryCandidate {
  deviceId: string;
  keys: Awaited<ReturnType<typeof generateDeviceKeyPairs>>;
  publicKeys: DevicePublicKeysV1;
}

interface RecoveryRotation {
  manifest: VaultManifestV1;
  recovery: RecoveryRecordV1;
  recoveryRoot: Uint8Array;
  recoveryGateKey: Uint8Array;
  vaultMasterKey: Uint8Array;
  signingKeys: CryptoKeyPair;
}

const errorCode = async (response: Response): Promise<string | undefined> =>
  (await response.json<{ error?: { code?: string } }>()).error?.code;

const createRecoveryCandidate = async (): Promise<RecoveryCandidate> => {
  const keys = await generateDeviceKeyPairs();
  return {
    deviceId: createOpaqueId(),
    keys,
    publicKeys: {
      signing: await exportPublicEcKey(keys.signing.publicKey),
      agreement: await exportPublicEcKey(keys.agreement.publicKey),
    },
  };
};

const issueRecoveryChallenge = async (vault: InitialVaultFixture, candidate: RecoveryCandidate) => {
  const response = await postCanonical('/v1/recovery/challenge', {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    recoveryLookupId: vault.recoveryLookupId,
    newDeviceId: candidate.deviceId,
    newDevicePublicKeys: candidate.publicKeys,
    origin: TEST_ORIGIN,
  });
  expect(response.status).toBe(201);
  return recoveryChallengeSchema.parse(await response.json());
};

const bundleFetchTranscript = (challenge: ReturnType<typeof recoveryChallengeSchema.parse>) => ({
  type: 'mirna-recovery-bundle-fetch-v1' as const,
  protocolVersion: SYNC_PROTOCOL_VERSION,
  suite: SYNC_CRYPTO_SUITE,
  challenge,
  afterManifestVersion: null,
});

const fetchRecoveryBundle = async (
  challenge: ReturnType<typeof recoveryChallengeSchema.parse>,
  gateKey: Uint8Array,
): Promise<Response> => {
  const transcript = bundleFetchTranscript(challenge);
  return postCanonical('/v1/recovery/bundle', {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    gateKey: bytesToBase64Url(gateKey),
    transcript,
    gateProof: await createRecoveryProof(transcript, gateKey),
  });
};

const createRecoveryRotation = async (
  previousManifest: VaultManifestV1,
  previousRecoverySigningPrivateKey: CryptoKey,
  candidate: RecoveryCandidate,
): Promise<RecoveryRotation> => {
  const occurredAt = new Date().toISOString();
  const recoveryLookupId = createOpaqueId();
  const recoveryRoot = new Uint8Array(32).fill(0x4e);
  const vaultMasterKey = utf8('RECOVERED-VMK-PRIVATE-DATA-12345');
  const signingKeys = await generateRecoverySigningKeyPair();
  const signingPublicKey = await exportPublicEcKey(signingKeys.publicKey);
  const previousManifestHash = await manifestBodyHash(previousManifest);
  const unsignedManifest = unsignedVaultManifestSchema.parse({
    type: previousManifest.type,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId: previousManifest.vaultId,
    manifestVersion: previousManifest.manifestVersion + 1,
    keyEpoch: previousManifest.keyEpoch + 1,
    devices: [
      {
        deviceId: candidate.deviceId,
        publicKeys: candidate.publicKeys,
        authorizedAt: occurredAt,
        authorizationExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      },
    ],
    revokedDevices: [
      ...previousManifest.revokedDevices,
      ...previousManifest.devices.map((device) => ({
        deviceId: device.deviceId,
        publicKeys: device.publicKeys,
        revokedAt: occurredAt,
        revocationAuthority: 'recovery' as const,
        revokedByDeviceId: null,
        lastAuthorizedManifestVersion: previousManifest.manifestVersion,
      })),
    ].sort((left, right) =>
      left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0,
    ),
    recoveryLookupId,
    recoverySigningPublicKey: signingPublicKey,
    previousManifestHash,
    transition: {
      transitionId: createOpaqueId(),
      kind: 'recover-device',
      authorizationKind: 'recovery',
      authorizingDeviceId: null,
      affectedDeviceId: candidate.deviceId,
      occurredAt,
    },
  });
  const manifest = await signVaultManifest(unsignedManifest, previousRecoverySigningPrivateKey);
  await validateManifestTransition(previousManifest, manifest);
  const manifestHash = await manifestBodyHash(manifest);
  const recoveryKeys = await deriveRecoveryKeys(recoveryRoot, {
    vaultId: manifest.vaultId,
    recoveryLookupId,
  });
  const recoveryEnvelope = await createEncryptedRecoveryBundleEnvelope(
    {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: manifest.vaultId,
      recoveryLookupId,
      keyEpoch: manifest.keyEpoch,
      vaultMasterKey: bytesToBase64Url(vaultMasterKey),
      recoverySigningPrivateKeyPkcs8: await exportRecoverySigningPrivateKey(signingKeys.privateKey),
      recoverySigningPublicKey: signingPublicKey,
      pinnedManifest: manifest,
      pinnedManifestHash: manifestHash,
    },
    recoveryKeys.wrappingKey,
    {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: manifest.vaultId,
      keyEpoch: manifest.keyEpoch,
      objectType: 'recovery-vault-key',
      objectId: createOpaqueId(),
      creatingDeviceId: candidate.deviceId,
      recoveryLookupId,
      parentManifestHash: manifestHash,
    },
  );
  const recovery = recoveryRecordSchema.parse({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId: manifest.vaultId,
    recoveryLookupId,
    keyEpoch: manifest.keyEpoch,
    recoveryEnvelope,
    recoverySigningPublicKey: signingPublicKey,
    recoveryGateKeyHash: await hashRecoveryGateKey(recoveryKeys.gateKey),
    manifestVersion: manifest.manifestVersion,
    manifestHash,
    updatedAt: occurredAt,
  });
  return {
    manifest,
    recovery,
    recoveryRoot,
    recoveryGateKey: recoveryKeys.gateKey,
    vaultMasterKey,
    signingKeys,
  };
};

type RecoveryChallenge = ReturnType<typeof recoveryChallengeSchema.parse>;

const buildRecoveryCompletionRequest = async (
  challenge: RecoveryChallenge,
  challengedCandidate: RecoveryCandidate,
  rotation: RecoveryRotation,
  gateKey: Uint8Array,
  recoverySigningPrivateKey: CryptoKey,
  idempotencyKey = createOpaqueId(),
) => {
  const newManifestHash = await manifestBodyHash(rotation.manifest);
  const newRecoveryHash = await hashDomainSeparatedCanonical(
    SYNC_DOMAIN_LABELS.recoveryRecord,
    rotation.recovery,
  );
  const transcript = {
    type: 'mirna-recovery-proof-v1' as const,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    purpose: 'recovery-manifest-transition' as const,
    vaultId: challenge.vaultId,
    recoveryLookupId: challenge.recoveryLookupId,
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
    newDeviceId: challengedCandidate.deviceId,
    newDevicePublicKeys: challengedCandidate.publicKeys,
    previousManifestVersion: challenge.previousManifestVersion,
    previousManifestHash: challenge.previousManifestHash,
    transitionBodyHash: newManifestHash,
    newRecoveryBundleHash: newRecoveryHash,
    newRecoveryLookupId: rotation.recovery.recoveryLookupId,
    idempotencyKey,
    origin: TEST_ORIGIN,
    method: 'POST' as const,
    path: `/v1/vaults/${challenge.vaultId}/recover`,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  };
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    gateKey: bytesToBase64Url(gateKey),
    transcript,
    gateProof: await createRecoveryProof(transcript, gateKey),
    recoveryAuthorizationSignature: await signDomainSeparatedCanonical(
      SYNC_DOMAIN_LABELS.recoveryTransition,
      transcript,
      recoverySigningPrivateKey,
    ),
    newManifest: rotation.manifest,
    newRecovery: rotation.recovery,
  };
};

describe('Phase 1 recovery authorization', () => {
  it('validates the offline code checksum and rejects a valid-looking code for another vault', async () => {
    const vault = await createInitialVaultFixture();
    expect((await registerInitialVault(vault)).status).toBe(201);

    const code = await createRecoveryCode(vault.recoveryLookupId, vault.recoveryRoot);
    const parsed = await parseRecoveryCode(code);
    expect(parsed.recoveryLookupId).toBe(vault.recoveryLookupId);
    expect(timingSafeEqual(parsed.recoveryRoot, vault.recoveryRoot)).toBe(true);
    const damagedChecksum = `${code.slice(0, 4)}${code[4] === '0' ? '1' : '0'}${code.slice(5)}`;
    await expect(parseRecoveryCode(damagedChecksum)).rejects.toThrow(/kontrolnu sumu/u);

    const foreignLookupId = createOpaqueId();
    const foreignCode = await createRecoveryCode(foreignLookupId, randomBytes(32));
    const foreign = await parseRecoveryCode(foreignCode);
    const candidate = await createRecoveryCandidate();
    const wrongVault = await postCanonical('/v1/recovery/challenge', {
      protocolVersion: 1,
      suite: SYNC_CRYPTO_SUITE,
      recoveryLookupId: foreign.recoveryLookupId,
      newDeviceId: candidate.deviceId,
      newDevicePublicKeys: candidate.publicKeys,
      origin: TEST_ORIGIN,
    });
    expect(wrongVault.status).toBe(404);
    expect(await errorCode(wrongVault)).toBe('RESOURCE_NOT_FOUND');
  });

  it('rejects off-curve P-256 keys before creating a recovery challenge', async () => {
    const vault = await createInitialVaultFixture();
    expect((await registerInitialVault(vault)).status).toBe(201);
    const candidate = await createRecoveryCandidate();
    const invalidPublicKey = {
      format: 'raw-p256' as const,
      value: rawP256PublicKey(0),
    };

    for (const publicKeys of [
      { ...candidate.publicKeys, signing: invalidPublicKey },
      { ...candidate.publicKeys, agreement: invalidPublicKey },
    ]) {
      const response = await postCanonical('/v1/recovery/challenge', {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        recoveryLookupId: vault.recoveryLookupId,
        newDeviceId: candidate.deviceId,
        newDevicePublicKeys: publicKeys,
        origin: TEST_ORIGIN,
      });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('INVALID_PUBLIC_KEY');
    }
    expect(
      await env.MIRNA_SYNC_DB.prepare(
        'SELECT COUNT(*) AS count FROM recovery_challenges',
      ).first<number>('count'),
    ).toBe(0);
  });

  it('downloads only ciphertext with a valid gate proof and rejects a wrong recovery root', async () => {
    const vault = await createInitialVaultFixture();
    expect((await registerInitialVault(vault)).status).toBe(201);
    const candidate = await createRecoveryCandidate();
    const challenge = await issueRecoveryChallenge(vault, candidate);
    const wrongRoot = new Uint8Array(32).fill(0x53);
    const wrongKeys = await deriveRecoveryKeys(wrongRoot, {
      vaultId: vault.vaultId,
      recoveryLookupId: vault.recoveryLookupId,
    });

    const wrongProof = await fetchRecoveryBundle(challenge, wrongKeys.gateKey);
    expect(wrongProof.status).toBe(403);
    expect(await errorCode(wrongProof)).toBe('RECOVERY_PROOF_INVALID');

    const correct = await fetchRecoveryBundle(challenge, vault.recoveryGateKey);
    expect(correct.status).toBe(200);
    const fetched = recoveryBundleFetchResponseSchema.parse(await correct.json());
    expect(fetched.manifestChain).toEqual([vault.manifest]);
    expect(fetched.recoveryEnvelope).toEqual(vault.recovery.recoveryEnvelope);
    const opened = await openEncryptedRecoveryBundleEnvelope(
      fetched.recoveryEnvelope,
      (
        await deriveRecoveryKeys(vault.recoveryRoot, {
          vaultId: vault.vaultId,
          recoveryLookupId: vault.recoveryLookupId,
        })
      ).wrappingKey,
    );
    expect(base64UrlToBytes(opened.vaultMasterKey)).toEqual(vault.vaultMasterKey);
  });

  it('locks recovery after five failed proofs and refuses even a later correct proof', async () => {
    const vault = await createInitialVaultFixture();
    expect((await registerInitialVault(vault)).status).toBe(201);
    const challenge = await issueRecoveryChallenge(vault, await createRecoveryCandidate());
    const wrongGateKey = randomBytes(32);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await fetchRecoveryBundle(challenge, wrongGateKey);
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('RECOVERY_PROOF_INVALID');
    }
    const locked = await env.MIRNA_SYNC_DB.prepare(
      `SELECT failed_attempts, locked_until
         FROM recovery_records WHERE recovery_lookup_id = ?1`,
    )
      .bind(vault.recoveryLookupId)
      .first<{ failed_attempts: number; locked_until: number | null }>();
    expect(locked?.failed_attempts).toBe(5);
    expect(locked?.locked_until).toBeGreaterThan(Date.now());

    const newChallenge = await postCanonical('/v1/recovery/challenge', {
      protocolVersion: 1,
      suite: SYNC_CRYPTO_SUITE,
      recoveryLookupId: vault.recoveryLookupId,
      newDeviceId: createOpaqueId(),
      newDevicePublicKeys: (await createRecoveryCandidate()).publicKeys,
      origin: TEST_ORIGIN,
    });
    expect(newChallenge.status).toBe(404);
    const bypassAttempt = await fetchRecoveryBundle(challenge, vault.recoveryGateKey);
    expect([403, 404]).toContain(bypassAttempt.status);
  });
});

describe('Phase 1 complete loss recovery and rotation', () => {
  it.each(['signing', 'agreement'] as const)(
    'rejects a recovered manifest whose %s key differs from the frozen challenge',
    async (keyKind) => {
      const vault = await createInitialVaultFixture();
      expect((await registerInitialVault(vault)).status).toBe(201);
      const candidate = await createRecoveryCandidate();
      const challenge = await issueRecoveryChallenge(vault, candidate);
      const foreignKeys = await generateDeviceKeyPairs();
      const foreignPublicKeys: DevicePublicKeysV1 = {
        signing: await exportPublicEcKey(foreignKeys.signing.publicKey),
        agreement: await exportPublicEcKey(foreignKeys.agreement.publicKey),
      };
      const manifestCandidate: RecoveryCandidate = {
        ...candidate,
        publicKeys: {
          signing: keyKind === 'signing' ? foreignPublicKeys.signing : candidate.publicKeys.signing,
          agreement:
            keyKind === 'agreement' ? foreignPublicKeys.agreement : candidate.publicKeys.agreement,
        },
      };
      const rotation = await createRecoveryRotation(
        vault.manifest,
        vault.recoverySigningKeys.privateKey,
        manifestCandidate,
      );
      const requestBody = await buildRecoveryCompletionRequest(
        challenge,
        candidate,
        rotation,
        vault.recoveryGateKey,
        vault.recoverySigningKeys.privateKey,
      );

      const response = await postCanonical(`/v1/vaults/${vault.vaultId}/recover`, requestBody);
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('RECOVERY_DEVICE_MISMATCH');
      const state = await env.MIRNA_SYNC_DB.prepare(
        `SELECT
           (SELECT current_manifest_version FROM vaults
             WHERE vault_id = ?1) AS manifest_version,
           (SELECT COUNT(*) FROM vault_manifests
             WHERE vault_id = ?1 AND manifest_version = 2) AS rotated_manifests,
           (SELECT consumed_at FROM recovery_challenges
             WHERE challenge_id = ?2) AS consumed_at`,
      )
        .bind(vault.vaultId, challenge.challengeId)
        .first<{
          manifest_version: number;
          rotated_manifests: number;
          consumed_at: number | null;
        }>();
      expect(state).toEqual({ manifest_version: 1, rotated_manifests: 0, consumed_at: null });
    },
  );

  it('restores from the encrypted bundle, rotates all authorities and rejects replay/old code', async () => {
    const vault = await createInitialVaultFixture();
    expect((await registerInitialVault(vault)).status).toBe(201);
    const oldSession = await createAccessSession(vault);
    const candidate = await createRecoveryCandidate();
    const challenge = await issueRecoveryChallenge(vault, candidate);

    // The recovery code is the only client-side bootstrap material retained after simulated loss.
    const parsedCode = await parseRecoveryCode(
      await createRecoveryCode(vault.recoveryLookupId, vault.recoveryRoot),
    );
    const recoveredKeys = await deriveRecoveryKeys(parsedCode.recoveryRoot, {
      vaultId: challenge.vaultId,
      recoveryLookupId: parsedCode.recoveryLookupId,
    });
    const bundleResponse = await fetchRecoveryBundle(challenge, recoveredKeys.gateKey);
    expect(bundleResponse.status).toBe(200);
    const encryptedBundle = recoveryBundleFetchResponseSchema.parse(await bundleResponse.json());
    const recoveredBundle: RecoveryBundleV1 = await openEncryptedRecoveryBundleEnvelope(
      encryptedBundle.recoveryEnvelope,
      recoveredKeys.wrappingKey,
    );
    expect(base64UrlToBytes(recoveredBundle.vaultMasterKey)).toEqual(vault.vaultMasterKey);
    const recoveredSigningPrivateKey = await importRecoverySigningPrivateKey(
      recoveredBundle.recoverySigningPrivateKeyPkcs8,
    );
    const rotation = await createRecoveryRotation(
      recoveredBundle.pinnedManifest,
      recoveredSigningPrivateKey,
      candidate,
    );
    const requestBody = await buildRecoveryCompletionRequest(
      challenge,
      candidate,
      rotation,
      recoveredKeys.gateKey,
      recoveredSigningPrivateKey,
    );

    const wrongRoute = await postCanonical(`/v1/vaults/${createOpaqueId()}/recover`, requestBody);
    expect(wrongRoute.status).toBe(403);
    expect(await errorCode(wrongRoute)).toBe('RECOVERY_TRANSCRIPT_MISMATCH');
    const concurrentRecoveries = await Promise.all([
      postCanonical(`/v1/vaults/${vault.vaultId}/recover`, requestBody),
      postCanonical(`/v1/vaults/${vault.vaultId}/recover`, requestBody),
    ]);
    expect(concurrentRecoveries.map((response) => response.status).sort()).toEqual([200, 201]);
    for (const recovered of concurrentRecoveries) {
      expect(recoveryCompleteResponseSchema.parse(await recovered.json())).toEqual({
        protocolVersion: 1,
        vaultId: vault.vaultId,
        deviceId: candidate.deviceId,
        manifestVersion: 2,
        recovered: true,
      });
    }

    const replay = await postCanonical(`/v1/vaults/${vault.vaultId}/recover`, requestBody);
    expect(replay.status).toBe(200);
    expect(recoveryCompleteResponseSchema.parse(await replay.json())).toEqual({
      protocolVersion: 1,
      vaultId: vault.vaultId,
      deviceId: candidate.deviceId,
      manifestVersion: 2,
      recovered: true,
    });
    const changedSameIdempotency = await postCanonical(`/v1/vaults/${vault.vaultId}/recover`, {
      ...requestBody,
      gateProof: randomEncoded(),
    });
    expect(changedSameIdempotency.status).toBe(409);
    expect(await errorCode(changedSameIdempotency)).toBe('RECOVERY_IDEMPOTENCY_REUSED');
    const mismatchedRetry = await postCanonical(`/v1/vaults/${vault.vaultId}/recover`, {
      ...requestBody,
      transcript: { ...requestBody.transcript, idempotencyKey: createOpaqueId() },
    });
    expect(mismatchedRetry.status).toBe(409);
    expect(await errorCode(mismatchedRetry)).toBe('RECOVERY_IDEMPOTENCY_REUSED');
    const oldCode = await postCanonical('/v1/recovery/challenge', {
      protocolVersion: 1,
      suite: SYNC_CRYPTO_SUITE,
      recoveryLookupId: vault.recoveryLookupId,
      newDeviceId: createOpaqueId(),
      newDevicePublicKeys: (await createRecoveryCandidate()).publicKeys,
      origin: TEST_ORIGIN,
    });
    expect(oldCode.status).toBe(404);

    const oldSessionUse = await SELF.fetch('https://sync.invalid/v1/vault/manifest', {
      headers: {
        Authorization: `Bearer ${oldSession.accessToken}`,
        Origin: TEST_ORIGIN,
        'X-Mirna-Protocol-Version': '1',
      },
    });
    expect(oldSessionUse.status).toBe(401);

    const recoveredAuthFixture: InitialVaultFixture = {
      ...vault,
      deviceId: candidate.deviceId,
      deviceKeys: candidate.keys,
      devicePublicKeys: candidate.publicKeys,
      recoveryLookupId: rotation.recovery.recoveryLookupId,
      recoveryRoot: rotation.recoveryRoot,
      recoveryGateKey: rotation.recoveryGateKey,
      recoverySigningKeys: rotation.signingKeys,
      vaultMasterKey: rotation.vaultMasterKey,
      manifest: rotation.manifest,
      recovery: rotation.recovery,
    };
    const recoveredSession = await createAccessSession(recoveredAuthFixture);
    expect(recoveredSession.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const newChallenge = await issueRecoveryChallenge(recoveredAuthFixture, candidate);
    const newBundleResponse = await fetchRecoveryBundle(newChallenge, rotation.recoveryGateKey);
    expect(newBundleResponse.status).toBe(200);
    const newBundle = recoveryBundleFetchResponseSchema.parse(await newBundleResponse.json());
    const newRecoveryKeys = await deriveRecoveryKeys(rotation.recoveryRoot, {
      vaultId: vault.vaultId,
      recoveryLookupId: rotation.recovery.recoveryLookupId,
    });
    const openedRotation = await openEncryptedRecoveryBundleEnvelope(
      newBundle.recoveryEnvelope,
      newRecoveryKeys.wrappingKey,
    );
    expect(base64UrlToBytes(openedRotation.vaultMasterKey)).toEqual(rotation.vaultMasterKey);

    const state = await env.MIRNA_SYNC_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM recovery_records
           WHERE vault_id = ?1 AND rotated_at IS NULL) AS active_recovery,
         (SELECT COUNT(*) FROM recovery_records
           WHERE vault_id = ?1 AND rotated_at IS NOT NULL) AS old_recovery,
         (SELECT COUNT(*) FROM devices
           WHERE vault_id = ?1 AND status = 'active') AS active_devices,
         (SELECT COUNT(*) FROM devices
           WHERE vault_id = ?1 AND status = 'revoked') AS revoked_devices,
         (SELECT current_key_epoch FROM vaults WHERE vault_id = ?1) AS key_epoch`,
    )
      .bind(vault.vaultId)
      .first<Record<string, number>>();
    expect(state).toEqual({
      active_recovery: 1,
      old_recovery: 1,
      active_devices: 1,
      revoked_devices: 1,
      key_epoch: 2,
    });

    const stored = JSON.stringify(
      await env.MIRNA_SYNC_DB.prepare(
        `SELECT canonical_recovery_envelope, hex(recovery_gate_key_hash) AS gate_hash
           FROM recovery_records WHERE vault_id = ?1 ORDER BY recovery_version`,
      )
        .bind(vault.vaultId)
        .all(),
    );
    for (const forbidden of [
      'SALARY-123456-RSD-PRIVATE-DATA!!',
      'RECOVERED-VMK-PRIVATE-DATA-12345',
      bytesToHex(vault.recoveryRoot).toUpperCase(),
      bytesToHex(rotation.recoveryRoot).toUpperCase(),
      bytesToHex(vault.vaultMasterKey).toUpperCase(),
      bytesToHex(rotation.vaultMasterKey).toUpperCase(),
    ]) {
      expect(stored).not.toContain(forbidden);
    }
    expect((await env.MIRNA_SYNC_BUCKET.list()).objects).toEqual([]);
  });
});
