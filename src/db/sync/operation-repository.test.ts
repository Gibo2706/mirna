import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { SYNC_CRYPTO_SUITE } from '@/domain/sync/constants';
import { canonicalizeJson } from '@/domain/sync/canonical';
import {
  createEncryptedKeyEnvelope,
  createOpaqueId,
  exportPublicEcKey,
  generateDeviceKeyPairs,
  generateLocalWrappingKey,
  generateRecoverySigningKeyPair,
  openEncryptedKeyEnvelope,
  randomBytes,
} from '@/domain/sync/crypto';
import { bytesToBase64Url, clearBytes } from '@/domain/sync/encoding';
import { createInitialManifest, manifestBodyHash } from '@/domain/sync/manifest';
import { hashSyncOperation, openEncryptedOperation } from '@/domain/sync/operation';
import type { Account, AppSettings } from '@/domain/types';
import { FinanceDatabase } from '../database';
import { auditedFinanceTransaction } from './mutation-audit';
import { SyncOperationRepository } from './operation-repository';
import { SyncConflictRepository } from './conflict-repository';
import { SyncSnapshotRepository } from './snapshot-repository';
import { OperationSyncService, type OperationSyncApiPort } from '@/features/sync/operation-service';
import type { OperationChangesResponseV1, OperationEnvelopeV1 } from '@/domain/sync/operation';
import type { AuthChallengeV1 } from '@/domain/sync/schemas';
import {
  ACTIVE_SYNC_VAULT_RECORD_ID,
  LOCAL_SYNC_DEVICE_RECORD_ID,
  SYNC_METADATA_RECORD_ID,
  localVaultKeyRecordId,
  type LocalSyncSetup,
} from './records';
import { writeLocalSyncSetup } from './repository';

const NOW = new Date('2026-07-31T12:00:00.000Z');
const databaseNames: string[] = [];

const createDatabase = (): FinanceDatabase => {
  const name = `mirna-operation-repository-${crypto.randomUUID()}`;
  databaseNames.push(name);
  return new FinanceDatabase(name);
};

const createSetup = async (): Promise<{ setup: LocalSyncSetup; vaultMasterKey: Uint8Array }> => {
  const vaultId = createOpaqueId();
  const deviceId = createOpaqueId();
  const [deviceKeys, recoveryKeys, localWrappingKey] = await Promise.all([
    generateDeviceKeyPairs(),
    generateRecoverySigningKeyPair(),
    generateLocalWrappingKey(),
  ]);
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
        firstUploadConsent: 'accepted',
        lastServerCursor: 0,
        lastSnapshotServerCursor: 0,
        lastSnapshotRevision: 0,
        lastSnapshotId: null,
        lastSnapshotHash: null,
        lastSnapshotContentHash: null,
        lastManifestHash: manifestHash,
        lastLocalDataHash: null,
        enabledAt: authorizedAt,
        bootstrapMode: 'complete',
      },
    },
  };
};

const originalAccount: Account = {
  id: 'account-1',
  name: 'Pre izmene',
  kind: 'checking',
  openingBalance: 10_000,
  protected: false,
  color: '#123456',
  archived: false,
  createdAt: NOW.toISOString(),
};

const settings: AppSettings = {
  id: 'settings',
  onboardingCompleted: true,
  baseMonthlyIncome: 100_000,
  currency: 'RSD',
  locale: 'sr-Latn-RS',
  appearance: 'system',
  installHintDismissed: false,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)));
});

