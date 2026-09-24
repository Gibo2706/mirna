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
import { createInitialManifest, manifestBodyHash, signVaultManifest } from '@/domain/sync/manifest';
import {
  computeSyncFinanceDataHash,
  createBaselineSnapshotEntityStates,
  createEncryptedSnapshot,
  createSyncFinanceData,
  hashEncryptedSnapshotEnvelope,
  type EncryptedSnapshotArtifactV1,
} from '@/domain/sync/snapshot';
import { emptyFinanceData, tx } from '@/tests/factories';
import type { VaultManifestV1 } from '@/domain/sync/schemas';
import type { FinanceData } from '@/domain/types';
import { SYNC_CRYPTO_SUITE, SYNC_TRANSCRIPT_TYPES } from '@/domain/sync/constants';
import { SyncApiError, type DownloadedSnapshotV1 } from './api';
import { SnapshotSyncService, type SnapshotSyncApiPort } from './snapshot-service';
import { collectVerifiedManifestChain } from './manifest-chain';

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
  history: VaultManifestV1[] = [];

  getManifestChanges(after: number): Promise<unknown> {
    const remaining = this.history.filter((manifest) => manifest.manifestVersion > after);
    const manifests = remaining.slice(0, 25);
    return Promise.resolve({
      protocolVersion: 1,
      manifests,
      nextAfterManifestVersion: remaining.length > 25 ? manifests.at(-1)!.manifestVersion : null,
    });
  }
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

  it('uploads a recovered snapshot after consent was persisted before automatic sync', async () => {
    const name = `mirna-snapshot-recovery-upload-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const database = new FinanceDatabase(name);
    const material = await createSetup();
    material.setup.metadata.bootstrapMode = 'complete';
    material.setup.metadata.firstUploadConsent = 'accepted';
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

    await expect(service.synchronize({ continuousOperations: true })).resolves.toEqual({
      kind: 'uploaded',
      revision: 1,
    });
    expect(api.uploads).toHaveLength(1);
    expect((await repository.readSetup())?.metadata.lastSnapshotRevision).toBe(1);
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

const renewHistory = async (setup: LocalSyncSetup, count = 5): Promise<VaultManifestV1[]> => {
  const history = [setup.vault.manifest];
  for (let version = 2; version <= count; version += 1) {
    const previous = history.at(-1)!;
    const { signature: _signature, ...body } = previous;
    void _signature;
    history.push(
      await signVaultManifest(
        {
          ...body,
          manifestVersion: version,
          previousManifestHash: await manifestBodyHash(previous),
          devices: previous.devices.map((device) => ({
            ...device,
            authorizedAt: new Date(NOW.getTime() + version * 1000).toISOString(),
            authorizationExpiresAt: new Date(
              NOW.getTime() + 30 * 86400000 + version * 1000,
            ).toISOString(),
          })),
          transition: {
            ...previous.transition,
            kind: 'renew-device',
            transitionId: createOpaqueId(),
            occurredAt: new Date(NOW.getTime() + version * 1000).toISOString(),
          },
        },
        setup.device.signingPrivateKey,
      ),
    );
  }
  return history;
};

const historicalFixture = async (parentVersion = 1, count = 5) => {
  const material = await createSetup();
  const history = await renewHistory(material.setup, count);
  const parent = history[parentVersion - 1];
  const remote = await remoteArtifact({
    ...material,
    setup: {
      ...material.setup,
      vault: { ...material.setup.vault, manifest: parent },
      metadata: { ...material.setup.metadata, lastManifestHash: await manifestBodyHash(parent) },
    },
    data: emptyFinanceData(),
    revision: 1,
    previousSnapshotHash: null,
  });
  const current = history.at(-1)!;
  material.setup.vault.manifest = current;
  material.setup.device.authorizationExpiresAt = current.devices[0].authorizationExpiresAt;
  material.setup.metadata.lastManifestHash = await manifestBodyHash(current);
  material.setup.vaultKey.encryptedKey = await createEncryptedKeyEnvelope(
    material.vaultMasterKey,
    material.setup.device.localWrappingKey,
    {
      ...material.setup.vaultKey.encryptedKey.aad,
      parentManifestHash: material.setup.metadata.lastManifestHash,
    },
  );
  const name = `mirna-ancestry-${crypto.randomUUID()}`;
  databaseNames.push(name);
  const database = new FinanceDatabase(name);
  const repository = new SyncSnapshotRepository(database);
  await repository.writeSetup(material.setup);
  await seedFinanceData(database, emptyFinanceData());
  const api = new FakeSnapshotApi(material.setup);
  api.history = history;
  api.remote = remote;
  const service = new SnapshotSyncService({
    api,
    repository,
    origin: 'https://mirna.test',
    now: () => NOW,
  });
  return { ...material, history, database, repository, api, service };
};

describe('historical snapshot manifest ancestry', () => {
  it.each([1, 3])('accepts a signed snapshot under M%i anchored at local M5', async (parent) => {
    const fixture = await historicalFixture(parent);
    await expect(fixture.service.synchronize()).resolves.toEqual({
      kind: 'downloaded',
      revision: 1,
    });
    expect((await fixture.repository.readSetup())?.metadata.syncBlockReason).toBeUndefined();
    fixture.database.close();
    clearBytes(fixture.vaultMasterKey);
  });
});

const markStaleBlock = async (
  fixture: Awaited<ReturnType<typeof historicalFixture>>,
  sameRevision = true,
) => {
  await fixture.database.syncMetadata.update(SYNC_METADATA_RECORD_ID, {
    syncBlockReason: 'fork-detected',
    lastErrorCode: 'SNAPSHOT_MANIFEST_PIN_MISMATCH',
    firstUploadConsent: 'accepted',
    bootstrapMode: 'complete',
    lastServerCursor: 480,
    lastSnapshotServerCursor: 0,
    lastLocalDataHash: await computeSyncFinanceDataHash(emptyFinanceData()),
    ...(sameRevision
      ? {
          lastSnapshotRevision: 1,
          lastSnapshotHash: await hashEncryptedSnapshotEnvelope(fixture.api.remote!.envelope),
          lastSnapshotId: fixture.api.remote!.envelope.snapshotId,
          lastSnapshotContentHash: fixture.api.remote!.snapshotContentHash,
        }
      : {}),
  });
};

const closeFixture = (fixture: Awaited<ReturnType<typeof historicalFixture>>) => {
  fixture.database.close();
  clearBytes(fixture.vaultMasterKey);
};

describe('snapshot ancestry fail-closed and stale block revalidation', () => {
  it('revalidates an already pinned M1 snapshot at M5 without losing dirty local data or operation progress', async () => {
    const f = await historicalFixture();
    await markStaleBlock(f);
    const dirty = tx({
      id: 'pending-local-edit',
      type: 'expense',
      amount: 12345,
      categoryId: 'expense',
    });
    await f.database.transactions.put(dirty);
    await expect(f.service.synchronize({ continuousOperations: true })).resolves.toEqual({
      kind: 'up-to-date',
      revision: 1,
    });
    expect(await f.database.transactions.get(dirty.id)).toEqual(dirty);
    expect((await f.repository.readSetup())?.metadata).toMatchObject({
      lastServerCursor: 480,
      lastSnapshotServerCursor: 0,
      lastSnapshotRevision: 1,
      lastLocalDataHash: await computeSyncFinanceDataHash(emptyFinanceData()),
      syncBlockReason: undefined,
      lastErrorCode: undefined,
    });
    expect(f.api.uploads).toHaveLength(0);
    closeFixture(f);
  });

  it('defers a clean snapshot check timestamp until continuous operation catch-up finishes', async () => {
    const f = await historicalFixture();
    await markStaleBlock(f);
    await expect(f.service.synchronize({ continuousOperations: true })).resolves.toEqual({
      kind: 'up-to-date',
      revision: 1,
    });
    expect((await f.repository.readSetup())?.metadata.lastSuccessfulSyncAt).toBeUndefined();
    closeFixture(f);
  });

  it('uses the existing conflict flow for a dirty local state and a newer verified snapshot', async () => {
    const f = await historicalFixture();
    await markStaleBlock(f, false);
    const dirty = tx({ id: 'local-change', type: 'expense', amount: 3456, categoryId: 'expense' });
    await f.database.transactions.put(dirty);
    await expect(f.service.synchronize()).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'local-remote-conflict',
    });
    expect(await f.database.transactions.get(dirty.id)).toEqual(dirty);
    expect((await f.repository.readSetup())?.metadata.lastSnapshotRevision).toBe(0);
    expect(await f.database.syncConflicts.count()).toBe(1);
    closeFixture(f);
  });

  it.each([
    'body',
    'signature',
    'previous-hash',
    'gap',
    'alternate',
    'unknown-parent',
    'ciphertext',
    'vault',
    'revision',
    'epoch',
    'missing-snapshot',
  ] as const)(
    'keeps an existing block, finance data and pins intact for invalid %s',
    async (attack) => {
      const f = await historicalFixture();
      await markStaleBlock(f);
      const before = (await f.repository.readSetup())!;
      const data = await f.repository.readFinanceData();
      const history = structuredClone(f.history);
      if (attack === 'body') history[2].recoveryLookupId = createOpaqueId();
      if (attack === 'signature') history[2].signature = bytesToBase64Url(randomBytes(64));
      if (attack === 'previous-hash')
        history[3].previousManifestHash = bytesToBase64Url(randomBytes(32));
      if (attack === 'gap') history.splice(2, 1);
      if (attack === 'alternate') {
        const { signature: _signature, ...body } = history[2];
        void _signature;
        history[2] = await signVaultManifest(
          { ...body, transition: { ...body.transition, transitionId: createOpaqueId() } },
          f.setup.device.signingPrivateKey,
        );
      }
      f.api.history = history;
      if (attack === 'unknown-parent')
        f.api.remote!.envelope.parentManifestHash = bytesToBase64Url(randomBytes(32));
      if (attack === 'ciphertext') f.api.remote!.ciphertext[0] ^= 1;
      if (attack === 'vault') f.api.remote!.envelope.vaultId = createOpaqueId();
      if (attack === 'revision') f.api.remote!.envelope.revision = 2;
      if (attack === 'epoch') f.api.remote!.envelope.keyEpoch = 2;
      if (attack === 'missing-snapshot') f.api.remote = undefined;
      await expect(f.service.synchronize({ continuousOperations: true })).resolves.toEqual({
        kind: 'blocked',
        reason: 'fork-detected',
        revision: 1,
      });
      expect((await f.repository.readSetup())?.metadata).toEqual(before.metadata);
      expect((await f.repository.readSetup())?.vault.manifest).toEqual(before.vault.manifest);
      expect(await f.repository.readFinanceData()).toEqual(data);
      closeFixture(f);
    },
  );

  it.each([
    'SNAPSHOT_FORK_DETECTED',
    'SNAPSHOT_VAULT_MISMATCH',
    'SNAPSHOT_CHAIN_GAP',
    'SNAPSHOT_ROLLBACK_DETECTED',
    'SNAPSHOT_INTEGRITY_FAILURE',
    'LOCAL_FINANCE_STATE_MISSING',
  ])('does not revalidate unrelated block %s', async (code) => {
    const f = await historicalFixture();
    await markStaleBlock(f);
    await f.database.syncMetadata.update(SYNC_METADATA_RECORD_ID, { lastErrorCode: code });
    f.api.getCurrentManifest = () => {
      throw new Error('Other blocks must never contact manifest endpoint');
    };
    await expect(f.service.synchronize()).resolves.toMatchObject({ kind: 'blocked' });
    expect((await f.repository.readSetup())?.metadata.lastErrorCode).toBe(code);
    closeFixture(f);
  });

  it('rejects an unknown parent hash for a newer snapshot', async () => {
    const f = await historicalFixture();
    f.api.remote!.envelope.parentManifestHash = bytesToBase64Url(randomBytes(32));
    f.api.remote!.envelope.aad.parentManifestHash = f.api.remote!.envelope.parentManifestHash;
    await expect(f.service.synchronize()).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'fork-detected',
    });
    expect((await f.repository.readSetup())?.metadata.lastErrorCode).toBe(
      'SNAPSHOT_MANIFEST_PIN_MISMATCH',
    );
    closeFixture(f);
  });

  it('verifies all pages of a 28-manifest renewal history', async () => {
    const f = await historicalFixture(1, 28);
    await expect(f.service.synchronize()).resolves.toEqual({ kind: 'downloaded', revision: 1 });
    closeFixture(f);
  });

  it.each([false, true])(
    'advances local M2 to M5 through verified transitions (stale block: %s)',
    async (blocked) => {
      const f = await historicalFixture();
      const local = f.history[1];
      const localHash = await manifestBodyHash(local);
      const setup = {
        ...f.setup,
        vault: { ...f.setup.vault, manifest: local },
        device: {
          ...f.setup.device,
          authorizationExpiresAt: local.devices[0].authorizationExpiresAt,
        },
        metadata: { ...f.setup.metadata, lastManifestHash: localHash },
        vaultKey: {
          ...f.setup.vaultKey,
          encryptedKey: await createEncryptedKeyEnvelope(
            f.vaultMasterKey,
            f.setup.device.localWrappingKey,
            { ...f.setup.vaultKey.encryptedKey.aad, parentManifestHash: localHash },
          ),
        },
      };
      // Set up a fresh device checkpoint at the older authenticated pin.
      await f.database.syncVault.put(setup.vault);
      await f.database.syncDevice.put(setup.device);
      await f.database.syncKeys.put(setup.vaultKey);
      await f.database.syncMetadata.put(setup.metadata);
      if (blocked) await markStaleBlock(f);
      await expect(f.service.synchronize()).resolves.toMatchObject({
        kind: blocked ? 'up-to-date' : 'downloaded',
        revision: 1,
      });
      expect((await f.repository.readSetup())?.metadata.lastManifestHash).toBe(
        await manifestBodyHash(f.history[4]),
      );
      closeFixture(f);
    },
  );
});

it('bounds manifest pagination to 100 pages even for a cryptographically valid longer chain', async () => {
  const material = await createSetup();
  const history = await renewHistory(material.setup, 102);
  let pages = 0;
  await expect(
    collectVerifiedManifestChain({
      getManifestChanges: (after) => {
        pages += 1;

        return Promise.resolve({
          protocolVersion: 1,
          manifests: [history[after]],
          nextAfterManifestVersion: after + 1,
        });
      },
      expected: history.at(-1)!,
      expectedHash: await manifestBodyHash(history.at(-1)!),
    }),
  ).rejects.toMatchObject({ code: 'manifest-gap' });
  expect(pages).toBe(100);
  clearBytes(material.vaultMasterKey);
});

it('keeps the M2 manifest pin when stale-block revalidation of a newer M5 snapshot fails', async () => {
  const f = await historicalFixture();
  const local = f.history[1];
  const hash = await manifestBodyHash(local);
  await f.database.syncVault.put({ ...f.setup.vault, manifest: local });
  await f.database.syncDevice.put({
    ...f.setup.device,
    authorizationExpiresAt: local.devices[0].authorizationExpiresAt,
  });
  await f.database.syncKeys.put({
    ...f.setup.vaultKey,
    encryptedKey: await createEncryptedKeyEnvelope(
      f.vaultMasterKey,
      f.setup.device.localWrappingKey,
      { ...f.setup.vaultKey.encryptedKey.aad, parentManifestHash: hash },
    ),
  });
  await f.database.syncMetadata.update(SYNC_METADATA_RECORD_ID, { lastManifestHash: hash });
  await markStaleBlock(f);
  const before = (await f.repository.readSetup())!;
  f.api.remote!.ciphertext[0] ^= 1;
  await expect(f.service.synchronize()).resolves.toMatchObject({
    kind: 'blocked',
    reason: 'fork-detected',
  });
  const after = (await f.repository.readSetup())!;
  expect(after.metadata).toEqual(before.metadata);
  expect(after.vault.manifest).toEqual(before.vault.manifest);
  expect(after.vaultKey.encryptedKey).toEqual(before.vaultKey.encryptedKey);
  closeFixture(f);
});

it('never clears a different block installed concurrently during ancestry verification', async () => {
  const f = await historicalFixture();
  await markStaleBlock(f);
  const getHistory = f.api.getManifestChanges.bind(f.api);
  f.api.getManifestChanges = async (after) => {
    await f.database.syncMetadata.update(SYNC_METADATA_RECORD_ID, {
      lastErrorCode: 'SNAPSHOT_FORK_DETECTED',
    });
    return getHistory(after);
  };
  await expect(f.service.synchronize({ continuousOperations: true })).resolves.toMatchObject({
    kind: 'blocked',
  });
  expect((await f.repository.readSetup())?.metadata).toMatchObject({
    syncBlockReason: 'fork-detected',
    lastErrorCode: 'SNAPSHOT_FORK_DETECTED',
    lastSnapshotRevision: 1,
  });
  closeFixture(f);
});

it('proves a newer snapshot without accepting its unseen operation frontier before catch-up', async () => {
  const f = await historicalFixture();
  await markStaleBlock(f);
  const before = (await f.repository.readSetup())!;
  const dirty = tx({
    id: 'pending-before-catchup',
    type: 'expense',
    amount: 778,
    categoryId: 'expense',
  });
  await f.database.transactions.put(dirty);
  f.api.remote = await createEncryptedSnapshot({
    data: emptyFinanceData(),
    vaultId: f.setup.vault.vaultId,
    revision: 2,
    baseRevision: 1,
    keyEpoch: 1,
    creatingDeviceId: f.setup.device.deviceId,
    createdAt: NOW.toISOString(),
    parentManifestHash: await manifestBodyHash(f.history[0]),
    previousSnapshotHash: before.metadata.lastSnapshotHash,
    causalFrontier: { serverCursor: 600, devices: [] },
    vaultMasterKey: f.vaultMasterKey,
    signingPrivateKey: f.setup.device.signingPrivateKey,
    compression: 'none',
  });
  await expect(f.service.synchronize({ continuousOperations: true })).resolves.toEqual({
    kind: 'up-to-date',
    revision: 1,
  });
  expect((await f.repository.readSetup())?.metadata).toMatchObject({
    syncBlockReason: undefined,
    lastErrorCode: undefined,
    lastSnapshotHash: before.metadata.lastSnapshotHash,
    lastSnapshotRevision: 1,
    lastServerCursor: 480,
  });
  expect(await f.database.transactions.get(dirty.id)).toEqual(dirty);
  expect(await f.database.syncConflicts.count()).toBe(0);
  closeFixture(f);
});
