import { z } from 'zod';
import { assertFinanceDataIntegrity } from '../integrity';
import {
  accountSchema,
  appSettingsSchema,
  categorySchema,
  commitmentSchema,
  debtPaymentSchema,
  debtSchema,
  financeDataSchema,
  goalSchema,
  plannedEventSchema,
  plannedIncomeSchema,
  presetSchema,
  salaryScenarioSchema,
  transactionSchema,
  variableBudgetSchema,
} from '../schemas';
import type { AppSettings, FinanceData } from '../types';
import { canonicalBytes } from './canonical';
import {
  SYNC_CRYPTO_SUITE,
  SYNC_LIMITS,
  SYNC_PROTOCOL_VERSION,
  SYNC_TRANSCRIPT_TYPES,
} from './constants';
import {
  createOpaqueId,
  decryptAesGcm,
  deriveObjectEncryptionKey,
  encryptAesGcm,
  hashDomainSeparatedCanonical,
  randomBytes,
  sha256,
  signDomainSeparatedCanonical,
  verifyDomainSeparatedCanonicalSignature,
  type CryptoRuntime,
} from './crypto';
import { base64UrlToBytes, bytesToBase64Url, clearBytes, decodeUtf8 } from './encoding';
import {
  aesGcmNonceSchema,
  opaqueIdSchema,
  sha256Schema,
  signatureSchema,
  timestampSchema,
} from './schemas';

export const SYNC_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const SYNC_SNAPSHOT_TYPE = 'mirna-sync-snapshot-v1' as const;

export const SNAPSHOT_CONTENT_HASH_DOMAIN = 'MIRNA-E2EE-V1/snapshot-content' as const;
export const SNAPSHOT_DATA_HASH_DOMAIN = 'MIRNA-E2EE-V1/snapshot-finance-data' as const;
export const SNAPSHOT_FRONTIER_HASH_DOMAIN = 'MIRNA-E2EE-V1/snapshot-frontier' as const;
export const SNAPSHOT_SIGNATURE_DOMAIN = 'MIRNA-E2EE-V1/snapshot-envelope' as const;
export const SNAPSHOT_COMMIT_HASH_DOMAIN = 'MIRNA-E2EE-V1/snapshot-commit' as const;

export const MAX_SNAPSHOT_DECOMPRESSED_BYTES = 16 * 1_024 * 1_024;
export const MAX_SNAPSHOT_COMPRESSION_RATIO = 100;

const safeNonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = safeNonNegativeInteger.positive();

const sortedById = <T extends { id: string }>(values: readonly T[]): T[] =>
  [...values].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

const isStrictlySortedBy = <T>(values: readonly T[], key: (value: T) => string): boolean => {
  for (let index = 1; index < values.length; index += 1) {
    if (key(values[index - 1]) >= key(values[index])) return false;
  }
  return true;
};

const stripUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .map(([key, item]) => [key, stripUndefined(item)]),
  );
};

const strictFinanceDataSchema = z.strictObject({
  accounts: z.array(accountSchema.strict()),
  transactions: z.array(transactionSchema.strict()),
  categories: z.array(categorySchema.strict()),
  plannedIncomes: z.array(plannedIncomeSchema.strict()),
  commitments: z.array(commitmentSchema.strict()),
  variableBudgets: z.array(variableBudgetSchema.strict()),
  goals: z.array(goalSchema.strict()),
  debts: z.array(debtSchema.strict()),
  debtPayments: z.array(debtPaymentSchema.strict()),
  plannedEvents: z.array(plannedEventSchema.strict()),
  presets: z.array(presetSchema.strict()),
  salaryScenarios: z.array(salaryScenarioSchema.strict()),
  settings: z.array(appSettingsSchema.strict()).length(1),
});

export const syncedAppSettingsSchema = appSettingsSchema
  .omit({
    appearance: true,
    lastBackupAt: true,
    installHintDismissed: true,
  })
  .strict();

