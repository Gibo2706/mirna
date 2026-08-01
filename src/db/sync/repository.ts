import { z } from 'zod';
import { canonicalizeJson } from '@/domain/sync/canonical';
import {
  exportPublicEcKey,
  importAgreementPublicKey,
  importSigningPublicKey,
  openEncryptedKeyEnvelope,
} from '@/domain/sync/crypto';
import { clearBytes, timingSafeEqual } from '@/domain/sync/encoding';
import { manifestBodyHash, verifyStandaloneManifestWithPin } from '@/domain/sync/manifest';
import {
  cryptoSuiteSchema,
  encryptedKeyEnvelopeSchema,
  opaqueIdSchema,
  protocolVersionSchema,
  timestampSchema,
  vaultManifestSchema,
} from '@/domain/sync/schemas';
import type { FinanceData } from '@/domain/types';
import { db, financeTables, type FinanceDatabase } from '../database';
import { replaceFinanceDataInTransaction, validateFinanceData } from '../finance-data';
import {
  ACTIVE_SYNC_VAULT_RECORD_ID,
  LOCAL_SYNC_DEVICE_RECORD_ID,
  SYNC_METADATA_RECORD_ID,
  localVaultKeyRecordId,
  type LocalSyncSetup,
  type SyncDeviceRecord,
  type SyncVaultRecord,
} from './records';

export class InvalidLocalSyncSetupError extends Error {
  constructor(message = 'Local sync setup is invalid.') {
    super(message);
    this.name = 'InvalidLocalSyncSetupError';
  }
}

export class IncompleteLocalSyncSetupError extends Error {
  constructor() {
    super('Local sync setup is incomplete. Disable sync on this device and pair it again.');
    this.name = 'IncompleteLocalSyncSetupError';
  }
}

const cryptoKeySchema = z.custom<CryptoKey>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    'algorithm' in value &&
    typeof value.algorithm === 'object' &&
    value.algorithm !== null &&
    'name' in value.algorithm &&
    typeof value.algorithm.name === 'string' &&
    'type' in value &&
    typeof value.type === 'string' &&
    'extractable' in value &&
    typeof value.extractable === 'boolean' &&
    'usages' in value &&
    Array.isArray(value.usages),
  'Invalid CryptoKey',
);

