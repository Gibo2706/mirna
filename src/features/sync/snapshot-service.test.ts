import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { financeTables, FinanceDatabase } from '@/db/database';
import { SyncSnapshotRepository } from '@/db/sync/snapshot-repository';
import {
  ACTIVE_SYNC_VAULT_RECORD_ID,
  LOCAL_SYNC_DEVICE_RECORD_ID,
  SYNC_CHECKPOINT_RECORD_ID,
  SYNC_METADATA_RECORD_ID,
  localVaultKeyRecordId,
  type LocalSyncSetup,
} from '@/db/sync/records';
import {
  createEncryptedKeyEnvelope,
  createOpaqueId,
  exportPublicEcKey,
  generateDeviceKeyPairs,
  generateLocalWrappingKey,
  generateRecoverySigningKeyPair,
  randomBytes,
} from '@/domain/sync/crypto';
import { bytesToBase64Url, clearBytes } from '@/domain/sync/encoding';
import { createInitialManifest, manifestBodyHash } from '@/domain/sync/manifest';
import {
  createBaselineSnapshotEntityStates,
  createEncryptedSnapshot,
  createSyncFinanceData,
  hashEncryptedSnapshotEnvelope,
  type EncryptedSnapshotArtifactV1,
} from '@/domain/sync/snapshot';
import { emptyFinanceData, tx } from '@/tests/factories';
import type { FinanceData } from '@/domain/types';
import { SYNC_CRYPTO_SUITE, SYNC_TRANSCRIPT_TYPES } from '@/domain/sync/constants';
import { SyncApiError, type DownloadedSnapshotV1 } from './api';
import { SnapshotSyncService, type SnapshotSyncApiPort } from './snapshot-service';

const NOW = new Date('2026-07-31T12:00:00.000Z');
const databaseNames: string[] = [];

const seedFinanceData = async (database: FinanceDatabase, data: FinanceData): Promise<void> => {
  await database.transaction('rw', financeTables(database), async () => {
    await Promise.all([
      database.accounts.bulkPut(data.accounts),
      database.transactions.bulkPut(data.transactions),
      database.categories.bulkPut(data.categories),
      database.plannedIncomes.bulkPut(data.plannedIncomes),
      database.commitments.bulkPut(data.commitments),
      database.variableBudgets.bulkPut(data.variableBudgets),
      database.goals.bulkPut(data.goals),
      database.debts.bulkPut(data.debts),
      database.debtPayments.bulkPut(data.debtPayments),
      database.plannedEvents.bulkPut(data.plannedEvents),
      database.presets.bulkPut(data.presets),
      database.salaryScenarios.bulkPut(data.salaryScenarios),
      database.settings.bulkPut(data.settings),
    ]);
  });
};