export const syncFinanceDataSchema = z
  .strictObject({
    accounts: z.array(accountSchema.strict()),
    transactions: z.array(transactionSchema.strict()),
    categories: z.array(categorySchema.strict()),
    plannedIncomes: z.array(plannedIncomeSchema.strict()),
    commitments: z.array(commitmentSchema.strict()),
    variableBudgets: z.array(variableBudgetSchema.strict()),
    goals: z.array(goalSchema.strict()),
    debts: z.array(debtSchema.strict()),
    debtPayments: z.array(debtPaymentSchema.strict()),
    plannedEvents: z.array(plannedEventSchema.strict()),
    presets: z.array(presetSchema.strict()),
    salaryScenarios: z.array(salaryScenarioSchema.strict()),
    settings: z.array(syncedAppSettingsSchema).length(1),
  })
  .superRefine((data, context) => {
    const stores = Object.entries(data) as [string, readonly { id: string }[]][];
    for (const [store, values] of stores) {
      if (!isStrictlySortedBy(values, (value) => value.id)) {
        context.addIssue({
          code: 'custom',
          path: [store],
          message: 'Zapisi moraju biti sortirani po jedinstvenom ID-u.',
        });
      }
    }
  });

export const snapshotCausalFrontierEntrySchema = z
  .strictObject({
    deviceId: opaqueIdSchema,
    deviceSequence: safeNonNegativeInteger,
    lastOperationHash: sha256Schema.nullable(),
  })
  .superRefine((entry, context) => {
    if ((entry.deviceSequence === 0) !== (entry.lastOperationHash === null)) {
      context.addIssue({
        code: 'custom',
        path: ['lastOperationHash'],
        message: 'Hash poslednje operacije nije usaglašen sa sekvencom uređaja.',
      });
    }
  });

export const snapshotCausalFrontierSchema = z
  .strictObject({
    serverCursor: safeNonNegativeInteger,
    devices: z.array(snapshotCausalFrontierEntrySchema).max(SYNC_LIMITS.maxDevicesPerVault),
  })
  .superRefine((frontier, context) => {
    if (!isStrictlySortedBy(frontier.devices, (entry) => entry.deviceId)) {
      context.addIssue({
        code: 'custom',
        path: ['devices'],
        message: 'Kauzalni front mora imati jedinstvene uređaje sortirane po ID-u.',
      });
    }
  });

const syncSnapshotBodySchema = z
  .strictObject({
    type: z.literal(SYNC_SNAPSHOT_TYPE),
    snapshotSchemaVersion: z.literal(SYNC_SNAPSHOT_SCHEMA_VERSION),
    protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
    suite: z.literal(SYNC_CRYPTO_SUITE),
    vaultId: opaqueIdSchema,
    snapshotId: opaqueIdSchema,
    revision: positiveSafeInteger,
    baseRevision: safeNonNegativeInteger,
    keyEpoch: positiveSafeInteger,
    creatingDeviceId: opaqueIdSchema,
    createdAt: timestampSchema,
    parentManifestHash: sha256Schema,
    previousSnapshotHash: sha256Schema.nullable(),
    causalFrontier: snapshotCausalFrontierSchema,
    data: syncFinanceDataSchema,
  })
  .superRefine((snapshot, context) => {
    if (snapshot.revision !== snapshot.baseRevision + 1) {
      context.addIssue({
        code: 'custom',
        path: ['revision'],
        message: 'Revizija snimka mora neposredno slediti baznu reviziju.',
      });
    }
    if (snapshot.baseRevision === 0 && snapshot.previousSnapshotHash !== null) {
      context.addIssue({
        code: 'custom',
        path: ['previousSnapshotHash'],
        message: 'Početni snimak ne sme imati prethodni hash.',
      });
    }
    if (snapshot.baseRevision > 0 && snapshot.previousSnapshotHash === null) {
      context.addIssue({
        code: 'custom',
        path: ['previousSnapshotHash'],
        message: 'Naredni snimak mora biti vezan za prethodno prihvaćen snimak.',
      });
    }
  });

export const syncSnapshotSchema = syncSnapshotBodySchema.extend({
  contentIntegrityHash: sha256Schema,
});