const syncVaultRecordSchema = z.strictObject({
  id: z.literal(ACTIVE_SYNC_VAULT_RECORD_ID),
  vaultId: opaqueIdSchema,
  protocolVersion: protocolVersionSchema,
  cryptoSuite: cryptoSuiteSchema,
  keyEpoch: z.number().int().positive(),
  status: z.enum(['pairing', 'active', 'suspended']),
  manifest: vaultManifestSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const syncDeviceRecordSchema = z.strictObject({
  id: z.literal(LOCAL_SYNC_DEVICE_RECORD_ID),
  vaultId: opaqueIdSchema,
  deviceId: opaqueIdSchema,
  displayName: z.string().trim().min(1).max(80),
  signingPrivateKey: cryptoKeySchema,
  signingPublicKey: cryptoKeySchema,
  agreementPrivateKey: cryptoKeySchema,
  agreementPublicKey: cryptoKeySchema,
  localWrappingKey: cryptoKeySchema,
  authorizationExpiresAt: timestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const syncKeyRecordSchema = z.strictObject({
  id: z.string().min(1).max(256),
  vaultId: opaqueIdSchema,
  keyEpoch: z.number().int().positive(),
  purpose: z.literal('vault-master-key'),
  encryptedKey: encryptedKeyEnvelopeSchema,
  createdAt: timestampSchema,
  retiredAt: timestampSchema.optional(),
});

const syncMetadataRecordSchema = z.strictObject({
  id: z.literal(SYNC_METADATA_RECORD_ID),
  vaultId: opaqueIdSchema,
  localSchemaVersion: z.literal(1),
  firstUploadConsent: z.enum(['pending', 'accepted', 'declined']),
  lastServerCursor: z.number().int().nonnegative(),
  lastSnapshotServerCursor: z.number().int().nonnegative(),
  lastSnapshotRevision: z.number().int().nonnegative(),
  lastSnapshotId: opaqueIdSchema.nullable(),
  lastSnapshotHash: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/u)
    .nullable(),
  lastSnapshotContentHash: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/u)
    .nullable(),
  lastManifestHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  lastLocalDataHash: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/u)
    .nullable(),
  enabledAt: timestampSchema,
  lastSyncAt: timestampSchema.optional(),
  lastSuccessfulSyncAt: timestampSchema.optional(),
  lastErrorCode: z.string().min(1).max(128).optional(),
  syncBlockReason: z
    .enum(['local-remote-conflict', 'rollback-detected', 'fork-detected', 'integrity-failure'])
    .optional(),
});

const localSyncSetupSchema = z.strictObject({
  vault: syncVaultRecordSchema,
  device: syncDeviceRecordSchema,
  vaultKey: syncKeyRecordSchema,
  metadata: syncMetadataRecordSchema,
});

const requireKey = (
  key: CryptoKey,
  description: string,
  expected: {
    algorithm: 'ECDSA' | 'ECDH' | 'AES-GCM';
    type: 'private' | 'public' | 'secret';
    requiredUsages: readonly KeyUsage[];
    nonExtractable: boolean;
  },
): void => {
  const algorithmMatches =
    key.algorithm.name === expected.algorithm &&
    (expected.algorithm === 'AES-GCM'
      ? (key.algorithm as AesKeyAlgorithm).length === 256
      : (key.algorithm as EcKeyAlgorithm).namedCurve === 'P-256');
  if (
    !algorithmMatches ||
    key.type !== expected.type ||
    (expected.nonExtractable && key.extractable) ||
    key.usages.length !== expected.requiredUsages.length ||
    expected.requiredUsages.some((usage) => !key.usages.includes(usage))
  ) {
    throw new InvalidLocalSyncSetupError(`Invalid ${description}.`);
  }
};

const validateDeviceKeys = (device: SyncDeviceRecord): void => {
  requireKey(device.signingPrivateKey, 'signing private key', {
    algorithm: 'ECDSA',
    type: 'private',
    requiredUsages: ['sign'],
    nonExtractable: true,
  });
  requireKey(device.signingPublicKey, 'signing public key', {
    algorithm: 'ECDSA',
    type: 'public',
    requiredUsages: ['verify'],
    nonExtractable: false,
  });
  requireKey(device.agreementPrivateKey, 'agreement private key', {
    algorithm: 'ECDH',
    type: 'private',
    requiredUsages: ['deriveBits'],
    nonExtractable: true,
  });
  requireKey(device.agreementPublicKey, 'agreement public key', {
    algorithm: 'ECDH',
    type: 'public',
    requiredUsages: [],
    nonExtractable: false,
  });
  requireKey(device.localWrappingKey, 'local wrapping key', {
    algorithm: 'AES-GCM',
    type: 'secret',
    requiredUsages: ['encrypt', 'decrypt'],
    nonExtractable: true,
  });
};

const validateStoredKeyPairs = async (device: SyncDeviceRecord): Promise<void> => {
  const runtime = globalThis.crypto;
  if (!runtime?.subtle) throw new InvalidLocalSyncSetupError('Web Crypto is unavailable.');
  const probe = new TextEncoder().encode(
    `MIRNA-E2EE-V1/local-key-pair-probe\0${device.vaultId}\0${device.deviceId}`,
  );
  const signingProbe = await runtime.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    device.signingPrivateKey,
    probe,
  );
  if (
    !(await runtime.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      device.signingPublicKey,
      signingProbe,
      probe,
    ))
  ) {
    throw new InvalidLocalSyncSetupError('Stored signing key pair does not match.');
  }

  const ephemeral = await runtime.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ]);
  if (!('privateKey' in ephemeral)) {
    throw new InvalidLocalSyncSetupError('Unable to validate the agreement key pair.');
  }
  const [localSecret, peerSecret] = await Promise.all([
    runtime.subtle.deriveBits(
      { name: 'ECDH', public: ephemeral.publicKey },
      device.agreementPrivateKey,
      256,
    ),
    runtime.subtle.deriveBits(
      { name: 'ECDH', public: device.agreementPublicKey },
      ephemeral.privateKey,
      256,
    ),
  ]);
  const localBytes = new Uint8Array(localSecret);
  const peerBytes = new Uint8Array(peerSecret);
  try {
    if (!timingSafeEqual(localBytes, peerBytes)) {
      throw new InvalidLocalSyncSetupError('Stored agreement key pair does not match.');
    }
  } finally {
    clearBytes(localBytes, peerBytes);
  }
};

const parseSetup = (setup: unknown): LocalSyncSetup => {
  try {
    return localSyncSetupSchema.parse(setup);
  } catch {
    throw new InvalidLocalSyncSetupError('Local sync records do not match their schemas.');
  }
};

