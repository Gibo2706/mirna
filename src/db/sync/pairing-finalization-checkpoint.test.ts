import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { SYNC_CRYPTO_SUITE, SYNC_PROTOCOL_VERSION } from '@/domain/sync/constants';
import {
  createEncryptedKeyEnvelope,
  exportPublicEcKey,
  generateDeviceKeyPairs,
  generateLocalWrappingKey,
  generateRecoverySigningKeyPair,
  randomBytes,
} from '@/domain/sync/crypto';
import { bytesToBase64Url, clearBytes } from '@/domain/sync/encoding';
import { createInitialManifest, manifestBodyHash } from '@/domain/sync/manifest';
import { FinanceDatabase } from '../database';
import {
  completePendingPairingFinalization,
  readPendingPairingFinalization,
  stagePairingFinalization,
  type PairingFinalizationRequest,
} from './pairing-finalization-checkpoint';
import { readLocalSyncSetup } from './repository';
import {
  ACTIVE_SYNC_VAULT_RECORD_ID,
  LOCAL_SYNC_DEVICE_RECORD_ID,
  SYNC_METADATA_RECORD_ID,
  SYNC_PAIRING_FINALIZATION_RECORD_ID,
  localVaultKeyRecordId,
  type LocalSyncSetup,
} from './records';

const databaseNames: string[] = [];
const createDatabase = () => {
  const database = new FinanceDatabase(`mirna-pairing-checkpoint-${crypto.randomUUID()}`);
  databaseNames.push(database.name);
  return database;
};

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)));
});

const setupAndRequest = async (): Promise<{
  setup: LocalSyncSetup;
  request: PairingFinalizationRequest;
}> => {
  const [deviceKeys, recoveryKeys, localWrappingKey] = await Promise.all([
    generateDeviceKeyPairs(),
    generateRecoverySigningKeyPair(),
    generateLocalWrappingKey(),
  ]);
  const vaultId = 'A'.repeat(22);
  const deviceId = 'B'.repeat(22);
  const createdAt = '2026-08-02T10:00:00.000Z';
  const manifest = await createInitialManifest({
    vaultId,
    recoveryLookupId: 'C'.repeat(22),
    transitionId: 'D'.repeat(22),
    device: {
      deviceId,
      publicKeys: {
        signing: await exportPublicEcKey(deviceKeys.signing.publicKey),
        agreement: await exportPublicEcKey(deviceKeys.agreement.publicKey),
      },
      authorizedAt: createdAt,
      authorizationExpiresAt: '2026-09-01T10:00:00.000Z',
    },
    recoverySigningPublicKey: recoveryKeys.publicKey,
    signingPrivateKey: deviceKeys.signing.privateKey,
    createdAt,
  });
  const manifestHash = await manifestBodyHash(manifest);
  const vaultMasterKey = randomBytes(32);
  const encryptedKey = await createEncryptedKeyEnvelope(vaultMasterKey, localWrappingKey, {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId,
    keyEpoch: 1,
    objectType: 'local-vault-key',
    objectId: 'E'.repeat(22),
    creatingDeviceId: deviceId,
    recoveryLookupId: null,
    parentManifestHash: manifestHash,
  });
  clearBytes(vaultMasterKey);
  const setup: LocalSyncSetup = {
    vault: {
      id: ACTIVE_SYNC_VAULT_RECORD_ID,
      vaultId,
      protocolVersion: 1,
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
      displayName: 'Laptop',
      signingPrivateKey: deviceKeys.signing.privateKey,
      signingPublicKey: deviceKeys.signing.publicKey,
      agreementPrivateKey: deviceKeys.agreement.privateKey,
      agreementPublicKey: deviceKeys.agreement.publicKey,
      localWrappingKey,
      authorizationExpiresAt: '2026-09-01T10:00:00.000Z',
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
      bootstrapMode: 'paired-download',
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
  return {
    setup,
    request: {
      protocolVersion: 1,
      pollingToken: bytesToBase64Url(randomBytes(32)),
      transcript: {
        type: 'mirna-pairing-finalize-v1',
        protocolVersion: 1,
        vaultId,
        pairingRequestId: 'F'.repeat(22),
        newDeviceId: deviceId,
        candidateManifestHash: manifestHash,
        envelopeHash: bytesToBase64Url(randomBytes(32)),
        keyConfirmation: bytesToBase64Url(randomBytes(32)),
        sasConfirmed: true,
        confirmedAt: createdAt,
      },
      signature: bytesToBase64Url(randomBytes(64)),
    },
  };
};

describe('pairing finalization checkpoint', () => {
  it('encrypts authority, survives reopen and atomically promotes the staged setup', async () => {
    const database = createDatabase();
    const { setup, request } = await setupAndRequest();
    const pending = await stagePairingFinalization(setup, request, database);
    const raw = await database.syncPairingFinalizations.get(SYNC_PAIRING_FINALIZATION_RECORD_ID);
    expect(raw).toBeDefined();
    expect(JSON.stringify(raw)).not.toContain(request.pollingToken);
    expect(JSON.stringify(raw)).not.toContain(request.signature);
    expect(raw?.setup.device.signingPrivateKey.extractable).toBe(false);

    database.close();
    const reopened = new FinanceDatabase(database.name);
    const resumed = await readPendingPairingFinalization(reopened);
    expect(resumed?.request).toEqual(request);
    expect(resumed?.record.requestId).toBe(pending.record.requestId);

    await completePendingPairingFinalization(resumed!, reopened);
    expect(await reopened.syncPairingFinalizations.count()).toBe(0);
    const active = await readLocalSyncSetup(reopened);
    expect(active?.device.deviceId).toBe(setup.device.deviceId);
    expect(active?.device.signingPrivateKey.extractable).toBe(false);
    reopened.close();
  });

  it('keeps the checkpoint when promotion binding is altered', async () => {
    const database = createDatabase();
    const { setup, request } = await setupAndRequest();
    const pending = await stagePairingFinalization(setup, request, database);
    await expect(
      completePendingPairingFinalization(
        { ...pending, record: { ...pending.record, manifestHash: 'Z'.repeat(43) } },
        database,
      ),
    ).rejects.toThrow(/checkpoint/u);
    expect(await database.syncPairingFinalizations.count()).toBe(1);
    expect(await readLocalSyncSetup(database)).toBeUndefined();
  });

  it('rejects a different checkpoint instead of overwriting it', async () => {
    const database = createDatabase();
    const first = await setupAndRequest();
    await stagePairingFinalization(first.setup, first.request, database);
    await expect(
      stagePairingFinalization(
        first.setup,
        {
          ...first.request,
          transcript: { ...first.request.transcript, pairingRequestId: 'G'.repeat(22) },
        },
        database,
      ),
    ).rejects.toThrow(/different pairing finalization/u);
    expect(await database.syncPairingFinalizations.count()).toBe(1);
  });
});