export const snapshotAadSchema = z
  .strictObject({
    protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
    suite: z.literal(SYNC_CRYPTO_SUITE),
    vaultId: opaqueIdSchema,
    keyEpoch: positiveSafeInteger,
    objectType: z.literal('snapshot'),
    objectId: opaqueIdSchema,
    snapshotSchemaVersion: z.literal(SYNC_SNAPSHOT_SCHEMA_VERSION),
    revision: positiveSafeInteger,
    baseRevision: safeNonNegativeInteger,
    creatingDeviceId: opaqueIdSchema,
    parentManifestHash: sha256Schema,
    previousSnapshotHash: sha256Schema.nullable(),
    causalFrontierHash: sha256Schema,
    compression: z.enum(['gzip', 'none']),
  })
  .superRefine((aad, context) => {
    if (aad.revision !== aad.baseRevision + 1) {
      context.addIssue({
        code: 'custom',
        path: ['revision'],
        message: 'Revizija AAD-a mora neposredno slediti baznu reviziju.',
      });
    }
    if ((aad.baseRevision === 0) !== (aad.previousSnapshotHash === null)) {
      context.addIssue({
        code: 'custom',
        path: ['previousSnapshotHash'],
        message: 'Prethodni hash nije usaglašen sa baznom revizijom.',
      });
    }
  });

export const unsignedEncryptedSnapshotEnvelopeSchema = z
  .strictObject({
    type: z.literal(SYNC_TRANSCRIPT_TYPES.snapshotEnvelope),
    protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
    suite: z.literal(SYNC_CRYPTO_SUITE),
    vaultId: opaqueIdSchema,
    snapshotId: opaqueIdSchema,
    revision: positiveSafeInteger,
    baseRevision: safeNonNegativeInteger,
    keyEpoch: positiveSafeInteger,
    creatingDeviceId: opaqueIdSchema,
    parentManifestHash: sha256Schema,
    previousSnapshotHash: sha256Schema.nullable(),
    causalFrontierHash: sha256Schema,
    compression: z.enum(['gzip', 'none']),
    nonce: aesGcmNonceSchema,
    aad: snapshotAadSchema,
    ciphertextLength: z.number().int().min(16).max(SYNC_LIMITS.maxSnapshotBytes),
    ciphertextHash: sha256Schema,
  })
  .superRefine((envelope, context) => {
    const expected = {
      vaultId: envelope.vaultId,
      objectId: envelope.snapshotId,
      revision: envelope.revision,
      baseRevision: envelope.baseRevision,
      keyEpoch: envelope.keyEpoch,
      creatingDeviceId: envelope.creatingDeviceId,
      parentManifestHash: envelope.parentManifestHash,
      previousSnapshotHash: envelope.previousSnapshotHash,
      causalFrontierHash: envelope.causalFrontierHash,
      compression: envelope.compression,
    } as const;
    for (const [key, value] of Object.entries(expected)) {
      if (envelope.aad[key as keyof typeof expected] !== value) {
        context.addIssue({
          code: 'custom',
          path: ['aad', key],
          message: 'AAD nije usaglašen sa potpisanim omotom.',
        });
      }
    }
  });

export const encryptedSnapshotEnvelopeSchema = unsignedEncryptedSnapshotEnvelopeSchema.extend({
  signature: signatureSchema,
});

export type SyncedAppSettingsV1 = z.infer<typeof syncedAppSettingsSchema>;
export type SyncFinanceDataV1 = z.infer<typeof syncFinanceDataSchema>;
export type SnapshotCausalFrontierV1 = z.infer<typeof snapshotCausalFrontierSchema>;
export type SyncSnapshotBodyV1 = z.infer<typeof syncSnapshotBodySchema>;
export type SyncSnapshotV1 = z.infer<typeof syncSnapshotSchema>;
export type SnapshotAadV1 = z.infer<typeof snapshotAadSchema>;
export type UnsignedEncryptedSnapshotEnvelopeV1 = z.infer<
  typeof unsignedEncryptedSnapshotEnvelopeSchema
>;
export type EncryptedSnapshotEnvelopeV1 = z.infer<typeof encryptedSnapshotEnvelopeSchema>;

/**
 * Ciphertext is deliberately separate from the signed clear envelope so the
 * Worker can authenticate metadata and stream the opaque body directly to R2.
 */
export interface EncryptedSnapshotArtifactV1 {
  readonly envelope: EncryptedSnapshotEnvelopeV1;
  readonly ciphertext: Uint8Array;
  readonly snapshotContentHash: string;
}

const validateFullFinanceData = (value: FinanceData): FinanceData => {
  financeDataSchema.parse(value);
  const parsed = strictFinanceDataSchema.parse(value);
  assertFinanceDataIntegrity(parsed);
  return parsed;
};

const normalizeFrontier = (frontier: SnapshotCausalFrontierV1): SnapshotCausalFrontierV1 =>
  snapshotCausalFrontierSchema.parse({
    ...frontier,
    devices: [...frontier.devices].sort((left, right) =>
      left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0,
    ),
  });

