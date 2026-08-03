import { describe, expect, it } from 'vitest';
import { SYNC_CRYPTO_SUITE, SYNC_PROTOCOL_VERSION } from '@/domain/sync/constants';
import {
  createEncryptedKeyEnvelope,
  createEncryptedRecoveryBundleEnvelope,
  createOpaqueId,
  createRecoveryCode,
  deriveDeviceEnvelopeWrappingKey,
  deriveRecoveryKeys,
  exportPublicEcKey,
  exportRecoverySigningPrivateKey,
  generateDeviceKeyPairs,
  generateLocalWrappingKey,
  generateRecoverySigningKeyPair,
  hashRecoveryGateKey,
  openEncryptedKeyEnvelope,
  randomBytes,
} from '@/domain/sync/crypto';
import { base64UrlToBytes, bytesToBase64Url, clearBytes } from '@/domain/sync/encoding';
import { createInitialManifest, manifestBodyHash, signVaultManifest } from '@/domain/sync/manifest';
import {
  authChallengeSchema,
  recoveryChallengeSchema,
  recoveryRecordSchema,
  unsignedVaultManifestSchema,
  type AuthChallengeV1,
  type RecoveryRecordV1,
  type SecureDeviceRevocationRequestV1,
  type VaultManifestV1,
} from '@/domain/sync/schemas';
import {
  ACTIVE_SYNC_VAULT_RECORD_ID,
  LOCAL_SYNC_DEVICE_RECORD_ID,
  SYNC_METADATA_RECORD_ID,
  localVaultKeyRecordId,
  type LocalSyncSetup,
} from '@/db/sync/records';
import {
  CLOUD_VAULT_DELETE_CONFIRMATION,
  DeviceSecurityService,
  type DeviceSecurityApiPort,
  type DeviceSecurityRepositoryPort,
} from './device-security-service';

const ORIGIN = 'http://localhost:5173';
const NOW = new Date('2026-07-31T10:10:00.000Z');

const unsigned = (manifest: VaultManifestV1) => {
  const { signature: _signature, ...body } = manifest;
  void _signature;
  return body;
};

interface SecurityFixture {
  readonly setup: LocalSyncSetup;
  readonly localKeys: Awaited<ReturnType<typeof generateDeviceKeyPairs>>;
  readonly remoteKeys: Awaited<ReturnType<typeof generateDeviceKeyPairs>>;
  readonly remoteDeviceId: string;
  readonly recoveryRoot: Uint8Array;
  readonly recoveryCode: string;
  readonly recovery: RecoveryRecordV1;
  readonly manifestChain: readonly VaultManifestV1[];
}

