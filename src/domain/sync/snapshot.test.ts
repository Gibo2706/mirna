/** Synthetic encrypted-snapshot fixtures. No production or user key material. */
import { beforeAll, describe, expect, it } from 'vitest';
import type { FinanceData } from '@/domain/types';
import { readmeDemoFixture } from '@/tests/fixtures/readmeDemoFixture';
import { canonicalizeJson } from './canonical';
import { generateDeviceKeyPairs, type DeviceKeyPairs } from './crypto';
import { base64UrlToBytes, bytesToBase64Url } from './encoding';
import {
  MAX_SNAPSHOT_COMPRESSION_RATIO,
  MAX_SNAPSHOT_DECOMPRESSED_BYTES,
  SYNC_SNAPSHOT_SCHEMA_VERSION,
  compressSnapshotBytes,
  computeSnapshotContentHash,
  createEncryptedSnapshot,
  createSyncFinanceData,
  createSyncSnapshot,
  decompressSnapshotBytes,
  encryptedSnapshotEnvelopeSchema,
  openEncryptedSnapshot,
  parseSyncSnapshot,
  prepareFinanceDataForSnapshotApply,
  type CreateSyncSnapshotInput,
  type EncryptedSnapshotEnvelopeV1,
  type SnapshotAcceptanceContext,
} from './snapshot';

const fixed = (length: number, start = 0): Uint8Array =>
  Uint8Array.from({ length }, (_value, index) => (start + index) & 255);

const vaultId = bytesToBase64Url(fixed(16, 1));
const snapshotId = bytesToBase64Url(fixed(16, 17));
const deviceId = bytesToBase64Url(fixed(16, 33));
const secondDeviceId = bytesToBase64Url(fixed(16, 49));
const parentManifestHash = bytesToBase64Url(fixed(32, 65));
const lastOperationHash = bytesToBase64Url(fixed(32, 97));
const vaultMasterKey = fixed(32, 129);
const createdAt = '2034-05-06T07:08:09.000Z';
const plaintextSentinel = 'SYNTHETIC_SNAPSHOT_PRIVATE_NOTE_7F3D';

const financialData = (): FinanceData => {
  const data = structuredClone(readmeDemoFixture.data);
  data.transactions[0].notes = plaintextSentinel;
  data.debtPayments.push({
    id: 'docs_debt_payment_external',
    debtId: data.debts[0].id,
    amount: 1_000,
    date: '2032-07-18',
    source: 'external',
    notes: 'Sintetička spoljna uplata',
    createdAt,
  });
  data.settings[0] = {
    ...data.settings[0],
    appearance: 'dark',
    lastBackupAt: '2034-05-01T00:00:00.000Z',
    installHintDismissed: true,
  };
  return data;
};

const snapshotInput = (data = financialData()): CreateSyncSnapshotInput => ({
  data,
  vaultId,
  snapshotId,
  revision: 1,
  baseRevision: 0,
  keyEpoch: 1,
  creatingDeviceId: deviceId,
  createdAt,
  parentManifestHash,
  previousSnapshotHash: null,
  causalFrontier: {
    serverCursor: 11,
    devices: [
      { deviceId: secondDeviceId, deviceSequence: 3, lastOperationHash },
      { deviceId, deviceSequence: 8, lastOperationHash },
    ],
  },
});

const acceptanceContext: SnapshotAcceptanceContext = {
  vaultId,
  keyEpoch: 1,
  currentRevision: 0,
  currentSnapshotHash: null,
  parentManifestHash,
  creatingDeviceId: deviceId,
};