describe('local encrypted operation preparation', () => {
  it('allocates a signed sequence and entity precondition without changing the operation on retry', async () => {
    const database = createDatabase();
    const { setup, vaultMasterKey } = await createSetup();
    await writeLocalSyncSetup(setup, database);
    await Promise.all([database.accounts.put(originalAccount), database.settings.put(settings)]);
    const changed = { ...originalAccount, name: 'Posle izmene' };
    await auditedFinanceTransaction(
      [database.accounts],
      async (audit) => {
        await database.accounts.put(changed);
        await audit.upsert('account', originalAccount, changed);
      },
      database,
      () => NOW,
    );

    const repository = new SyncOperationRepository(database, () => NOW);
    const prepared = await repository.prepareNextGroup(setup, vaultMasterKey);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({ state: 'encrypted', deviceSequence: 1, attemptCount: 0 });
    const envelope = repository.envelopes(prepared)[0];
    const operation = await openEncryptedOperation({
      envelope,
      vaultMasterKey,
      signingPublicKey: setup.device.signingPublicKey,
      expected: {
        vaultId: setup.vault.vaultId,
        keyEpoch: 1,
        deviceId: setup.device.deviceId,
      },
    });
    expect(operation.command).toMatchObject({
      type: 'account.upsert',
      entityId: changed.id,
      precondition: { entityVersion: 1, tombstone: false },
      result: { entityVersion: 2, tombstone: false },
      value: changed,
    });
    expect(
      await database.syncEntityStates.get(`${setup.vault.vaultId}:account:${changed.id}`),
    ).toMatchObject({ entityVersion: 2, lastOperationId: operation.operationId });
    expect(
      await database.syncFrontier.get(`${setup.vault.vaultId}:${setup.device.deviceId}`),
    ).toMatchObject({
      lastDeviceSequence: 1,
      lastOperationHash: await hashSyncOperation(operation),
    });

    const retried = await repository.prepareNextGroup(setup, vaultMasterKey);
    expect(retried[0]?.encryptedEnvelope).toBe(prepared[0]?.encryptedEnvelope);
    await repository.recordAcceptedLocal(setup, prepared[0], 7, await hashSyncOperation(operation));
    expect(await database.syncOutbox.count()).toBe(0);
    expect(await database.syncInbox.get(operation.operationId)).toMatchObject({
      serverCursor: 7,
      state: 'applied',
      operationHash: await hashSyncOperation(operation),
    });
    clearBytes(vaultMasterKey);
    database.close();
  });

  it('chains every member of one compound mutation group and rolls preparation back on signing failure', async () => {
    const database = createDatabase();
    const { setup, vaultMasterKey } = await createSetup();
    await writeLocalSyncSetup(setup, database);
    await Promise.all([database.accounts.put(originalAccount), database.settings.put(settings)]);
    const changedAccount = { ...originalAccount, archived: true };
    const changedSettings = { ...settings, baseMonthlyIncome: 101_000 };
    await auditedFinanceTransaction(
      [database.accounts, database.settings],
      async (audit) => {
        await database.accounts.put(changedAccount);
        await audit.upsert('account', originalAccount, changedAccount);
        await database.settings.put(changedSettings);
        await audit.upsert('settings', settings, changedSettings);
      },
      database,
      () => NOW,
    );
    const repository = new SyncOperationRepository(database, () => NOW);
    const invalidSetup: LocalSyncSetup = {
      ...setup,
      device: { ...setup.device, signingPrivateKey: setup.device.signingPublicKey },
    };
    await expect(repository.prepareNextGroup(invalidSetup, vaultMasterKey)).rejects.toBeDefined();
    expect((await database.syncOutbox.toArray()).every((record) => record.state === 'intent')).toBe(
      true,
    );
    expect(await database.syncEntityStates.count()).toBe(0);
    expect(await database.syncFrontier.count()).toBe(0);

    const prepared = await repository.prepareNextGroup(setup, vaultMasterKey);
    expect(prepared).toHaveLength(2);
    expect(prepared.map((record) => record.deviceSequence)).toEqual([1, 2]);
    expect(new Set(prepared.map((record) => record.mutationGroupId)).size).toBe(1);
    const [first, second] = await Promise.all(
      repository.envelopes(prepared).map((envelope) =>
        openEncryptedOperation({
          envelope,
          vaultMasterKey,
          signingPublicKey: setup.device.signingPublicKey,
          expected: { vaultId: setup.vault.vaultId, keyEpoch: 1, deviceId: setup.device.deviceId },
        }),
      ),
    );
    expect(second.previousOperationHash).toBe(await hashSyncOperation(first));
    expect(second.causalFrontier).toContainEqual({
      deviceId: setup.device.deviceId,
      deviceSequence: 1,
      operationHash: await hashSyncOperation(first),
    });
    clearBytes(vaultMasterKey);
    database.close();
  });

  it('can reopen the persisted VMK used by operation preparation', async () => {
    const database = createDatabase();
    const { setup, vaultMasterKey } = await createSetup();
    await writeLocalSyncSetup(setup, database);
    const reopened = await openEncryptedKeyEnvelope(
      setup.vaultKey.encryptedKey,
      setup.device.localWrappingKey,
    );
    expect(reopened).toEqual(vaultMasterKey);
    clearBytes(reopened, vaultMasterKey);
    database.close();
  });

  it('measures bounded IndexedDB outbox growth for 250 offline edits', async () => {
    const database = createDatabase();
    const { setup, vaultMasterKey } = await createSetup();
    await writeLocalSyncSetup(setup, database);
    await Promise.all([database.accounts.put(originalAccount), database.settings.put(settings)]);
    let current = originalAccount;
    const startedAt = performance.now();
    for (let index = 0; index < 250; index += 1) {
      const next = { ...current, name: `Sintetička offline izmena ${index}` };
      await auditedFinanceTransaction(
        [database.accounts],
        async (audit) => {
          await database.accounts.put(next);
          await audit.upsert('account', current, next);
        },
        database,
        () => NOW,
      );
      current = next;
    }
    const records = await database.syncOutbox.toArray();
    const canonicalPayloadBytes = records.reduce(
      (total, record) => total + new TextEncoder().encode(record.canonicalPayload).byteLength,
      0,
    );
    const metrics = {
      operations: records.length,
      canonicalPayloadBytes,
      averageCanonicalPayloadBytes: Math.round(canonicalPayloadBytes / records.length),
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
    expect(metrics.operations).toBe(250);
    expect(metrics.canonicalPayloadBytes).toBeGreaterThan(0);
    expect(metrics.canonicalPayloadBytes).toBeLessThan(1_024 * 1_024);
    console.info(JSON.stringify({ syncOutboxPerformance: metrics }));
    clearBytes(vaultMasterKey);
    database.close();
  });
});

describe('operation conflict resolution', () => {
  it('resolves a complete compound group atomically and emits one new outbox group', async () => {
    const database = createDatabase();
    const { setup, vaultMasterKey } = await createSetup();
    await writeLocalSyncSetup(setup, database);
    await Promise.all([database.accounts.put(originalAccount), database.settings.put(settings)]);
    const mutationGroupId = createOpaqueId();
    const remoteAccountOperationId = createOpaqueId();
    const remoteSettingsOperationId = createOpaqueId();
    const remoteAccount = { ...originalAccount, name: 'Udaljeni naziv' };
    const remoteSettings = {
      id: 'settings',
      onboardingCompleted: true,
      baseMonthlyIncome: 123_000,
      currency: 'RSD',
      locale: 'sr-Latn-RS',
      createdAt: settings.createdAt,
      updatedAt: NOW.toISOString(),
    };
    await database.syncConflicts.bulkAdd([
      {
        id: `${setup.vault.vaultId}:conflict-account`,
        vaultId: setup.vault.vaultId,
        entityType: 'account',
        entityId: originalAccount.id,
        localOperationId: 'snapshot-baseline',
        remoteOperationId: remoteAccountOperationId,
        mutationGroupId,
        mutationGroupIndex: 0,
        mutationGroupSize: 2,
        localCanonicalProposal: canonicalizeJson(originalAccount),
        remoteCanonicalProposal: canonicalizeJson({ value: remoteAccount, tombstone: null }),
        causalMetadata: canonicalizeJson({}),
        resolutionState: 'pending',
        detectedAt: NOW.toISOString(),
      },
      {
        id: `${setup.vault.vaultId}:conflict-settings`,
        vaultId: setup.vault.vaultId,
        entityType: 'settings',
        entityId: settings.id,
        localOperationId: 'snapshot-baseline',
        remoteOperationId: remoteSettingsOperationId,
        mutationGroupId,
        mutationGroupIndex: 1,
        mutationGroupSize: 2,
        localCanonicalProposal: canonicalizeJson(settings),
        remoteCanonicalProposal: canonicalizeJson({ value: remoteSettings, tombstone: null }),
        causalMetadata: canonicalizeJson({}),
        resolutionState: 'pending',
        detectedAt: NOW.toISOString(),
      },
    ]);

    await new SyncConflictRepository(database, () => NOW).resolveOperationGroup(
      setup.vault.vaultId,
      mutationGroupId,
      'remote',
    );

    expect(await database.accounts.get(originalAccount.id)).toEqual(remoteAccount);
    expect(await database.settings.get('settings')).toEqual({
      ...remoteSettings,
      appearance: settings.appearance,
      installHintDismissed: settings.installHintDismissed,
    });
    const outbox = await database.syncOutbox.orderBy('createdAt').toArray();
    expect(outbox).toHaveLength(2);
    expect(new Set(outbox.map((record) => record.mutationGroupId))).toEqual(
      new Set([outbox[0].mutationGroupId]),
    );
    expect(outbox.map((record) => record.mutationGroupIndex).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(
      (await database.syncConflicts.toArray()).every(
        (conflict) =>
          conflict.resolutionState === 'resolved-remote' && Boolean(conflict.resolutionOperationId),
      ),
    ).toBe(true);
    const prepared = await new SyncOperationRepository(database, () => NOW).prepareNextGroup(
      setup,
      vaultMasterKey,
    );
    expect(prepared).toHaveLength(2);
    const resolutions = await Promise.all(
      new SyncOperationRepository(database, () => NOW).envelopes(prepared).map((envelope) =>
        openEncryptedOperation({
          envelope,
          vaultMasterKey,
          signingPublicKey: setup.device.signingPublicKey,
          expected: {
            vaultId: setup.vault.vaultId,
            keyEpoch: 1,
            deviceId: setup.device.deviceId,
          },
        }),
      ),
    );
    expect(resolutions.map((operation) => operation.resolvesOperationIds)).toEqual([
      [remoteAccountOperationId],
      [remoteSettingsOperationId],
    ]);
    clearBytes(vaultMasterKey);
    database.close();
  });
});

class FakeOperationApi implements OperationSyncApiPort {
  readonly uploaded: OperationEnvelopeV1[] = [];
  readonly acknowledgements: Array<{
    acknowledgedServerCursor: number;
    acknowledgedSnapshotRevision: number;
  }> = [];

  constructor(private readonly setup: LocalSyncSetup) {}

  requestAuthChallenge(): Promise<unknown> {
    return Promise.resolve({
      type: 'mirna-auth-challenge-v1',
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
    } satisfies AuthChallengeV1);
  }

  createSession(): Promise<unknown> {
    return Promise.resolve({});
  }

  uploadOperation(envelope: OperationEnvelopeV1): Promise<{
    operationId: string;
    serverCursor: number;
    accepted: true;
  }> {
    this.uploaded.push(envelope);
    return Promise.resolve({
      operationId: envelope.operationId,
      serverCursor: this.uploaded.length,
      accepted: true,
    });
  }

  getChanges(): Promise<OperationChangesResponseV1> {
    return Promise.resolve({
      protocolVersion: 1,
      changes: [],
      nextCursor: this.uploaded.length,
      hasMore: false,
    });
  }

  acknowledgeChanges(input: {
    acknowledgedServerCursor: number;
    acknowledgedSnapshotRevision: number;
  }): Promise<unknown> {
    this.acknowledgements.push(input);
    return Promise.resolve({});
  }

  clearSession(): void {}
}

describe('operation sync service integration', () => {
  it('authenticates, uploads a stable encrypted outbox operation, advances cursor and ACKs', async () => {
    const database = createDatabase();
    const { setup, vaultMasterKey } = await createSetup();
    await writeLocalSyncSetup(setup, database);
    await Promise.all([database.accounts.put(originalAccount), database.settings.put(settings)]);
    const changed = {
      ...originalAccount,
      name: 'SYNTHETIC_OPERATION_PRIVATE_SENTINEL_4D2A',
      openingBalance: 11_000,
    };
    await auditedFinanceTransaction(
      [database.accounts],
      async (audit) => {
        await database.accounts.put(changed);
        await audit.upsert('account', originalAccount, changed);
      },
      database,
      () => NOW,
    );
    const api = new FakeOperationApi(setup);
    const service = new OperationSyncService({
      api,
      origin: 'https://mirna.test',
      repository: new SyncOperationRepository(database, () => NOW),
      snapshotRepository: new SyncSnapshotRepository(database),
      now: () => NOW,
    });

    await expect(service.synchronize()).resolves.toMatchObject({
      uploaded: 1,
      downloaded: 0,
      pendingLocalOperations: 0,
      acknowledgedServerCursor: 1,
    });
    expect(api.uploaded).toHaveLength(1);
    expect(api.uploaded[0].ciphertext).not.toContain('SYNTHETIC_OPERATION_PRIVATE_SENTINEL_4D2A');
    expect(api.acknowledgements).toHaveLength(1);
    expect(api.acknowledgements[0]).toMatchObject({
      acknowledgedServerCursor: 1,
      acknowledgedSnapshotRevision: 0,
    });
    expect((await database.syncMetadata.get(SYNC_METADATA_RECORD_ID))?.lastServerCursor).toBe(1);
    expect(await database.syncOutbox.count()).toBe(0);
    expect(await database.syncInbox.count()).toBe(1);
    clearBytes(vaultMasterKey);
    database.close();
  });
});