const createFixture = async (): Promise<SecurityFixture> => {
  const [localKeys, remoteKeys, localWrappingKey, recoverySigningKeys] = await Promise.all([
    generateDeviceKeyPairs(),
    generateDeviceKeyPairs(),
    generateLocalWrappingKey(),
    generateRecoverySigningKeyPair(),
  ]);
  const vaultId = createOpaqueId();
  const localDeviceId = createOpaqueId();
  const remoteDeviceId = createOpaqueId();
  const recoveryLookupId = createOpaqueId();
  const initialAt = '2026-07-31T10:00:00.000Z';
  const localPublicKeys = {
    signing: await exportPublicEcKey(localKeys.signing.publicKey),
    agreement: await exportPublicEcKey(localKeys.agreement.publicKey),
  };
  const initial = await createInitialManifest({
    vaultId,
    recoveryLookupId,
    transitionId: createOpaqueId(),
    device: {
      deviceId: localDeviceId,
      publicKeys: localPublicKeys,
      authorizedAt: initialAt,
      authorizationExpiresAt: '2026-08-30T10:00:00.000Z',
    },
    recoverySigningPublicKey: recoverySigningKeys.publicKey,
    signingPrivateKey: localKeys.signing.privateKey,
    createdAt: initialAt,
  });
  const remotePublicKeys = {
    signing: await exportPublicEcKey(remoteKeys.signing.publicKey),
    agreement: await exportPublicEcKey(remoteKeys.agreement.publicKey),
  };
  const pairedAt = '2026-07-31T10:05:00.000Z';
  const current = await signVaultManifest(
    unsignedVaultManifestSchema.parse({
      ...unsigned(initial),
      manifestVersion: 2,
      devices: [
        ...initial.devices,
        {
          deviceId: remoteDeviceId,
          publicKeys: remotePublicKeys,
          authorizedAt: pairedAt,
          authorizationExpiresAt: '2026-08-30T10:05:00.000Z',
        },
      ].sort((left, right) =>
        left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0,
      ),
      previousManifestHash: await manifestBodyHash(initial),
      transition: {
        transitionId: createOpaqueId(),
        kind: 'add-device',
        authorizationKind: 'device',
        authorizingDeviceId: localDeviceId,
        affectedDeviceId: remoteDeviceId,
        occurredAt: pairedAt,
      },
    }),
    localKeys.signing.privateKey,
  );
  const [initialHash, currentHash] = await Promise.all([
    manifestBodyHash(initial),
    manifestBodyHash(current),
  ]);
  const recoveryRoot = randomBytes(32);
  const vaultMasterKey = randomBytes(32);
  const recoveryKeys = await deriveRecoveryKeys(recoveryRoot, { vaultId, recoveryLookupId });
  const recoverySigningPublicKey = await exportPublicEcKey(recoverySigningKeys.publicKey);
  const recoveryEnvelope = await createEncryptedRecoveryBundleEnvelope(
    {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId,
      recoveryLookupId,
      keyEpoch: 1,
      vaultMasterKey: bytesToBase64Url(vaultMasterKey),
      recoverySigningPrivateKeyPkcs8: await exportRecoverySigningPrivateKey(
        recoverySigningKeys.privateKey,
      ),
      recoverySigningPublicKey,
      pinnedManifest: initial,
      pinnedManifestHash: initialHash,
    },
    recoveryKeys.wrappingKey,
    {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId,
      keyEpoch: 1,
      objectType: 'recovery-vault-key',
      objectId: createOpaqueId(),
      creatingDeviceId: localDeviceId,
      recoveryLookupId,
      parentManifestHash: initialHash,
    },
  );
  const recovery = recoveryRecordSchema.parse({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId,
    recoveryLookupId,
    keyEpoch: 1,
    recoveryEnvelope,
    recoverySigningPublicKey,
    recoveryGateKeyHash: await hashRecoveryGateKey(recoveryKeys.gateKey),
    manifestVersion: 1,
    manifestHash: initialHash,
    updatedAt: initialAt,
  });
  clearBytes(recoveryKeys.gateKey);
  const localEncryptedKey = await createEncryptedKeyEnvelope(vaultMasterKey, localWrappingKey, {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId,
    keyEpoch: 1,
    objectType: 'local-vault-key',
    objectId: createOpaqueId(),
    creatingDeviceId: localDeviceId,
    recoveryLookupId: null,
    parentManifestHash: currentHash,
  });
  clearBytes(vaultMasterKey);
  return {
    setup: {
      vault: {
        id: ACTIVE_SYNC_VAULT_RECORD_ID,
        vaultId,
        protocolVersion: SYNC_PROTOCOL_VERSION,
        cryptoSuite: SYNC_CRYPTO_SUITE,
        keyEpoch: 1,
        status: 'active',
        manifest: current,
        createdAt: initialAt,
        updatedAt: pairedAt,
      },
      device: {
        id: LOCAL_SYNC_DEVICE_RECORD_ID,
        vaultId,
        deviceId: localDeviceId,
        displayName: 'Telefon',
        signingPrivateKey: localKeys.signing.privateKey,
        signingPublicKey: localKeys.signing.publicKey,
        agreementPrivateKey: localKeys.agreement.privateKey,
        agreementPublicKey: localKeys.agreement.publicKey,
        localWrappingKey,
        authorizationExpiresAt: initial.devices[0].authorizationExpiresAt,
        createdAt: initialAt,
        updatedAt: pairedAt,
      },
      vaultKey: {
        id: localVaultKeyRecordId(vaultId, 1),
        vaultId,
        keyEpoch: 1,
        purpose: 'vault-master-key',
        encryptedKey: localEncryptedKey,
        createdAt: initialAt,
      },
      metadata: {
        id: SYNC_METADATA_RECORD_ID,
        vaultId,
        localSchemaVersion: 1,
        bootstrapMode: 'complete',
        firstUploadConsent: 'accepted',
        lastServerCursor: 0,
        lastSnapshotServerCursor: 0,
        lastSnapshotRevision: 1,
        lastSnapshotId: createOpaqueId(),
        lastSnapshotHash: bytesToBase64Url(randomBytes(32)),
        lastSnapshotContentHash: bytesToBase64Url(randomBytes(32)),
        lastManifestHash: currentHash,
        lastLocalDataHash: bytesToBase64Url(randomBytes(32)),
        enabledAt: initialAt,
      },
    },
    localKeys,
    remoteKeys,
    remoteDeviceId,
    recoveryRoot,
    recoveryCode: await createRecoveryCode(recoveryLookupId, recoveryRoot),
    recovery,
    manifestChain: [initial, current],
  };
};

