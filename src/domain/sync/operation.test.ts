/** Synthetic protocol fixtures only. No production or user financial data. */
import { describe, expect, it } from 'vitest';
import type { CanonicalJson } from './canonical';
import { SYNC_CRYPTO_SUITE, SYNC_PROTOCOL_VERSION } from './constants';
import { generateDeviceKeyPairs, randomBytes, sha256 } from './crypto';
import { base64UrlToBytes, bytesToBase64Url } from './encoding';
import {
  assertOperationCiphertextHash,
  assertOperationEnvelopeMatches,
  assertOperationResultStateHash,
  createEncryptedOperation,
  hashEntityState,
  hashSyncOperation,
  nextLamportTime,
  openEncryptedOperation,
  operationResultStateHash,
  operationEnvelopeSignatureBody,
  parseOperationEnvelope,
  parseSyncOperation,
  protocolOperationDefaults,
  SYNC_FINANCIAL_ENTITY_TYPES,
  SYNC_OPERATION_COMMAND_TYPES,
  type SyncFinancialEntityType,
  type SyncOperationCommandType,
  type SyncOperationV1,
} from './operation';

const timestamp = '2026-07-31T10:00:00.000Z';
const opaque = (character: string): string => character.repeat(22);
const digest = (character = 'H'): string => character.repeat(43);

const entityValues: Record<SyncFinancialEntityType, Record<string, unknown>> = {
  account: {
    id: 'account-1',
    name: 'Tekući račun',
    kind: 'checking',
    openingBalance: 10_000,
    protected: false,
    color: '#123456',
    archived: false,
    createdAt: timestamp,
  },
  transaction: {
    id: 'transaction-1',
    type: 'expense',
    amount: 500,
    accountId: 'account-1',
    categoryId: 'category-1',
    date: '2026-07-31',
    description: 'Sintetička kupovina',
    source: 'manual',
    createdAt: timestamp,
  },
  category: {
    id: 'category-1',
    name: 'Hrana',
    kind: 'expense',
    icon: 'x',
    color: '#654321',
    archived: false,
  },
  'planned-income': {
    id: 'income-1',
    name: 'Plata',
    amount: 100_000,
    categoryId: 'category-income',
    accountId: 'account-1',
    frequency: 'monthly',
    startDate: '2026-07-01',
    active: true,
    isPrimarySalary: true,
    createdAt: timestamp,
  },
  commitment: {
    id: 'commitment-1',
    name: 'Račun',
    amount: 4_000,
    categoryId: 'category-1',
    accountId: 'account-1',
    frequency: 'monthly',
    startDate: '2026-07-01',
    dueDay: 15,
    active: true,
    createdAt: timestamp,
  },
  'variable-budget': {
    id: 'budget-1',
    name: 'Namirnice',
    defaultAmount: 20_000,
    categoryId: 'category-1',
    overrides: {},
    active: true,
    createdAt: timestamp,
  },
  goal: {
    id: 'goal-1',
    name: 'Rezerva',
    emoji: 'x',
    targetAmount: 100_000,
    linkedAccountId: 'account-savings',
    plannedMonthlyContribution: 10_000,
    contributionOverrides: {},
    goalType: 'reserve',
    archived: false,
    createdAt: timestamp,
  },
  debt: {
    id: 'debt-1',
    creditor: 'Sintetički poverilac',
    originalAmount: 50_000,
    priority: 'medium',
    status: 'open',
    paymentOverrides: {},
    createdAt: timestamp,
  },
  'debt-payment': {
    id: 'payment-1',
    debtId: 'debt-1',
    amount: 5_000,
    date: '2026-07-31',
    source: 'external',
    createdAt: timestamp,
  },
  'planned-event': {
    id: 'event-1',
    title: 'Registracija',
    date: '2026-09-01',
    plannedAmount: 30_000,
    categoryId: 'category-1',
    accountId: 'account-1',
    createdAt: timestamp,
  },
  'quick-add-preset': {
    id: 'preset-1',
    name: 'Kafa',
    emoji: 'x',
    type: 'expense',
    amount: 300,
    categoryId: 'category-1',
    defaultAccountId: 'account-1',
    position: 0,
    active: true,
  },
  'salary-scenario': {
    id: 'salary-1',
    name: 'Osnovni',
    monthlyAmount: 100_000,
    startMonth: '2026-07',
    createdAt: timestamp,
  },
  settings: {
    id: 'settings',
    onboardingCompleted: true,
    baseMonthlyIncome: 100_000,
    currency: 'RSD',
    locale: 'sr-Latn-RS',
    createdAt: timestamp,
    updatedAt: timestamp,
  },
};