export const createSyncFinanceData = (value: FinanceData): SyncFinanceDataV1 => {
  const parsed = validateFullFinanceData(value);
  const settings = parsed.settings[0];
  const {
    appearance: _appearance,
    lastBackupAt: _lastBackupAt,
    installHintDismissed: _installHintDismissed,
    ...syncedSettings
  } = settings;
  void _appearance;
  void _lastBackupAt;
  void _installHintDismissed;

  return syncFinanceDataSchema.parse(
    stripUndefined({
      accounts: sortedById(parsed.accounts),
      transactions: sortedById(parsed.transactions),
      categories: sortedById(parsed.categories),
      plannedIncomes: sortedById(parsed.plannedIncomes),
      commitments: sortedById(parsed.commitments),
      variableBudgets: sortedById(parsed.variableBudgets),
      goals: sortedById(parsed.goals),
      debts: sortedById(parsed.debts),
      debtPayments: sortedById(parsed.debtPayments),
      plannedEvents: sortedById(parsed.plannedEvents),
      presets: sortedById(parsed.presets),
      salaryScenarios: sortedById(parsed.salaryScenarios),
      settings: [syncedSettings],
    }),
  );
};

export const computeSyncFinanceDataHash = (
  value: FinanceData,
  runtime?: CryptoRuntime,
): Promise<string> =>
  hashDomainSeparatedCanonical(SNAPSHOT_DATA_HASH_DOMAIN, createSyncFinanceData(value), runtime);

const financeDataForIntegrityCheck = (
  data: SyncFinanceDataV1,
  localSettings: DeviceLocalSettings,
): FinanceData =>
  strictFinanceDataSchema.parse({
    ...data,
    settings: [{ ...data.settings[0], ...localSettings }],
  });

const assertSnapshotFinanceIntegrity = (data: SyncFinanceDataV1): void => {
  const hydrated = financeDataForIntegrityCheck(data, {
    appearance: 'system',
    installHintDismissed: false,
  });
  financeDataSchema.parse(hydrated);
  assertFinanceDataIntegrity(hydrated);
};

export const computeSnapshotContentHash = (
  body: SyncSnapshotBodyV1,
  runtime?: CryptoRuntime,
): Promise<string> =>
  hashDomainSeparatedCanonical(
    SNAPSHOT_CONTENT_HASH_DOMAIN,
    syncSnapshotBodySchema.parse(body),
    runtime,
  );

export const computeSnapshotFrontierHash = (
  frontier: SnapshotCausalFrontierV1,
  runtime?: CryptoRuntime,
): Promise<string> =>
  hashDomainSeparatedCanonical(
    SNAPSHOT_FRONTIER_HASH_DOMAIN,
    snapshotCausalFrontierSchema.parse(frontier),
    runtime,
  );

export interface CreateSyncSnapshotInput {
  data: FinanceData;
  vaultId: string;
  snapshotId: string;
  revision: number;
  baseRevision: number;
  keyEpoch: number;
  creatingDeviceId: string;
  createdAt: string;
  parentManifestHash: string;
  previousSnapshotHash: string | null;
  causalFrontier: SnapshotCausalFrontierV1;
}

export const createSyncSnapshot = async (
  input: CreateSyncSnapshotInput,
  runtime?: CryptoRuntime,
): Promise<SyncSnapshotV1> => {
  const body = syncSnapshotBodySchema.parse({
    type: SYNC_SNAPSHOT_TYPE,
    snapshotSchemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    suite: SYNC_CRYPTO_SUITE,
    vaultId: input.vaultId,
    snapshotId: input.snapshotId,
    revision: input.revision,
    baseRevision: input.baseRevision,
    keyEpoch: input.keyEpoch,
    creatingDeviceId: input.creatingDeviceId,
    createdAt: input.createdAt,
    parentManifestHash: input.parentManifestHash,
    previousSnapshotHash: input.previousSnapshotHash,
    causalFrontier: normalizeFrontier(input.causalFrontier),
    data: createSyncFinanceData(input.data),
  });
  return syncSnapshotSchema.parse({
    ...body,
    contentIntegrityHash: await computeSnapshotContentHash(body, runtime),
  });
};