const createSetup = async (): Promise<{ setup: LocalSyncSetup; vaultMasterKey: Uint8Array }> => {
  const vaultId = createOpaqueId();
  const deviceId = createOpaqueId();
  const deviceKeys = await generateDeviceKeyPairs();
  const recoveryKeys = await generateRecoverySigningKeyPair();
  const localWrappingKey = await generateLocalWrappingKey();
  const authorizedAt = NOW.toISOString();
  const authorizationExpiresAt = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString();
  const manifest = await createInitialManifest({
    vaultId,
    recoveryLookupId: createOpaqueId(),
    transitionId: createOpaqueId(),
    device: {
      deviceId,
      publicKeys: {
        signing: await exportPublicEcKey(deviceKeys.signing.publicKey),
        agreement: await exportPublicEcKey(deviceKeys.agreement.publicKey),
      },
      authorizedAt,
      authorizationExpiresAt,
    },
    recoverySigningPublicKey: recoveryKeys.publicKey,
    signingPrivateKey: deviceKeys.signing.privateKey,
    createdAt: authorizedAt,
  });
  const manifestHash = await manifestBodyHash(manifest);
  const vaultMasterKey = randomBytes(32);
  const encryptedKey = await createEncryptedKeyEnvelope(vaultMasterKey, localWrappingKey, {
    protocolVersion: 1,
    suite: SYNC_CRYPTO_SUITE,
    vaultId,
    keyEpoch: 1,
    objectType: 'local-vault-key',
    objectId: createOpaqueId(),
    creatingDeviceId: deviceId,
    recoveryLookupId: null,
    parentManifestHash: manifestHash,
  });
  return {
    vaultMasterKey,
    setup: {
      vault: {
        id: ACTIVE_SYNC_VAULT_RECORD_ID,
        vaultId,
        protocolVersion: 1,
        cryptoSuite: SYNC_CRYPTO_SUITE,
        keyEpoch: 1,
        status: 'active',
        manifest,
        createdAt: authorizedAt,
        updatedAt: authorizedAt,
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
        createdAt: authorizedAt,
        updatedAt: authorizedAt,
      },
      vaultKey: {
        id: localVaultKeyRecordId(vaultId, 1),
        vaultId,
        keyEpoch: 1,
        purpose: 'vault-master-key',
        encryptedKey,
        createdAt: authorizedAt,
      },
      metadata: {
        id: SYNC_METADATA_RECORD_ID,
        vaultId,
        localSchemaVersion: 1,
        bootstrapMode: 'creator-upload',
        firstUploadConsent: 'pending',
        lastServerCursor: 0,
        lastSnapshotServerCursor: 0,
        lastSnapshotRevision: 0,
        lastSnapshotId: null,
        lastSnapshotHash: null,
        lastSnapshotContentHash: null,
        lastManifestHash: manifestHash,
        lastLocalDataHash: null,
        enabledAt: authorizedAt,
      },
    },
  };
};

class FakeSnapshotApi implements SnapshotSyncApiPort {
  remote?: EncryptedSnapshotArtifactV1;
  uploadError?: Error;
  readonly uploads: EncryptedSnapshotArtifactV1[] = [];

  constructor(private readonly setup: LocalSyncSetup) {}

  requestAuthChallenge(): Promise<unknown> {
    return Promise.resolve({
      type: SYNC_TRANSCRIPT_TYPES.authChallenge,
      protocolVersion: 1,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: this.setup.vault.vaultId,
      deviceId: this.setup.device.deviceId,
      challengeId: createOpaqueId(),
      challenge: bytesToBase64Url(randomBytes(32)),
      issuedAt: new Date(NOW.getTime() - 1_000).toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      audience: '/v1/auth/session',
      origin: 'https://mirna.test',
      method: 'POST',
    });
  }

  createSession(): Promise<unknown> {
    return Promise.resolve({});
  }

  getCurrentManifest(): Promise<unknown> {
    return Promise.resolve(this.setup.vault.manifest);
  }

  async uploadSnapshot(artifact: EncryptedSnapshotArtifactV1): Promise<unknown> {
    if (this.uploadError) throw this.uploadError;
    const stored = {
      envelope: structuredClone(artifact.envelope),
      ciphertext: artifact.ciphertext.slice(),
      snapshotContentHash: artifact.snapshotContentHash,
    };
    this.uploads.push(stored);
    this.remote = stored;
    return {
      protocolVersion: 1,
      snapshotId: artifact.envelope.snapshotId,
      revision: artifact.envelope.revision,
      snapshotHash: await hashEncryptedSnapshotEnvelope(artifact.envelope),
      committed: true,
    };
  }

  downloadCurrentSnapshot(): Promise<DownloadedSnapshotV1> {
    if (!this.remote) {
      return Promise.reject(
        new SyncApiError('SNAPSHOT_NOT_FOUND', 404, '00000000-0000-4000-8000-000000000001'),
      );
    }
    return Promise.resolve({
      envelope: structuredClone(this.remote.envelope),
      ciphertext: this.remote.ciphertext.slice(),
    });
  }

  clearSession(): void {}
}