const validateManifestPublicKeys = async (vault: SyncVaultRecord): Promise<void> => {
  await Promise.all([
    importSigningPublicKey(vault.manifest.recoverySigningPublicKey),
    ...vault.manifest.devices.flatMap((device) => [
      importSigningPublicKey(device.publicKeys.signing),
      importAgreementPublicKey(device.publicKeys.agreement),
    ]),
    ...vault.manifest.revokedDevices.flatMap((device) => [
      importSigningPublicKey(device.publicKeys.signing),
      importAgreementPublicKey(device.publicKeys.agreement),
    ]),
  ]);
};

const validateSetup = async (input: unknown): Promise<LocalSyncSetup> => {
  const setup = parseSetup(input);
  const { vault, device, vaultKey, metadata } = setup;
  if (
    vault.id !== ACTIVE_SYNC_VAULT_RECORD_ID ||
    device.id !== LOCAL_SYNC_DEVICE_RECORD_ID ||
    vaultKey.id !== localVaultKeyRecordId(vault.vaultId, vault.keyEpoch) ||
    metadata.id !== SYNC_METADATA_RECORD_ID
  ) {
    throw new InvalidLocalSyncSetupError('Local singleton record IDs do not match.');
  }
  if (
    device.vaultId !== vault.vaultId ||
    vaultKey.vaultId !== vault.vaultId ||
    metadata.vaultId !== vault.vaultId ||
    vault.manifest.vaultId !== vault.vaultId ||
    vault.manifest.keyEpoch !== vault.keyEpoch ||
    vaultKey.keyEpoch !== vault.keyEpoch ||
    vaultKey.encryptedKey.vaultId !== vault.vaultId ||
    vaultKey.encryptedKey.keyEpoch !== vault.keyEpoch ||
    vaultKey.encryptedKey.objectId !== vaultKey.encryptedKey.aad.objectId ||
    vaultKey.encryptedKey.aad.vaultId !== vault.vaultId ||
    vaultKey.encryptedKey.aad.keyEpoch !== vault.keyEpoch ||
    vaultKey.encryptedKey.aad.objectType !== 'local-vault-key' ||
    vaultKey.encryptedKey.aad.creatingDeviceId !== device.deviceId ||
    vaultKey.encryptedKey.aad.recoveryLookupId !== null ||
    vault.protocolVersion !== vault.manifest.protocolVersion ||
    vault.protocolVersion !== vaultKey.encryptedKey.protocolVersion ||
    vault.cryptoSuite !== vault.manifest.suite ||
    vault.cryptoSuite !== vaultKey.encryptedKey.suite
  ) {
    throw new InvalidLocalSyncSetupError('Local sync records do not describe one vault setup.');
  }
  validateDeviceKeys(device);

  try {
    const localManifestDevice = vault.manifest.devices.find(
      (candidate) => candidate.deviceId === device.deviceId,
    );
    if (
      !localManifestDevice ||
      localManifestDevice.authorizationExpiresAt !== device.authorizationExpiresAt
    ) {
      throw new InvalidLocalSyncSetupError(
        'The local device is not active in the current manifest.',
      );
    }

    await validateManifestPublicKeys(vault);
    const [storedSigningPublicKey, storedAgreementPublicKey] = await Promise.all([
      exportPublicEcKey(device.signingPublicKey),
      exportPublicEcKey(device.agreementPublicKey),
    ]);
    if (
      canonicalizeJson(storedSigningPublicKey) !==
        canonicalizeJson(localManifestDevice.publicKeys.signing) ||
      canonicalizeJson(storedAgreementPublicKey) !==
        canonicalizeJson(localManifestDevice.publicKeys.agreement)
    ) {
      throw new InvalidLocalSyncSetupError('Stored public keys do not match the current manifest.');
    }

    await validateStoredKeyPairs(device);
    const currentManifestHash = await manifestBodyHash(vault.manifest);
    if (
      vaultKey.encryptedKey.aad.parentManifestHash !== currentManifestHash ||
      metadata.lastManifestHash !== currentManifestHash
    ) {
      throw new InvalidLocalSyncSetupError(
        'The local vault-key envelope and metadata are not pinned to the current manifest.',
      );
    }
    if (
      (metadata.lastSnapshotRevision === 0 &&
        (metadata.lastSnapshotHash !== null || metadata.lastSnapshotContentHash !== null)) ||
      (metadata.lastSnapshotRevision > 0 &&
        (metadata.lastSnapshotId === null ||
          metadata.lastSnapshotHash === null ||
          metadata.lastSnapshotContentHash === null))
    ) {
      throw new InvalidLocalSyncSetupError('Local snapshot pins are inconsistent.');
    }
    const openedVaultMasterKey = await openEncryptedKeyEnvelope(
      vaultKey.encryptedKey,
      device.localWrappingKey,
    );
    clearBytes(openedVaultMasterKey);
    await verifyStandaloneManifestWithPin(vault.manifest, {
      manifestVersion: vault.manifest.manifestVersion,
      manifestHash: currentManifestHash,
    });
  } catch (error) {
    if (error instanceof InvalidLocalSyncSetupError) throw error;
    throw new InvalidLocalSyncSetupError('Local sync cryptographic state is invalid.');
  }
  return setup;
};