export const parseSyncSnapshot = async (
  value: unknown,
  runtime?: CryptoRuntime,
): Promise<SyncSnapshotV1> => {
  const parsed = syncSnapshotSchema.parse(value);
  const { contentIntegrityHash, ...body } = parsed;
  const expectedHash = await computeSnapshotContentHash(body, runtime);
  if (contentIntegrityHash !== expectedHash) {
    throw new Error('Sadržaj snimka nema očekivani integritet.');
  }
  assertSnapshotFinanceIntegrity(parsed.data);
  return parsed;
};

export interface DeviceLocalSettings {
  appearance: AppSettings['appearance'];
  installHintDismissed: boolean;
  lastBackupAt?: string;
}

export const prepareFinanceDataForSnapshotApply = async (
  value: unknown,
  localSettings: DeviceLocalSettings,
  runtime?: CryptoRuntime,
): Promise<FinanceData> => {
  const snapshot = await parseSyncSnapshot(value, runtime);
  const hydrated = financeDataForIntegrityCheck(snapshot.data, localSettings);
  financeDataSchema.parse(hydrated);
  assertFinanceDataIntegrity(hydrated);
  return hydrated;
};

const copiedBytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(new ArrayBuffer(value.length));
  copy.set(value);
  return copy;
};

const readBoundedStream = async (
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  ratioBaseBytes?: number,
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const ratioLimit =
    ratioBaseBytes === undefined
      ? Number.MAX_SAFE_INTEGER
      : ratioBaseBytes * MAX_SNAPSHOT_COMPRESSION_RATIO;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = new Uint8Array(result.value);
      total += chunk.length;
      if (total > maximumBytes) {
        throw new Error('Dešifrovani snimak prelazi dozvoljenu veličinu.');
      }
      if (total > ratioLimit) {
        throw new Error('Snimak prelazi dozvoljeni odnos kompresije.');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
};

const transformBytes = async (
  input: Uint8Array,
  transform: {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<BufferSource>;
  },
  maximumBytes: number,
  ratioBaseBytes?: number,
): Promise<Uint8Array> => {
  const reading = readBoundedStream(transform.readable, maximumBytes, ratioBaseBytes);
  const writer = transform.writable.getWriter();
  try {
    await writer.write(copiedBytes(input));
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    await reading.catch(() => undefined);
    throw error;
  } finally {
    writer.releaseLock();
  }
  return reading;
};

export interface CompressedSnapshotBytes {
  compression: 'gzip' | 'none';
  bytes: Uint8Array;
}

export const compressSnapshotBytes = async (
  plaintext: Uint8Array,
  preference: 'gzip' | 'none' = 'gzip',
): Promise<CompressedSnapshotBytes> => {
  if (plaintext.length > MAX_SNAPSHOT_DECOMPRESSED_BYTES) {
    throw new Error('Snimak prelazi dozvoljenu veličinu pre kompresije.');
  }
  if (preference === 'none' || typeof globalThis.CompressionStream !== 'function') {
    return { compression: 'none', bytes: plaintext.slice() };
  }
  return {
    compression: 'gzip',
    bytes: await transformBytes(
      plaintext,
      new CompressionStream('gzip'),
      SYNC_LIMITS.maxSnapshotBytes - 16,
    ),
  };
};

export const decompressSnapshotBytes = async (
  compressed: Uint8Array,
  compression: 'gzip' | 'none',
): Promise<Uint8Array> => {
  if (compression === 'none') {
    if (compressed.length > MAX_SNAPSHOT_DECOMPRESSED_BYTES) {
      throw new Error('Dešifrovani snimak prelazi dozvoljenu veličinu.');
    }
    return compressed.slice();
  }
  if (compressed.length === 0) throw new Error('Komprimovani snimak je prazan.');
  if (typeof globalThis.DecompressionStream !== 'function') {
    throw new Error('Ovaj pregledač ne podržava gzip dekompresiju snimka.');
  }
  return transformBytes(
    compressed,
    new DecompressionStream('gzip'),
    MAX_SNAPSHOT_DECOMPRESSED_BYTES,
    compressed.length,
  );
};

export interface EncryptSnapshotInput extends Omit<CreateSyncSnapshotInput, 'snapshotId'> {
  snapshotId?: string;
  vaultMasterKey: Uint8Array;
  signingPrivateKey: CryptoKey;
  compression?: 'gzip' | 'none';
}

export const createEncryptedSnapshot = async (
  input: EncryptSnapshotInput,
  runtime?: CryptoRuntime,
): Promise<EncryptedSnapshotArtifactV1> => {
  const snapshotId = input.snapshotId ?? createOpaqueId(runtime);
  const snapshot = await createSyncSnapshot({ ...input, snapshotId }, runtime);
  const plaintext = canonicalBytes(snapshot);
  if (plaintext.length > MAX_SNAPSHOT_DECOMPRESSED_BYTES) {
    throw new Error('Kanonski snimak prelazi dozvoljenu veličinu.');
  }
  let compressedBytes: Uint8Array | undefined;
  try {
    const candidateCompression = await compressSnapshotBytes(plaintext, input.compression);
    const exceedsCompressionRatio =
      candidateCompression.compression === 'gzip' &&
      plaintext.length > candidateCompression.bytes.length * MAX_SNAPSHOT_COMPRESSION_RATIO;
    const compressed = exceedsCompressionRatio
      ? ({ compression: 'none', bytes: plaintext.slice() } as const)
      : candidateCompression;
    if (exceedsCompressionRatio) clearBytes(candidateCompression.bytes);
    compressedBytes = compressed.bytes;
    const causalFrontierHash = await computeSnapshotFrontierHash(snapshot.causalFrontier, runtime);
    const aad = snapshotAadSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: snapshot.vaultId,
      keyEpoch: snapshot.keyEpoch,
      objectType: 'snapshot',
      objectId: snapshot.snapshotId,
      snapshotSchemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
      revision: snapshot.revision,
      baseRevision: snapshot.baseRevision,
      creatingDeviceId: snapshot.creatingDeviceId,
      parentManifestHash: snapshot.parentManifestHash,
      previousSnapshotHash: snapshot.previousSnapshotHash,
      causalFrontierHash,
      compression: compressed.compression,
    });
    const key = await deriveObjectEncryptionKey(
      input.vaultMasterKey,
      {
        vaultId: snapshot.vaultId,
        keyEpoch: snapshot.keyEpoch,
        objectType: 'snapshot',
        objectId: snapshot.snapshotId,
        purpose: 'snapshot',
      },
      runtime,
    );
    const nonce = randomBytes(SYNC_LIMITS.aesGcmNonceBytes, runtime);
    const ciphertext = await encryptAesGcm(compressed.bytes, key, nonce, aad, runtime);
    if (ciphertext.length > SYNC_LIMITS.maxSnapshotBytes) {
      throw new Error('Šifrovani snimak prelazi staging ograničenje od 8 MiB.');
    }
    const unsignedEnvelope = unsignedEncryptedSnapshotEnvelopeSchema.parse({
      type: SYNC_TRANSCRIPT_TYPES.snapshotEnvelope,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: snapshot.vaultId,
      snapshotId: snapshot.snapshotId,
      revision: snapshot.revision,
      baseRevision: snapshot.baseRevision,
      keyEpoch: snapshot.keyEpoch,
      creatingDeviceId: snapshot.creatingDeviceId,
      parentManifestHash: snapshot.parentManifestHash,
      previousSnapshotHash: snapshot.previousSnapshotHash,
      causalFrontierHash,
      compression: compressed.compression,
      nonce: bytesToBase64Url(nonce),
      aad,
      ciphertextLength: ciphertext.length,
      ciphertextHash: bytesToBase64Url(await sha256(ciphertext, runtime)),
    });
    const envelope = encryptedSnapshotEnvelopeSchema.parse({
      ...unsignedEnvelope,
      signature: await signDomainSeparatedCanonical(
        SNAPSHOT_SIGNATURE_DOMAIN,
        unsignedEnvelope,
        input.signingPrivateKey,
        runtime,
      ),
    });
    return { envelope, ciphertext, snapshotContentHash: snapshot.contentIntegrityHash };
  } finally {
    clearBytes(plaintext);
    if (compressedBytes) clearBytes(compressedBytes);
  }
};