class MemorySecurityRepository implements DeviceSecurityRepositoryPort {
  rotatedWrites = 0;

  constructor(public setup: LocalSyncSetup) {}

  read(): Promise<LocalSyncSetup> {
    return Promise.resolve(this.setup);
  }

  write(_current: LocalSyncSetup, next: LocalSyncSetup): Promise<LocalSyncSetup> {
    this.setup = next;
    return Promise.resolve(next);
  }

  writeRotated(setup: LocalSyncSetup): Promise<LocalSyncSetup> {
    this.rotatedWrites += 1;
    this.setup = setup;
    return Promise.resolve(setup);
  }

  rotationBlockers(): Promise<{ pendingOperations: number; pendingConflicts: number }> {
    return Promise.resolve({ pendingOperations: 0, pendingConflicts: 0 });
  }
}

class FakeDeviceSecurityApi implements DeviceSecurityApiPort {
  currentManifest: VaultManifestV1;
  recovery: RecoveryRecordV1;
  readonly manifests: VaultManifestV1[];
  committedRequest?: SecureDeviceRevocationRequestV1;
  deletionRequest?: Parameters<DeviceSecurityApiPort['deleteVault']>[0];
  throwAfterRevocationCommit = false;

  constructor(private readonly fixture: SecurityFixture) {
    this.currentManifest = fixture.setup.vault.manifest;
    this.recovery = fixture.recovery;
    this.manifests = [...fixture.manifestChain];
  }