describe('SyncSnapshotV1 client primitives', () => {
  let keys: DeviceKeyPairs;
  let envelope: EncryptedSnapshotEnvelopeV1;
  let ciphertext: Uint8Array;

  beforeAll(async () => {
    keys = await generateDeviceKeyPairs();
    const artifact = await createEncryptedSnapshot({
      ...snapshotInput(),
      vaultMasterKey,
      signingPrivateKey: keys.signing.privateKey,
      compression: 'gzip',
    });
    envelope = artifact.envelope;
    ciphertext = artifact.ciphertext;
  });

  it('round-trips a signed, compressed, object-key-encrypted snapshot', async () => {
    const snapshot = await openEncryptedSnapshot({
      envelope,
      ciphertext,
      vaultMasterKey,
      signingPublicKey: keys.signing.publicKey,
      expected: acceptanceContext,
    });

    expect(snapshot.data).toEqual(createSyncFinanceData(financialData()));
    expect(snapshot.contentIntegrityHash).toHaveLength(43);
    expect(envelope.compression).toBe('gzip');
    expect(envelope.ciphertextLength).toBe(ciphertext.length);
    expect(envelope.aad).toMatchObject({
      revision: 1,
      baseRevision: 0,
      creatingDeviceId: deviceId,
      parentManifestHash,
      previousSnapshotHash: null,
      causalFrontierHash: envelope.causalFrontierHash,
    });

    const readyToApply = await prepareFinanceDataForSnapshotApply(snapshot, {
      appearance: 'light',
      installHintDismissed: false,
      lastBackupAt: '2034-05-02T00:00:00.000Z',
    });
    expect(readyToApply.settings[0]).toMatchObject({
      appearance: 'light',
      installHintDismissed: false,
      lastBackupAt: '2034-05-02T00:00:00.000Z',
    });
  });

  it('includes all 13 finance stores and deterministically orders every record set', async () => {
    const input = snapshotInput();
    const first = await createSyncSnapshot(input);
    const reversedData: FinanceData = {
      accounts: [...input.data.accounts].reverse(),
      transactions: [...input.data.transactions].reverse(),
      categories: [...input.data.categories].reverse(),
      plannedIncomes: [...input.data.plannedIncomes].reverse(),
      commitments: [...input.data.commitments].reverse(),
      variableBudgets: [...input.data.variableBudgets].reverse(),
      goals: [...input.data.goals].reverse(),
      debts: [...input.data.debts].reverse(),
      debtPayments: [...input.data.debtPayments].reverse(),
      plannedEvents: [...input.data.plannedEvents].reverse(),
      presets: [...input.data.presets].reverse(),
      salaryScenarios: [...input.data.salaryScenarios].reverse(),
      settings: [...input.data.settings].reverse(),
    };
    const second = await createSyncSnapshot({ ...input, data: reversedData });

    const expectedStores = [
      'accounts',
      'transactions',
      'categories',
      'plannedIncomes',
      'commitments',
      'variableBudgets',
      'goals',
      'debts',
      'debtPayments',
      'plannedEvents',
      'presets',
      'salaryScenarios',
      'settings',
    ];
    expect(Object.keys(first.data)).toEqual(expectedStores);
    for (const store of expectedStores) {
      expect(first.data[store as keyof typeof first.data].length).toBeGreaterThan(0);
    }
    expect(canonicalizeJson(first)).toBe(canonicalizeJson(second));
  });

  it('rejects schema-valid records that violate existing cross-store finance integrity', async () => {
    const snapshot = await createSyncSnapshot(snapshotInput());
    const invalid = structuredClone(snapshot);
    invalid.data.settings[0].defaultAccountId = 'missing-account';
    const { contentIntegrityHash, ...body } = invalid;
    void contentIntegrityHash;
    invalid.contentIntegrityHash = await computeSnapshotContentHash(body);

    await expect(parseSyncSnapshot(invalid)).rejects.toThrow('Podrazumevani račun ne postoji');
  });

  it('rejects AAD modification before any plaintext can be accepted', async () => {
    const tampered = structuredClone(envelope);
    tampered.aad.causalFrontierHash = bytesToBase64Url(fixed(32, 201));
    expect(encryptedSnapshotEnvelopeSchema.safeParse(tampered).success).toBe(false);
    await expect(
      openEncryptedSnapshot({
        envelope: tampered,
        ciphertext,
        vaultMasterKey,
        signingPublicKey: keys.signing.publicKey,
        expected: acceptanceContext,
      }),
    ).rejects.toThrow();
  });

  it('rejects ciphertext and ciphertext-hash tampering', async () => {
    const tamperedCiphertext = ciphertext.slice();
    tamperedCiphertext[0] ^= 1;

    await expect(
      openEncryptedSnapshot({
        envelope,
        ciphertext: tamperedCiphertext,
        vaultMasterKey,
        signingPublicKey: keys.signing.publicKey,
        expected: acceptanceContext,
      }),
    ).rejects.toThrow('Ciphertext snimka nema očekivani hash');
  });

  it('rejects a modified low-S domain-separated envelope signature', async () => {
    const tampered = structuredClone(envelope);
    const signature = base64UrlToBytes(tampered.signature);
    signature[0] ^= 1;
    tampered.signature = bytesToBase64Url(signature);

    await expect(
      openEncryptedSnapshot({
        envelope: tampered,
        ciphertext,
        vaultMasterKey,
        signingPublicKey: keys.signing.publicKey,
        expected: acceptanceContext,
      }),
    ).rejects.toThrow('Potpis snimka nije ispravan');
  });

  it('rejects unknown envelope and plaintext versions without downgrade fallback', async () => {
    await expect(
      openEncryptedSnapshot({
        envelope: { ...envelope, protocolVersion: 2 },
        ciphertext,
        vaultMasterKey,
        signingPublicKey: keys.signing.publicKey,
        expected: acceptanceContext,
      }),
    ).rejects.toThrow();

    const snapshot = await createSyncSnapshot(snapshotInput());
    await expect(
      parseSyncSnapshot({ ...snapshot, snapshotSchemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION + 1 }),
    ).rejects.toThrow();
  });

  it('enforces streaming decompressed-size and compression-ratio guards', async () => {
    await expect(
      decompressSnapshotBytes(new Uint8Array(MAX_SNAPSHOT_DECOMPRESSED_BYTES + 1), 'none'),
    ).rejects.toThrow('prelazi dozvoljenu veličinu');

    const repetitive = new Uint8Array(1_024 * 1_024).fill(65);
    const compressed = await compressSnapshotBytes(repetitive, 'gzip');
    const compressedAgain = await compressSnapshotBytes(repetitive, 'gzip');
    expect(compressedAgain).toEqual(compressed);
    expect(repetitive.length / compressed.bytes.length).toBeGreaterThan(
      MAX_SNAPSHOT_COMPRESSION_RATIO,
    );
    await expect(decompressSnapshotBytes(compressed.bytes, 'gzip')).rejects.toThrow(
      'odnos kompresije',
    );
  });

  it('never serializes local settings, sync material, or known plaintext into the envelope', async () => {
    const serializedEnvelope = JSON.stringify(envelope);
    expect(serializedEnvelope).not.toContain(plaintextSentinel);
    expect(serializedEnvelope).not.toContain('lastBackupAt');
    expect(serializedEnvelope).not.toContain('installHintDismissed');
    expect(serializedEnvelope).not.toContain('appearance');

    const opened = await openEncryptedSnapshot({
      envelope,
      ciphertext,
      vaultMasterKey,
      signingPublicKey: keys.signing.publicKey,
      expected: acceptanceContext,
    });
    expect(opened.data.settings[0]).not.toHaveProperty('appearance');
    expect(opened.data.settings[0]).not.toHaveProperty('lastBackupAt');
    expect(opened.data.settings[0]).not.toHaveProperty('installHintDismissed');

    const inputWithSyncSecret = {
      ...financialData(),
      syncKeys: ['SYNTHETIC_PRIVATE_KEY_MUST_NOT_LEAK'],
    } as unknown as FinanceData;
    await expect(createSyncSnapshot(snapshotInput(inputWithSyncSecret))).rejects.toThrow(
      'Unrecognized key',
    );
  });

  it('rejects a content-integrity hash mismatch after strict plaintext parsing', async () => {
    const snapshot = await createSyncSnapshot(snapshotInput());
    const tampered = structuredClone(snapshot);
    tampered.data.transactions[0].description = 'Promenjen sadržaj';
    await expect(parseSyncSnapshot(tampered)).rejects.toThrow('nema očekivani integritet');
  });

  it('rejects tampered per-entity state even with a recomputed snapshot content hash', async () => {
    const snapshot = await createSyncSnapshot(snapshotInput());
    const tampered = structuredClone(snapshot);
    tampered.entityStates[0].stateHash = bytesToBase64Url(fixed(32, 211));
    const { contentIntegrityHash, ...body } = tampered;
    void contentIntegrityHash;
    tampered.contentIntegrityHash = await computeSnapshotContentHash(body);

    await expect(parseSyncSnapshot(tampered)).rejects.toThrow(
      'Snapshot entity state hash nije validan',
    );
  });
});