export interface SnapshotAcceptanceContext {
  vaultId: string;
  keyEpoch: number;
  currentRevision: number;
  currentSnapshotHash: string | null;
  parentManifestHash: string;
  creatingDeviceId: string;
}

const assertAcceptanceContext = (
  envelope: EncryptedSnapshotEnvelopeV1,
  expected: SnapshotAcceptanceContext,
): void => {
  if (
    envelope.vaultId !== expected.vaultId ||
    envelope.keyEpoch !== expected.keyEpoch ||
    envelope.baseRevision !== expected.currentRevision ||
    envelope.revision !== expected.currentRevision + 1 ||
    envelope.previousSnapshotHash !== expected.currentSnapshotHash ||
    envelope.parentManifestHash !== expected.parentManifestHash ||
    envelope.creatingDeviceId !== expected.creatingDeviceId
  ) {
    throw new Error('Server je vratio stariju ili neočekivanu verziju podataka.');
  }
};

const parseEncryptedEnvelope = (value: unknown): EncryptedSnapshotEnvelopeV1 => {
  return encryptedSnapshotEnvelopeSchema.parse(value);
};

export interface OpenEncryptedSnapshotInput {
  envelope: unknown;
  ciphertext: Uint8Array;
  vaultMasterKey: Uint8Array;
  signingPublicKey: CryptoKey;
  expected: SnapshotAcceptanceContext;
}