const syncTables = (database: FinanceDatabase) => [
  database.syncVault,
  database.syncDevice,
  database.syncKeys,
  database.syncOutbox,
  database.syncInbox,
  database.syncConflicts,
  database.syncFrontier,
  database.syncMetadata,
  database.syncCheckpoints,
  database.syncEntityStates,
];

const assertCompatibleExistingVault = async (
  database: FinanceDatabase,
  setup: LocalSyncSetup,
): Promise<void> => {
  const currentVault = await database.syncVault.get(ACTIVE_SYNC_VAULT_RECORD_ID);
  if (!currentVault) return;
  let parsedCurrentVault: SyncVaultRecord;
  try {
    parsedCurrentVault = syncVaultRecordSchema.parse(currentVault);
  } catch {
    throw new InvalidLocalSyncSetupError('Existing local vault record is corrupt.');
  }
  if (parsedCurrentVault.vaultId !== setup.vault.vaultId) {
    throw new InvalidLocalSyncSetupError('A different vault is already enabled on this device.');
  }
};

const putSetupRecords = async (database: FinanceDatabase, setup: LocalSyncSetup): Promise<void> => {
  await Promise.all([
    database.syncVault.put(setup.vault),
    database.syncDevice.put(setup.device),
    database.syncKeys.put(setup.vaultKey),
    database.syncMetadata.put(setup.metadata),
  ]);
};

export const writeLocalSyncSetup = async (
  setup: LocalSyncSetup,
  database: FinanceDatabase = db,
): Promise<void> => {
  const validatedSetup = await validateSetup(setup);
  await database.transaction(
    'rw',
    [database.syncVault, database.syncDevice, database.syncKeys, database.syncMetadata],
    async () => {
      await assertCompatibleExistingVault(database, validatedSetup);
      await putSetupRecords(database, validatedSetup);
    },
  );
};

export const writeRecoveredLocalSyncSetup = async (
  setup: LocalSyncSetup,
  data: FinanceData,
  database: FinanceDatabase = db,
): Promise<void> => {
  const [validatedSetup, validatedData] = await Promise.all([
    validateSetup(setup),
    Promise.resolve(validateFinanceData(data)),
  ]);
  await database.transaction(
    'rw',
    [
      ...financeTables(database),
      database.syncVault,
      database.syncDevice,
      database.syncKeys,
      database.syncMetadata,
    ],
    async () => {
      await assertCompatibleExistingVault(database, validatedSetup);
      await replaceFinanceDataInTransaction(database, validatedData);
      await putSetupRecords(database, validatedSetup);
    },
  );
};

export const readLocalSyncSetup = async (
  database: FinanceDatabase = db,
): Promise<LocalSyncSetup | undefined> => {
  const records = await database.transaction(
    'r',
    [database.syncVault, database.syncDevice, database.syncKeys, database.syncMetadata],
    async () => {
      const [vault, device, vaultKeys, metadata] = await Promise.all([
        database.syncVault.get(ACTIVE_SYNC_VAULT_RECORD_ID),
        database.syncDevice.get(LOCAL_SYNC_DEVICE_RECORD_ID),
        database.syncKeys.toArray(),
        database.syncMetadata.get(SYNC_METADATA_RECORD_ID),
      ]);
      const vaultKey = vault
        ? vaultKeys.find(
            (candidate) =>
              candidate.vaultId === vault.vaultId && candidate.keyEpoch === vault.keyEpoch,
          )
        : undefined;
      if (!vault && !device && vaultKeys.length === 0 && !metadata) return undefined;
      if (!vault || !device || !vaultKey || !metadata) {
        throw new IncompleteLocalSyncSetupError();
      }
      return { vault, device, vaultKey, metadata };
    },
  );
  return records ? validateSetup(records) : undefined;
};

/**
 * Removes device-local sync state in one transaction. IndexedDB and JavaScript
 * cannot guarantee physical secure erasure, so callers must not retain extra
 * secret copies outside these records.
 */
export const clearLocalSyncState = async (database: FinanceDatabase = db): Promise<void> => {
  const tables = syncTables(database);
  await database.transaction('rw', tables, async () => {
    await Promise.all(tables.map((table) => table.clear()));
  });
};

export const disableSyncOnThisDevice = clearLocalSyncState;
