import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { SYNC_CRYPTO_SUITE, SYNC_PROTOCOL_VERSION } from '@/domain/sync/constants';
import {
  createEncryptedKeyEnvelope,
  exportPublicEcKey,
  generateDeviceKeyPairs,
  generateLocalWrappingKey,
  generateRecoverySigningKeyPair,
  openEncryptedKeyEnvelope,
  randomBytes,
} from '@/domain/sync/crypto';
import { clearBytes } from '@/domain/sync/encoding';
import { createInitialManifest, manifestBodyHash, signVaultManifest } from '@/domain/sync/manifest';
import { unsignedVaultManifestSchema } from '@/domain/sync/schemas';
import type { Account } from '@/domain/types';
import { FinanceDatabase } from '../database';
import {
  clearLocalSyncState,
  IncompleteLocalSyncSetupError,
  InvalidLocalSyncSetupError,
  readLocalSyncSetup,
  writeLocalSyncSetup,
  writeRotatedLocalSyncSetup,
} from './repository';
import {
  ACTIVE_SYNC_VAULT_RECORD_ID,
  LOCAL_SYNC_DEVICE_RECORD_ID,
  SYNC_METADATA_RECORD_ID,
  localVaultKeyRecordId,
  type LocalSyncSetup,
} from './records';

const databaseNames: string[] = [];

const createDatabase = (): FinanceDatabase => {
  const name = `mirna-sync-repository-${crypto.randomUUID()}`;
  databaseNames.push(name);
  return new FinanceDatabase(name);
};

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)));
});

const createSetup = async (vaultId = 'A'.repeat(22)): Promise<LocalSyncSetup> => {
  const [deviceKeys, localWrappingKey, recoveryKeys] = await Promise.all([
    generateDeviceKeyPairs(),
    generateLocalWrappingKey(),
    generateRecoverySigningKeyPair(),
  ]);
  const deviceId = 'B'.repeat(22);
  const createdAt = '2026-07-31T10:00:00.000Z';
  const authorizationExpiresAt = '2026-08-30T10:00:00.000Z';
  const manifestDevice = {
    deviceId,
    publicKeys: {
      signing: await exportPublicEcKey(deviceKeys.signing.publicKey),
      agreement: await exportPublicEcKey(deviceKeys.agreement.publicKey),
    },
    authorizedAt: createdAt,
    authorizationExpiresAt,
  };
  const manifest = await createInitialManifest({
    vaultId,
    recoveryLookupId: 'H'.repeat(22),
    transitionId: 'I'.repeat(22),
    device: manifestDevice,
    recoverySigningPublicKey: recoveryKeys.publicKey,
    signingPrivateKey: deviceKeys.signing.privateKey,
    createdAt,
  });
  const manifestHash = await manifestBodyHash(manifest);
  const rawVaultMasterKey = randomBytes(32);
  const encryptedKey = await createEncryptedKeyEnvelope(rawVaultMasterKey, localWrappingKey, {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId,
    keyEpoch: 1,
    objectType: 'local-vault-key' as const,
    objectId: 'E'.repeat(22),
    creatingDeviceId: deviceId,
    recoveryLookupId: null,
    parentManifestHash: manifestHash,
  });
  clearBytes(rawVaultMasterKey);

  return {
    vault: {
      id: ACTIVE_SYNC_VAULT_RECORD_ID,
      vaultId,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      cryptoSuite: SYNC_CRYPTO_SUITE,
      keyEpoch: 1,
      status: 'active',
      manifest,
      createdAt,
      updatedAt: createdAt,
    },
    device: {
      id: LOCAL_SYNC_DEVICE_RECORD_ID,
      vaultId,
      deviceId,
      displayName: 'Test uređaj',
      signingPrivateKey: deviceKeys.signing.privateKey,
      signingPublicKey: deviceKeys.signing.publicKey,
      agreementPrivateKey: deviceKeys.agreement.privateKey,
      agreementPublicKey: deviceKeys.agreement.publicKey,
      localWrappingKey,
      authorizationExpiresAt,
      createdAt,
      updatedAt: createdAt,
    },
    vaultKey: {
      id: localVaultKeyRecordId(vaultId, 1),
      vaultId,
      keyEpoch: 1,
      purpose: 'vault-master-key',
      encryptedKey,
      createdAt,
    },
    metadata: {
      id: SYNC_METADATA_RECORD_ID,
      vaultId,
      localSchemaVersion: 1,
      firstUploadConsent: 'pending',
      lastServerCursor: 0,
      lastSnapshotServerCursor: 0,
      lastSnapshotRevision: 0,
      lastSnapshotId: null,
      lastSnapshotHash: null,
      lastSnapshotContentHash: null,
      lastManifestHash: manifestHash,
      lastLocalDataHash: null,
      enabledAt: createdAt,
    },
  };
};