export const openEncryptedSnapshot = async (
  input: OpenEncryptedSnapshotInput,
  runtime?: CryptoRuntime,
): Promise<SyncSnapshotV1> => {
  const envelope = parseEncryptedEnvelope(input.envelope);
  assertAcceptanceContext(envelope, input.expected);
  const ciphertext = copiedBytes(input.ciphertext);
  if (ciphertext.length !== envelope.ciphertextLength) {
    throw new Error('Dužina ciphertext-a snimka nije usaglašena.');
  }
  const ciphertextHash = bytesToBase64Url(await sha256(ciphertext, runtime));
  if (ciphertextHash !== envelope.ciphertextHash) {
    throw new Error('Ciphertext snimka nema očekivani hash.');
  }
  const { signature, ...unsignedEnvelope } = envelope;
  if (
    !(await verifyDomainSeparatedCanonicalSignature(
      SNAPSHOT_SIGNATURE_DOMAIN,
      unsignedEnvelope,
      signature,
      input.signingPublicKey,
      runtime,
    ))
  ) {
    throw new Error('Potpis snimka nije ispravan.');
  }
  const key = await deriveObjectEncryptionKey(
    input.vaultMasterKey,
    {
      vaultId: envelope.vaultId,
      keyEpoch: envelope.keyEpoch,
      objectType: 'snapshot',
      objectId: envelope.snapshotId,
      purpose: 'snapshot',
    },
    runtime,
  );
  let compressed: Uint8Array | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    compressed = await decryptAesGcm(
      ciphertext,
      key,
      base64UrlToBytes(envelope.nonce),
      envelope.aad,
      runtime,
    );
    plaintext = await decompressSnapshotBytes(compressed, envelope.compression);
    let decoded: unknown;
    try {
      decoded = JSON.parse(decodeUtf8(copiedBytes(plaintext)));
    } catch {
      throw new Error('Dešifrovani snimak nije validan kanonski JSON.');
    }
    const snapshot = await parseSyncSnapshot(decoded, runtime);
    const frontierHash = await computeSnapshotFrontierHash(snapshot.causalFrontier, runtime);
    if (
      snapshot.vaultId !== envelope.vaultId ||
      snapshot.snapshotId !== envelope.snapshotId ||
      snapshot.revision !== envelope.revision ||
      snapshot.baseRevision !== envelope.baseRevision ||
      snapshot.keyEpoch !== envelope.keyEpoch ||
      snapshot.creatingDeviceId !== envelope.creatingDeviceId ||
      snapshot.parentManifestHash !== envelope.parentManifestHash ||
      snapshot.previousSnapshotHash !== envelope.previousSnapshotHash ||
      frontierHash !== envelope.causalFrontierHash
    ) {
      throw new Error('Dešifrovani snimak nije vezan za svoj potpisani omot.');
    }
    return snapshot;
  } finally {
    clearBytes(ciphertext);
    if (compressed) clearBytes(compressed);
    if (plaintext) clearBytes(plaintext);
  }
};

export const hashEncryptedSnapshotEnvelope = (
  envelope: unknown,
  runtime?: CryptoRuntime,
): Promise<string> =>
  hashDomainSeparatedCanonical(
    SNAPSHOT_COMMIT_HASH_DOMAIN,
    parseEncryptedEnvelope(envelope),
    runtime,
  );