const remoteArtifact = async (input: {
  setup: LocalSyncSetup;
  vaultMasterKey: Uint8Array;
  data: FinanceData;
  revision: number;
  previousSnapshotHash: string | null;
}): Promise<EncryptedSnapshotArtifactV1> =>
  createEncryptedSnapshot({
    data: input.data,
    vaultId: input.setup.vault.vaultId,
    revision: input.revision,
    baseRevision: input.revision - 1,
    keyEpoch: input.setup.vault.keyEpoch,
    creatingDeviceId: input.setup.device.deviceId,
    createdAt: NOW.toISOString(),
    parentManifestHash: input.setup.metadata.lastManifestHash,
    previousSnapshotHash: input.previousSnapshotHash,
    causalFrontier: { serverCursor: 0, devices: [] },
    vaultMasterKey: input.vaultMasterKey,
    signingPrivateKey: input.setup.device.signingPrivateKey,
    compression: 'none',
  });

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)));
});

describe('Phase 2 snapshot sync service', () => {
  it('requires explicit first-upload consent and pins the exact committed snapshot', async () => {
    const name = `mirna-snapshot-upload-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const database = new FinanceDatabase(name);
    const material = await createSetup();
    const repository = new SyncSnapshotRepository(database);
    await repository.writeSetup(material.setup);
    await seedFinanceData(database, emptyFinanceData());
    const api = new FakeSnapshotApi(material.setup);
    const service = new SnapshotSyncService({
      api,
      origin: 'https://mirna.test',
      repository,
      now: () => NOW,
    });

    const [backgroundResult, consentResult] = await Promise.all([
      service.synchronize(),
      service.synchronize({ allowInitialUpload: true }),
    ]);
    expect(backgroundResult).toEqual({ kind: 'awaiting-upload-consent', revision: 0 });
    expect(consentResult).toEqual({ kind: 'uploaded', revision: 1 });
    const setup = await repository.readSetup();
    expect(setup?.metadata).toMatchObject({
      bootstrapMode: 'complete',
      firstUploadConsent: 'accepted',
      lastSnapshotRevision: 1,
      lastSnapshotId: api.uploads[0].envelope.snapshotId,
      lastSnapshotContentHash: api.uploads[0].snapshotContentHash,
    });
    expect(setup?.metadata.lastSnapshotHash).toBe(
      await hashEncryptedSnapshotEnvelope(api.uploads[0].envelope),
    );
    expect(new TextDecoder().decode(api.uploads[0].ciphertext)).not.toContain('Tekući');
    const expectedStates = await createBaselineSnapshotEntityStates(
      createSyncFinanceData(emptyFinanceData()),
    );
    expect(
      await database.syncEntityStates.where('vaultId').equals(material.setup.vault.vaultId).count(),
    ).toBe(expectedStates.length);
    clearBytes(material.vaultMasterKey);
    database.close();
  });

  it('keeps operation sync available when compaction awaits active-device ACKs', async () => {
    const name = `mirna-snapshot-ack-gate-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const database = new FinanceDatabase(name);
    const material = await createSetup();
    const repository = new SyncSnapshotRepository(database);
    await repository.writeSetup(material.setup);
    await seedFinanceData(database, emptyFinanceData());
    const api = new FakeSnapshotApi(material.setup);
    const service = new SnapshotSyncService({
      api,
      origin: 'https://mirna.test',
      repository,
      now: () => NOW,
    });
    await expect(
      service.synchronize({ allowInitialUpload: true, continuousOperations: true }),
    ).resolves.toEqual({ kind: 'uploaded', revision: 1 });
    api.uploadError = new SyncApiError('SNAPSHOT_ACK_PENDING', 409, createOpaqueId());

    await expect(service.synchronize({ forceCompaction: true })).resolves.toEqual({
      kind: 'up-to-date',
      revision: 1,
    });
    expect((await repository.readSetup())?.metadata).toMatchObject({
      lastSnapshotRevision: 1,
      syncBlockReason: undefined,
      lastErrorCode: undefined,
    });
    clearBytes(material.vaultMasterKey);
    database.close();
  });

  it('checkpoints and atomically applies a verified remote snapshot, then blocks dirty conflicts', async () => {
    const name = `mirna-snapshot-download-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const database = new FinanceDatabase(name);
    const material = await createSetup();
    const repository = new SyncSnapshotRepository(database);
    await repository.writeSetup(material.setup);
    const local = emptyFinanceData();
    await seedFinanceData(database, local);
    const remoteData = emptyFinanceData();
    remoteData.transactions.push(
      tx({ id: 'remote-income', type: 'income', amount: 12_345, categoryId: 'income' }),
    );
    const api = new FakeSnapshotApi(material.setup);
    api.remote = await remoteArtifact({
      setup: material.setup,
      vaultMasterKey: material.vaultMasterKey,
      data: remoteData,
      revision: 1,
      previousSnapshotHash: null,
    });
    const service = new SnapshotSyncService({
      api,
      origin: 'https://mirna.test',
      repository,
      now: () => NOW,
    });

    await expect(service.synchronize()).resolves.toEqual({ kind: 'downloaded', revision: 1 });
    expect(await database.transactions.get('remote-income')).toMatchObject({ amount: 12_345 });
    expect(await database.syncCheckpoints.get(SYNC_CHECKPOINT_RECORD_ID)).toMatchObject({
      replacedSnapshotRevision: 0,
      data: { transactions: [] },
    });
    const afterDownload = (await repository.readSetup())!;
    await database.transactions.add(
      tx({ id: 'local-dirty', type: 'expense', amount: 100, categoryId: 'expense' }),
    );
    const secondRemote = emptyFinanceData();
    secondRemote.transactions.push(
      tx({ id: 'remote-second', type: 'income', amount: 2_000, categoryId: 'income' }),
    );
    api.remote = await remoteArtifact({
      setup: afterDownload,
      vaultMasterKey: material.vaultMasterKey,
      data: secondRemote,
      revision: 2,
      previousSnapshotHash: afterDownload.metadata.lastSnapshotHash,
    });

    await expect(service.synchronize()).resolves.toEqual({
      kind: 'blocked',
      revision: 1,
      reason: 'local-remote-conflict',
    });
    expect(await database.transactions.get('local-dirty')).toBeDefined();
    expect(await database.transactions.get('remote-second')).toBeUndefined();
    expect(await database.syncConflicts.count()).toBe(1);
    expect((await repository.readSetup())?.metadata.syncBlockReason).toBe('local-remote-conflict');
    clearBytes(material.vaultMasterKey);
    database.close();
  });

  it('bootstraps an empty pre-onboarding device only from the exact pairing snapshot pin', async () => {
    const name = `mirna-snapshot-bootstrap-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const database = new FinanceDatabase(name);
    const material = await createSetup();
    const remoteData = emptyFinanceData();
    remoteData.transactions.push(
      tx({ id: 'paired-income', type: 'income', amount: 8_765, categoryId: 'income' }),
    );
    const api = new FakeSnapshotApi(material.setup);
    api.remote = await remoteArtifact({
      setup: material.setup,
      vaultMasterKey: material.vaultMasterKey,
      data: remoteData,
      revision: 1,
      previousSnapshotHash: null,
    });
    material.setup.metadata.lastSnapshotId = api.remote.envelope.snapshotId;
    const repository = new SyncSnapshotRepository(database);
    await repository.writeSetup(material.setup);
    const service = new SnapshotSyncService({
      api,
      origin: 'https://mirna.test',
      repository,
      now: () => NOW,
    });

    await expect(service.synchronize()).resolves.toEqual({ kind: 'downloaded', revision: 1 });
    expect(await database.transactions.get('paired-income')).toMatchObject({ amount: 8_765 });
    expect(await database.settings.get('settings')).toMatchObject({
      appearance: 'system',
      installHintDismissed: false,
    });
    expect(await database.syncCheckpoints.get(SYNC_CHECKPOINT_RECORD_ID)).toBeUndefined();
    clearBytes(material.vaultMasterKey);
    database.close();
  });
});