const upsertCommandType = (entityType: SyncFinancialEntityType): SyncOperationCommandType =>
  `${entityType}.upsert` as SyncOperationCommandType;

const operationFor = (
  entityType: SyncFinancialEntityType,
  overrides: Record<string, unknown> = {},
): SyncOperationV1 => {
  const value = entityValues[entityType];
  return parseSyncOperation({
    ...protocolOperationDefaults,
    vaultId: opaque('V'),
    operationId: opaque('O'),
    mutationGroupId: opaque('G'),
    mutationGroupIndex: 0,
    mutationGroupSize: 1,
    deviceId: opaque('D'),
    deviceSequence: 1,
    lamportTime: 1,
    causalFrontier: [],
    command: {
      type: upsertCommandType(entityType),
      entityType,
      entityId: value.id,
      precondition: { entityVersion: 0, stateHash: null, tombstone: false },
      result: { entityVersion: 1, stateHash: digest(), tombstone: false },
      value,
      tombstone: null,
    },
    previousOperationHash: null,
    keyEpoch: 1,
    createdAt: timestamp,
    ...overrides,
  });
};

const deleteOperation = (): SyncOperationV1 =>
  parseSyncOperation({
    ...protocolOperationDefaults,
    vaultId: opaque('V'),
    operationId: opaque('X'),
    mutationGroupId: opaque('G'),
    mutationGroupIndex: 0,
    mutationGroupSize: 1,
    deviceId: opaque('D'),
    deviceSequence: 2,
    lamportTime: 2,
    causalFrontier: [{ deviceId: opaque('D'), deviceSequence: 1, operationHash: digest('P') }],
    command: {
      type: 'transaction.delete',
      entityType: 'transaction',
      entityId: 'transaction-1',
      precondition: { entityVersion: 1, stateHash: digest('S'), tombstone: false },
      result: { entityVersion: 2, stateHash: digest('T'), tombstone: true },
      value: null,
      tombstone: {
        entityType: 'transaction',
        entityId: 'transaction-1',
        entityVersion: 2,
        previousStateHash: digest('S'),
        deletionOperationId: opaque('X'),
        deletingDeviceId: opaque('D'),
        deviceSequence: 2,
        lamportTime: 2,
        causalFrontier: [{ deviceId: opaque('D'), deviceSequence: 1, operationHash: digest('P') }],
        deletedAt: timestamp,
      },
    },
    previousOperationHash: digest('P'),
    keyEpoch: 1,
    createdAt: timestamp,
  });