const replaceEnvelopePin = async (setup: LocalSyncSetup): Promise<void> => {
  const rawVaultMasterKey = await openEncryptedKeyEnvelope(
    setup.vaultKey.encryptedKey,
    setup.device.localWrappingKey,
  );
  try {
    setup.vaultKey.encryptedKey = await createEncryptedKeyEnvelope(
      rawVaultMasterKey,
      setup.device.localWrappingKey,
      {
        ...setup.vaultKey.encryptedKey.aad,
        parentManifestHash: await manifestBodyHash(setup.vault.manifest),
      },
    );
  } finally {
    clearBytes(rawVaultMasterKey);
  }
};

describe('local sync repository', () => {
  it('writes and reads a coherent setup atomically with non-extractable secret keys', async () => {
    const database = createDatabase();
    const setup = await createSetup();

    await writeLocalSyncSetup(setup, database);
    database.close();

    const reopened = new FinanceDatabase(database.name);
    const stored = await readLocalSyncSetup(reopened);
    expect(stored?.vault.vaultId).toBe(setup.vault.vaultId);
    expect(stored?.device.signingPrivateKey.extractable).toBe(false);
    expect(stored?.device.agreementPrivateKey.extractable).toBe(false);
    expect(stored?.device.localWrappingKey.extractable).toBe(false);
    await expect(
      crypto.subtle.exportKey('pkcs8', stored!.device.signingPrivateKey),
    ).rejects.toBeDefined();
    await expect(
      crypto.subtle.exportKey('pkcs8', stored!.device.agreementPrivateKey),
    ).rejects.toBeDefined();
    await expect(
      crypto.subtle.exportKey('raw', stored!.device.localWrappingKey),
    ).rejects.toBeDefined();
    reopened.close();
  });

  it('atomically advances one key epoch and retains the prior key only as retired history', async () => {
    const database = createDatabase();
    const setup = await createSetup();
    await writeLocalSyncSetup(setup, database);
    const occurredAt = '2026-07-31T10:05:00.000Z';
    const { signature: _signature, ...currentUnsigned } = setup.vault.manifest;
    void _signature;
    const manifest = await signVaultManifest(
      unsignedVaultManifestSchema.parse({
        ...currentUnsigned,
        manifestVersion: 2,
        keyEpoch: 2,
        previousManifestHash: setup.metadata.lastManifestHash,
        transition: {
          transitionId: 'R'.repeat(22),
          kind: 'rotate-key',
          authorizationKind: 'device',
          authorizingDeviceId: setup.device.deviceId,
          affectedDeviceId: setup.device.deviceId,
          occurredAt,
        },
      }),
      setup.device.signingPrivateKey,
    );
    const manifestHash = await manifestBodyHash(manifest);
    const nextMasterKey = randomBytes(32);
    const nextEncryptedKey = await createEncryptedKeyEnvelope(
      nextMasterKey,
      setup.device.localWrappingKey,
      {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        suite: SYNC_CRYPTO_SUITE,
        vaultId: setup.vault.vaultId,
        keyEpoch: 2,
        objectType: 'local-vault-key',
        objectId: 'S'.repeat(22),
        creatingDeviceId: setup.device.deviceId,
        recoveryLookupId: null,
        parentManifestHash: manifestHash,
      },
    );
    clearBytes(nextMasterKey);
    const rotated: LocalSyncSetup = {
      ...setup,
      vault: { ...setup.vault, keyEpoch: 2, manifest, updatedAt: occurredAt },
      vaultKey: {
        id: localVaultKeyRecordId(setup.vault.vaultId, 2),
        vaultId: setup.vault.vaultId,
        keyEpoch: 2,
        purpose: 'vault-master-key',
        encryptedKey: nextEncryptedKey,
        createdAt: occurredAt,
      },
      metadata: {
        ...setup.metadata,
        lastManifestHash: manifestHash,
        pendingKeyRotationSnapshotEpoch: 2,
      },
    };

    await writeRotatedLocalSyncSetup(rotated, database);

    expect((await readLocalSyncSetup(database))?.vault.keyEpoch).toBe(2);
    const keys = (await database.syncKeys.toArray()).sort(
      (left, right) => left.keyEpoch - right.keyEpoch,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0].retiredAt).toBe(occurredAt);
    expect(keys[1].retiredAt).toBeUndefined();
    await expect(writeRotatedLocalSyncSetup(rotated, database)).rejects.toBeInstanceOf(
      InvalidLocalSyncSetupError,
    );
    database.close();
  });

  it('rejects extractable private keys before writing any setup record', async () => {
    const database = createDatabase();
    const setup = await createSetup();
    const extractableSigning = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    setup.device.signingPrivateKey = extractableSigning.privateKey;

    await expect(writeLocalSyncSetup(setup, database)).rejects.toBeInstanceOf(
      InvalidLocalSyncSetupError,
    );
    expect(await database.syncVault.count()).toBe(0);
    expect(await database.syncDevice.count()).toBe(0);
    expect(await database.syncKeys.count()).toBe(0);
    expect(await database.syncMetadata.count()).toBe(0);
    database.close();
  });

  it('rolls back a setup write when another vault is already enabled', async () => {
    const database = createDatabase();
    const original = await createSetup('J'.repeat(22));
    const replacement = await createSetup('K'.repeat(22));
    await writeLocalSyncSetup(original, database);

    await expect(writeLocalSyncSetup(replacement, database)).rejects.toBeInstanceOf(
      InvalidLocalSyncSetupError,
    );

    const stored = await readLocalSyncSetup(database);
    expect(stored?.vault.vaultId).toBe(original.vault.vaultId);
    expect(await database.syncVault.count()).toBe(1);
    expect(await database.syncDevice.count()).toBe(1);
    expect(await database.syncKeys.count()).toBe(1);
    expect(await database.syncMetadata.count()).toBe(1);
    database.close();
  });

  it('detects partial setup instead of silently accepting corrupt local state', async () => {
    const database = createDatabase();
    const setup = await createSetup();
    await database.syncVault.put(setup.vault);

    await expect(readLocalSyncSetup(database)).rejects.toBeInstanceOf(
      IncompleteLocalSyncSetupError,
    );
    database.close();
  });

  it('fails closed when the stored manifest body or signature is changed', async () => {
    const database = createDatabase();
    const setup = await createSetup();
    await writeLocalSyncSetup(setup, database);

    const changedBody = structuredClone(setup.vault);
    changedBody.manifest.transition.occurredAt = '2026-07-31T10:00:00.001Z';
    await database.syncVault.put(changedBody);
    await expect(readLocalSyncSetup(database)).rejects.toBeInstanceOf(InvalidLocalSyncSetupError);

    const changedSignature = structuredClone(setup.vault);
    const firstCharacter = changedSignature.manifest.signature[0];
    changedSignature.manifest.signature = `${firstCharacter === 'A' ? 'B' : 'A'}${changedSignature.manifest.signature.slice(1)}`;
    await database.syncVault.put(changedSignature);
    await expect(readLocalSyncSetup(database)).rejects.toBeInstanceOf(InvalidLocalSyncSetupError);

    await database.syncVault.put(setup.vault);
    const tamperedCiphertext = structuredClone(setup.vaultKey);
    const ciphertextFirstCharacter = tamperedCiphertext.encryptedKey.ciphertext[0];
    tamperedCiphertext.encryptedKey.ciphertext = `${ciphertextFirstCharacter === 'A' ? 'B' : 'A'}${tamperedCiphertext.encryptedKey.ciphertext.slice(1)}`;
    await database.syncKeys.put(tamperedCiphertext);
    await expect(readLocalSyncSetup(database)).rejects.toBeInstanceOf(InvalidLocalSyncSetupError);
    database.close();
  });

  it('rejects a syntactically shaped public key that is not a valid P-256 point', async () => {
    const database = createDatabase();
    const setup = await createSetup();
    setup.vault.manifest.devices[0].publicKeys.signing.value = 'A'.repeat(87);
    await replaceEnvelopePin(setup);
    await Promise.all([
      database.syncVault.put(setup.vault),
      database.syncDevice.put(setup.device),
      database.syncKeys.put(setup.vaultKey),
      database.syncMetadata.put(setup.metadata),
    ]);

    await expect(readLocalSyncSetup(database)).rejects.toBeInstanceOf(InvalidLocalSyncSetupError);
    database.close();
  });

  it('rejects a changed manifest pin even when every record remains schema-valid', async () => {
    const database = createDatabase();
    const setup = await createSetup();
    await writeLocalSyncSetup(setup, database);
    const storedKey = structuredClone(setup.vaultKey);
    storedKey.encryptedKey.aad.parentManifestHash = 'Z'.repeat(43);
    await database.syncKeys.put(storedKey);

    await expect(readLocalSyncSetup(database)).rejects.toBeInstanceOf(InvalidLocalSyncSetupError);
    database.close();
  });

  it('rejects schema-shaped CryptoKeys with the wrong algorithm and strict-record extras', async () => {
    const database = createDatabase();
    const setup = await createSetup();
    setup.device.signingPrivateKey = setup.device.agreementPrivateKey;
    await Promise.all([
      database.syncVault.put(setup.vault),
      database.syncDevice.put(setup.device),
      database.syncKeys.put(setup.vaultKey),
      database.syncMetadata.put(setup.metadata),
    ]);
    await expect(readLocalSyncSetup(database)).rejects.toBeInstanceOf(InvalidLocalSyncSetupError);

    const validSetup = await createSetup();
    await database.syncDevice.clear();
    await database.syncMetadata.put({
      ...validSetup.metadata,
      unexpected: 'corrupt',
    } as typeof validSetup.metadata);
    await database.syncVault.put(validSetup.vault);
    await database.syncDevice.put(validSetup.device);
    await database.syncKeys.put(validSetup.vaultKey);
    await expect(readLocalSyncSetup(database)).rejects.toBeInstanceOf(InvalidLocalSyncSetupError);
    database.close();
  });

  it('strictly parses setup records before writing them', async () => {
    const database = createDatabase();
    const setup = await createSetup();
    const malformed = {
      ...setup,
      metadata: { ...setup.metadata, unexpected: 'must-not-be-stored' },
    } as LocalSyncSetup;

    await expect(writeLocalSyncSetup(malformed, database)).rejects.toBeInstanceOf(
      InvalidLocalSyncSetupError,
    );
    expect(await database.syncVault.count()).toBe(0);
    expect(await database.syncDevice.count()).toBe(0);
    expect(await database.syncKeys.count()).toBe(0);
    expect(await database.syncMetadata.count()).toBe(0);
    database.close();
  });

  it('clears every sync store atomically without touching financial tables', async () => {
    const database = createDatabase();
    const setup = await createSetup();
    await writeLocalSyncSetup(setup, database);
    const account: Account = {
      id: 'checking',
      name: 'Tekući',
      kind: 'checking',
      openingBalance: 12_000,
      protected: false,
      color: '#000000',
      archived: false,
      createdAt: '2026-07-31T10:00:00.000Z',
    };
    await database.accounts.add(account);
    await Promise.all([
      database.syncOutbox.add({
        id: 'outbox-1',
        vaultId: setup.vault.vaultId,
        operationId: 'operation-1',
        deviceId: setup.device.deviceId,
        deviceSequence: 1,
        keyEpoch: 1,
        mutationGroupId: 'G'.repeat(22),
        mutationGroupIndex: 0,
        mutationGroupSize: 1,
        state: 'intent',
        entityType: 'transaction',
        entityId: 'transaction-1',
        command: 'transaction.upsert',
        canonicalPayload: '{}',
        attemptCount: 0,
        createdAt: setup.vault.createdAt,
        updatedAt: setup.vault.updatedAt,
      }),
      database.syncInbox.add({
        id: 'inbox-1',
        vaultId: setup.vault.vaultId,
        operationId: 'operation-2',
        serverCursor: 1,
        state: 'received',
        encryptedEnvelope: 'ciphertext',
        receivedAt: setup.vault.createdAt,
      }),
      database.syncConflicts.add({
        id: 'conflict-1',
        vaultId: setup.vault.vaultId,
        entityType: 'transaction',
        entityId: 'transaction-1',
        localOperationId: 'operation-1',
        remoteOperationId: 'operation-2',
        localCanonicalProposal: '{}',
        remoteCanonicalProposal: '{}',
        causalMetadata: '{}',
        resolutionState: 'pending',
        detectedAt: setup.vault.createdAt,
      }),
      database.syncEntityStates.add({
        id: `${setup.vault.vaultId}:transaction:transaction-1`,
        vaultId: setup.vault.vaultId,
        entityType: 'transaction',
        entityId: 'transaction-1',
        entityVersion: 1,
        stateHash: 'H'.repeat(43),
        tombstone: false,
        canonicalTombstone: undefined,
        lastOperationId: null,
        lastDeviceId: null,
        lastDeviceSequence: 0,
        lastLamportTime: 0,
        updatedAt: setup.vault.updatedAt,
      }),
      database.syncFrontier.add({
        id: `${setup.vault.vaultId}:${setup.device.deviceId}`,
        vaultId: setup.vault.vaultId,
        deviceId: setup.device.deviceId,
        lastDeviceSequence: 0,
        lastOperationHash: null,
        acknowledgedServerCursor: 0,
        updatedAt: setup.vault.updatedAt,
      }),
    ]);

    await clearLocalSyncState(database);

    expect(
      await Promise.all([
        database.syncVault.count(),
        database.syncDevice.count(),
        database.syncKeys.count(),
        database.syncOutbox.count(),
        database.syncInbox.count(),
        database.syncConflicts.count(),
        database.syncFrontier.count(),
        database.syncMetadata.count(),
      ]),
    ).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(await database.accounts.get(account.id)).toEqual(account);
    database.close();
  });
});