  requestAuthChallenge(input: {
    vaultId: string;
    deviceId: string;
    audience: AuthChallengeV1['audience'];
    origin: string;
  }): Promise<unknown> {
    return Promise.resolve(
      authChallengeSchema.parse({
        type: 'mirna-auth-challenge-v1',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        vaultId: input.vaultId,
        deviceId: input.deviceId,
        challengeId: createOpaqueId(),
        challenge: bytesToBase64Url(randomBytes(32)),
        issuedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 5 * 60 * 1_000).toISOString(),
        audience: input.audience,
        origin: input.origin,
        method: 'POST',
      }),
    );
  }

  createSession(): Promise<unknown> {
    return Promise.resolve({
      expiresAt: new Date(NOW.getTime() + 5 * 60 * 1_000).toISOString(),
      authorizationExpiresAt: '2026-08-30T10:00:00.000Z',
    });
  }

  clearSession(): void {}

  getCurrentManifest(): Promise<unknown> {
    return Promise.resolve(this.currentManifest);
  }

  getManifestChanges(afterManifestVersion: number): Promise<unknown> {
    return Promise.resolve({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      manifests: this.manifests.filter(
        (manifest) => manifest.manifestVersion > afterManifestVersion,
      ),
      nextAfterManifestVersion: null,
    });
  }

  renewDevice(deviceId: string, input: { newManifest: VaultManifestV1 }): Promise<unknown> {
    this.currentManifest = input.newManifest;
    this.manifests.push(input.newManifest);
    return Promise.resolve({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      vaultId: input.newManifest.vaultId,
      deviceId,
      manifestVersion: input.newManifest.manifestVersion,
      authorizationExpiresAt: input.newManifest.devices.find(
        (device) => device.deviceId === deviceId,
      )!.authorizationExpiresAt,
      renewed: true,
    });
  }

  requestRecoveryChallenge(input: {
    recoveryLookupId: string;
    newDeviceId: string;
    newDevicePublicKeys: VaultManifestV1['devices'][number]['publicKeys'];
    origin: string;
  }): Promise<unknown> {
    return manifestBodyHash(this.currentManifest).then((previousManifestHash) =>
      recoveryChallengeSchema.parse({
        type: 'mirna-recovery-challenge-v1',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        recoveryLookupId: input.recoveryLookupId,
        vaultId: this.currentManifest.vaultId,
        challengeId: createOpaqueId(),
        challenge: bytesToBase64Url(randomBytes(32)),
        newDeviceId: input.newDeviceId,
        newDevicePublicKeys: input.newDevicePublicKeys,
        previousManifestVersion: this.currentManifest.manifestVersion,
        previousManifestHash,
        origin: input.origin,
        issuedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 5 * 60 * 1_000).toISOString(),
      }),
    );
  }

  fetchRecoveryBundle(): Promise<unknown> {
    return Promise.resolve({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      recoveryEnvelope: this.recovery.recoveryEnvelope,
      manifestChain: this.manifests,
      nextAfterManifestVersion: null,
    });
  }

  secureRevokeDevice(deviceId: string, input: SecureDeviceRevocationRequestV1): Promise<unknown> {
    this.committedRequest = input;
    this.currentManifest = input.newManifest;
    this.manifests.push(input.newManifest);
    this.recovery = input.newRecovery;
    if (this.throwAfterRevocationCommit) return Promise.reject(new Error('response lost'));
    return Promise.resolve({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      vaultId: input.newManifest.vaultId,
      revokedDeviceId: deviceId,
      manifestVersion: input.newManifest.manifestVersion,
      keyEpoch: input.newManifest.keyEpoch,
      revoked: true,
    });
  }

  getCurrentDeviceKeyEnvelope(): Promise<unknown> {
    const envelope = this.committedRequest?.deviceKeyEnvelopes.find(
      (candidate) => candidate.recipientDeviceId === this.fixture.setup.device.deviceId,
    );
    return Promise.resolve({ protocolVersion: SYNC_PROTOCOL_VERSION, envelope });
  }

  getDeviceKeyEnvelope(): Promise<unknown> {
    return this.getCurrentDeviceKeyEnvelope();
  }

  deleteVault(input: Parameters<DeviceSecurityApiPort['deleteVault']>[0]): Promise<unknown> {
    this.deletionRequest = input;
    return Promise.resolve({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      vaultId: input.transcript.vaultId,
      deletionRequestId: input.transcript.idempotencyKey,
      state: 'completed',
      deleted: true,
      completedAt: NOW.toISOString(),
    });
  }
}