describe('SyncOperationV1 strict command model', () => {
  it.each(SYNC_FINANCIAL_ENTITY_TYPES)(
    'accepts the explicitly allowlisted %s upsert command',
    (entityType) => {
      const operation = operationFor(entityType);
      expect(operation.command.type).toBe(`${entityType}.upsert`);
      expect(operation.command.entityType).toBe(entityType);
    },
  );

  it('has no wildcard or arbitrary-patch command and permits deletion only where defined', () => {
    expect(SYNC_OPERATION_COMMAND_TYPES).toHaveLength(26);
    expect(
      SYNC_OPERATION_COMMAND_TYPES.some((command) => /patch|eval|script|table/iu.test(command)),
    ).toBe(false);
    expect(() =>
      parseSyncOperation({
        ...operationFor('account'),
        command: { ...operationFor('account').command, type: 'account.patch' },
      }),
    ).toThrow();
  });

  it('rejects mismatched command/entity identities and unknown entity fields', () => {
    const valid = operationFor('account');
    expect(() =>
      parseSyncOperation({
        ...valid,
        command: { ...valid.command, type: 'transaction.upsert' },
      }),
    ).toThrow(/Tip komande/u);
    expect(() =>
      parseSyncOperation({
        ...valid,
        command: { ...valid.command, entityId: 'another-account' },
      }),
    ).toThrow(/ID komande/u);
    expect(() =>
      parseSyncOperation({
        ...valid,
        command: {
          ...valid.command,
          value: { ...(valid.command.value as object), unrestrictedTable: 'syncKeys' },
        },
      }),
    ).toThrow(/nije validan/u);
  });

  it('rejects non-canonical numbers and secret-bearing/non-JSON objects', async () => {
    const valid = operationFor('account');
    expect(() =>
      parseSyncOperation({
        ...valid,
        command: {
          ...valid.command,
          value: { ...(valid.command.value as object), openingBalance: -0 },
        },
      }),
    ).toThrow(/kanonski/u);

    const secret = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
    ]);
    expect(() =>
      parseSyncOperation({
        ...valid,
        command: { ...valid.command, value: secret },
      }),
    ).toThrow(/kanonski/u);
    expect(() => parseSyncOperation({ ...valid, signingPrivateKey: secret })).toThrow();
  });

  it('rejects a decrypted operation that cannot fit the 64 KiB encrypted envelope', () => {
    const valid = operationFor('account');
    expect(() =>
      parseSyncOperation({
        ...valid,
        command: {
          ...valid.command,
          value: { ...(valid.command.value as object), name: 'x'.repeat(65_536) },
        },
      }),
    ).toThrow(/prevelika/u);
  });

  it('requires exact version increments and a direct per-device previous-operation chain', () => {
    const valid = operationFor('transaction');
    expect(() =>
      parseSyncOperation({
        ...valid,
        command: {
          ...valid.command,
          result: { ...valid.command.result, entityVersion: 2 },
        },
      }),
    ).toThrow(/tačno za jedan/u);
    expect(() =>
      parseSyncOperation({ ...valid, deviceSequence: 2, previousOperationHash: null }),
    ).toThrow(/direktno vezati/u);
    expect(() =>
      parseSyncOperation({
        ...valid,
        previousOperationHash: digest('P'),
      }),
    ).toThrow(/Prva operacija/u);
  });

  it('binds a deletion tombstone to operation, causal frontier and entity version', () => {
    const valid = deleteOperation();
    expect(valid.command.tombstone?.entityVersion).toBe(2);
    expect(() =>
      parseSyncOperation({
        ...valid,
        command: {
          ...valid.command,
          tombstone: { ...valid.command.tombstone!, deletionOperationId: opaque('Z') },
        },
      }),
    ).toThrow(/Tombstone/u);
    expect(() =>
      parseSyncOperation({
        ...valid,
        command: {
          ...valid.command,
          precondition: { entityVersion: 0, stateHash: null, tombstone: false },
          result: { ...valid.command.result, entityVersion: 1 },
          tombstone: {
            ...valid.command.tombstone!,
            entityVersion: 1,
            previousStateHash: digest('S'),
          },
        },
      }),
    ).toThrow(/Delete zahteva/u);
  });

  it('sorts/requires unique causal frontier entries and advances Lamport time safely', () => {
    const valid = operationFor('account');
    expect(() =>
      parseSyncOperation({
        ...valid,
        causalFrontier: [
          { deviceId: opaque('Z'), deviceSequence: 1, operationHash: digest('A') },
          { deviceId: opaque('A'), deviceSequence: 1, operationHash: digest('B') },
        ],
      }),
    ).toThrow(/sortiran/u);
    expect(nextLamportTime(1, 9, 3)).toBe(10);
    expect(() => nextLamportTime(Number.MAX_SAFE_INTEGER)).toThrow(/iscrpljeno/u);
    expect(() => nextLamportTime(1.5)).toThrow(/ceo broj/u);
  });

  it('hashes canonical operations and entity states deterministically', async () => {
    const operation = operationFor('account');
    await expect(hashSyncOperation(operation)).resolves.toHaveLength(43);
    await expect(hashSyncOperation(operation)).resolves.toBe(await hashSyncOperation(operation));
    await expect(
      hashEntityState({
        entityType: 'account',
        entityId: 'account-1',
        entityVersion: 1,
        value: entityValues.account as CanonicalJson,
        tombstone: null,
      }),
    ).resolves.toHaveLength(43);
  });

  it('verifies that the declared resulting state hash matches the decrypted proposal', async () => {
    const operation = operationFor('account');
    const validHash = await operationResultStateHash(operation);
    const valid = parseSyncOperation({
      ...operation,
      command: {
        ...operation.command,
        result: { ...operation.command.result, stateHash: validHash },
      },
    });
    await expect(assertOperationResultStateHash(valid)).resolves.toBeUndefined();
    await expect(assertOperationResultStateHash(operation)).rejects.toThrow(/state hash/u);
  });
});