describe('device security service', () => {
  it('renews a remote device through a fresh signed manifest transition', async () => {
    const fixture = await createFixture();
    const repository = new MemorySecurityRepository(fixture.setup);
    const api = new FakeDeviceSecurityApi(fixture);
    const service = new DeviceSecurityService({ api, repository, origin: ORIGIN, now: () => NOW });

    const next = await service.renewDevice(fixture.remoteDeviceId);

    expect(next.vault.manifest.manifestVersion).toBe(3);
    expect(next.vault.keyEpoch).toBe(1);
    expect(next.vault.manifest.transition).toMatchObject({
      kind: 'renew-device',
      affectedDeviceId: fixture.remoteDeviceId,
    });
    expect(repository.rotatedWrites).toBe(0);
    clearBytes(fixture.recoveryRoot);
  });

  it('resumes a committed rotation after a lost response using only the local recipient envelope', async () => {
    const fixture = await createFixture();
    const repository = new MemorySecurityRepository(fixture.setup);
    const api = new FakeDeviceSecurityApi(fixture);
    api.throwAfterRevocationCommit = true;
    const service = new DeviceSecurityService({ api, repository, origin: ORIGIN, now: () => NOW });

    await expect(
      service.secureRevokeDevice(fixture.remoteDeviceId, fixture.recoveryCode),
    ).rejects.toThrow('response lost');
    expect(repository.setup.vault.keyEpoch).toBe(1);
    expect(
      api.committedRequest?.deviceKeyEnvelopes.map((value) => value.recipientDeviceId),
    ).toEqual([fixture.setup.device.deviceId]);

    const reconciled = await service.reconcileKeyEpoch();
    expect(reconciled.vault.keyEpoch).toBe(2);
    expect(reconciled.vault.manifest.revokedDevices.map((device) => device.deviceId)).toContain(
      fixture.remoteDeviceId,
    );
    expect(reconciled.metadata.pendingKeyRotationSnapshotEpoch).toBe(2);
    expect(repository.rotatedWrites).toBe(1);

    const deviceEnvelope = api.committedRequest?.deviceKeyEnvelopes[0];
    if (!deviceEnvelope) throw new Error('Recipient envelope was not committed.');
    const salt = base64UrlToBytes(deviceEnvelope.ecdhSalt);
    const wrappingKey = await deriveDeviceEnvelopeWrappingKey(
      fixture.localKeys.agreement.privateKey,
      fixture.localKeys.agreement.publicKey,
      salt,
      {
        protocolVersion: deviceEnvelope.protocolVersion,
        suite: deviceEnvelope.suite,
        vaultId: deviceEnvelope.vaultId,
        keyEpoch: deviceEnvelope.keyEpoch,
        senderDeviceId: deviceEnvelope.senderDeviceId,
        recipientDeviceId: deviceEnvelope.recipientDeviceId,
        parentManifestHash: deviceEnvelope.parentManifestHash,
      },
    );
    clearBytes(salt);
    const [fromServerEnvelope, fromLocalStorage] = await Promise.all([
      openEncryptedKeyEnvelope(deviceEnvelope.encryptedKey, wrappingKey),
      openEncryptedKeyEnvelope(
        reconciled.vaultKey.encryptedKey,
        reconciled.device.localWrappingKey,
      ),
    ]);
    expect(bytesToBase64Url(fromLocalStorage)).toBe(bytesToBase64Url(fromServerEnvelope));
    clearBytes(fromServerEnvelope, fromLocalStorage, fixture.recoveryRoot);
  });

  it('requires an exact typed confirmation and recovery signature for cloud deletion', async () => {
    const fixture = await createFixture();
    const repository = new MemorySecurityRepository(fixture.setup);
    const api = new FakeDeviceSecurityApi(fixture);
    const service = new DeviceSecurityService({ api, repository, origin: ORIGIN, now: () => NOW });

    await expect(service.deleteCloudVault(fixture.recoveryCode, 'OBRIŠI')).rejects.toMatchObject({
      code: 'typed-confirmation-mismatch',
    });
    expect(api.deletionRequest).toBeUndefined();

    await service.deleteCloudVault(fixture.recoveryCode, CLOUD_VAULT_DELETE_CONFIRMATION);

    expect(api.deletionRequest?.transcript).toMatchObject({
      type: 'mirna-vault-deletion-v1',
      typedConfirmation: 'DELETE ENCRYPTED CLOUD VAULT',
      vaultId: fixture.setup.vault.vaultId,
    });
    expect(api.deletionRequest?.gateKey).toHaveLength(43);
    expect(api.deletionRequest?.deviceSignature).toHaveLength(86);
    expect(api.deletionRequest?.recoverySignature).toHaveLength(86);
    clearBytes(fixture.recoveryRoot);
  });
});