describe('signed encrypted operation envelope metadata', () => {
  const makeEnvelope = async () => {
    const ciphertextBytes = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);
    const ciphertext = bytesToBase64Url(ciphertextBytes);
    const ciphertextHash = bytesToBase64Url(await sha256(ciphertextBytes));
    const operation = operationFor('transaction');
    const metadata = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      suite: SYNC_CRYPTO_SUITE,
      vaultId: operation.vaultId,
      operationId: operation.operationId,
      deviceId: operation.deviceId,
      deviceSequence: operation.deviceSequence,
      keyEpoch: operation.keyEpoch,
      ciphertextLength: ciphertextBytes.length,
    };
    return {
      operation,
      envelope: {
        type: 'mirna-operation-envelope-v1' as const,
        ...metadata,
        nonce: 'N'.repeat(16),
        aad: { type: 'mirna-operation-envelope-aad-v1' as const, ...metadata },
        ciphertext,
        ciphertextHash,
        signature: 'S'.repeat(86),
      },
    };
  };

  it('contains only opaque ordering/authentication metadata outside ciphertext', async () => {
    const { envelope } = await makeEnvelope();
    expect(parseOperationEnvelope(envelope)).toEqual(envelope);
    expect(envelope).not.toHaveProperty('entityType');
    expect(envelope).not.toHaveProperty('command');
    expect(envelope.aad).not.toHaveProperty('createdAt');
    expect(operationEnvelopeSignatureBody(envelope)).not.toHaveProperty('signature');
    await expect(assertOperationCiphertextHash(envelope)).resolves.toBeUndefined();
  });

  it('rejects ciphertext length/hash tampering and AAD/decrypted metadata substitution', async () => {
    const { operation, envelope } = await makeEnvelope();
    expect(() => assertOperationEnvelopeMatches(envelope, operation)).not.toThrow();
    expect(() =>
      parseOperationEnvelope({ ...envelope, ciphertextLength: envelope.ciphertextLength + 1 }),
    ).toThrow(/dužina/u);
    expect(() =>
      parseOperationEnvelope({
        ...envelope,
        aad: { ...envelope.aad, operationId: opaque('Q') },
      }),
    ).toThrow(/AAD/u);
    await expect(
      assertOperationCiphertextHash({ ...envelope, ciphertextHash: digest('Z') }),
    ).rejects.toThrow(/Hash šifrata/u);
    expect(() =>
      assertOperationEnvelopeMatches(envelope, {
        ...operation,
        operationId: opaque('Q'),
      }),
    ).toThrow(/ne odgovara/u);
  });

  it('encrypts, signs and opens an operation while rejecting key, signature and ciphertext tampering', async () => {
    const provisional = operationFor('account');
    const operation = parseSyncOperation({
      ...provisional,
      command: {
        ...provisional.command,
        result: {
          ...provisional.command.result,
          stateHash: await operationResultStateHash(provisional),
        },
      },
    });
    const deviceKeys = await generateDeviceKeyPairs();
    const vaultMasterKey = randomBytes(32);
    const envelope = await createEncryptedOperation({
      operation,
      vaultMasterKey,
      signingPrivateKey: deviceKeys.signing.privateKey,
    });

    await expect(
      openEncryptedOperation({
        envelope,
        vaultMasterKey,
        signingPublicKey: deviceKeys.signing.publicKey,
        expected: {
          vaultId: operation.vaultId,
          keyEpoch: operation.keyEpoch,
          deviceId: operation.deviceId,
        },
      }),
    ).resolves.toEqual(operation);

    const changedCiphertext = base64UrlToBytes(envelope.ciphertext);
    changedCiphertext[0] = (changedCiphertext[0] ?? 0) ^ 1;
    await expect(
      openEncryptedOperation({
        envelope: { ...envelope, ciphertext: bytesToBase64Url(changedCiphertext) },
        vaultMasterKey,
        signingPublicKey: deviceKeys.signing.publicKey,
        expected: {
          vaultId: operation.vaultId,
          keyEpoch: operation.keyEpoch,
          deviceId: operation.deviceId,
        },
      }),
    ).rejects.toThrow(/Hash šifrata/u);

    const otherDeviceKeys = await generateDeviceKeyPairs();
    await expect(
      openEncryptedOperation({
        envelope,
        vaultMasterKey,
        signingPublicKey: otherDeviceKeys.signing.publicKey,
        expected: {
          vaultId: operation.vaultId,
          keyEpoch: operation.keyEpoch,
          deviceId: operation.deviceId,
        },
      }),
    ).rejects.toThrow(/Potpis/u);
    await expect(
      openEncryptedOperation({
        envelope,
        vaultMasterKey: randomBytes(32),
        signingPublicKey: deviceKeys.signing.publicKey,
        expected: {
          vaultId: operation.vaultId,
          keyEpoch: operation.keyEpoch,
          deviceId: operation.deviceId,
        },
      }),
    ).rejects.toThrow();
  });
});
