import { z } from 'zod';
import {
  accountSchema,
  categorySchema,
  commitmentSchema,
  debtPaymentSchema,
  debtSchema,
  goalSchema,
  plannedEventSchema,
  plannedIncomeSchema,
  presetSchema,
  salaryScenarioSchema,
  syncedAppSettingsSchema,
  transactionSchema,
  variableBudgetSchema,
} from '../schemas';
import { canonicalBytes, canonicalizeJson, type CanonicalJson } from './canonical';
import {
  SYNC_CRYPTO_SUITE,
  SYNC_LIMITS,
  SYNC_PROTOCOL_VERSION,
  SYNC_TRANSCRIPT_TYPES,
} from './constants';
import {
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
  cryptoSuiteSchema,
  opaqueIdSchema,
  protocolVersionSchema,
  sha256Schema,
  signatureSchema,
  timestampSchema,
} from './schemas';

export const SYNC_OPERATION_DOMAIN = 'MIRNA-E2EE-V1/sync-operation' as const;
export const SYNC_ENTITY_STATE_DOMAIN = 'MIRNA-E2EE-V1/sync-entity-state' as const;
export const SYNC_OPERATION_ENVELOPE_SIGNATURE_DOMAIN =
  'MIRNA-E2EE-V1/operation-envelope-signature' as const;

export const SYNC_FINANCIAL_ENTITY_TYPES = [
  'account',
  'transaction',
  'category',
  'planned-income',
  'commitment',
  'variable-budget',
  'goal',
  'debt',
  'debt-payment',
  'planned-event',
  'quick-add-preset',
  'salary-scenario',
  'settings',
] as const;

export type SyncFinancialEntityType = (typeof SYNC_FINANCIAL_ENTITY_TYPES)[number];

export const SYNC_OPERATION_COMMAND_TYPES = [
  'account.upsert',
  'account.delete',
  'transaction.upsert',
  'transaction.delete',
  'category.upsert',
  'category.delete',
  'planned-income.upsert',
  'planned-income.delete',
  'commitment.upsert',
  'commitment.delete',
  'variable-budget.upsert',
  'variable-budget.delete',
  'goal.upsert',
  'goal.delete',
  'debt.upsert',
  'debt.delete',
  'debt-payment.upsert',
  'debt-payment.delete',
  'planned-event.upsert',
  'planned-event.delete',
  'quick-add-preset.upsert',
  'quick-add-preset.delete',
  'salary-scenario.upsert',
  'salary-scenario.delete',
  'settings.upsert',
  'settings.delete',
] as const;

export type SyncOperationCommandType = (typeof SYNC_OPERATION_COMMAND_TYPES)[number];

const safeSequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSafeSequenceSchema = safeSequenceSchema.positive();
const entityIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      Array.from(value).every((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
      }),
    'ID entiteta sadrži kontrolni znak.',
  );

const canonicalJsonSchema = z.custom<CanonicalJson>((value) => {
  try {
    canonicalizeJson(value);
    return true;
  } catch {
    return false;
  }
}, 'Komandni sadržaj mora biti kanonski I-JSON.');

export const causalFrontierEntrySchema = z.strictObject({
  deviceId: opaqueIdSchema,
  deviceSequence: positiveSafeSequenceSchema,
  operationHash: sha256Schema,
});

export const causalFrontierSchema = z
  .array(causalFrontierEntrySchema)
  .max(10)
  .superRefine((frontier, context) => {
    for (let index = 1; index < frontier.length; index += 1) {
      if (frontier[index - 1].deviceId >= frontier[index].deviceId) {
        context.addIssue({
          code: 'custom',
          path: [index, 'deviceId'],
          message: 'Causal frontier mora biti strogo sortiran i bez duplikata uređaja.',
        });
      }
    }
  });

export type CausalFrontierEntryV1 = z.infer<typeof causalFrontierEntrySchema>;
export type CausalFrontierV1 = z.infer<typeof causalFrontierSchema>;

export const entityPreconditionSchema = z
  .strictObject({
    entityVersion: safeSequenceSchema,
    stateHash: sha256Schema.nullable(),
    tombstone: z.boolean(),
  })
  .superRefine((precondition, context) => {
    if (precondition.entityVersion === 0) {
      if (precondition.stateHash !== null || precondition.tombstone) {
        context.addIssue({
          code: 'custom',
          message: 'Nepostojeći entitet mora imati nultu verziju bez state hash-a i tombstone-a.',
        });
      }
      return;
    }
    if (precondition.stateHash === null) {
      context.addIssue({
        code: 'custom',
        path: ['stateHash'],
        message: 'Postojeća verzija entiteta mora imati state hash.',
      });
    }
  });

export const entityResultSchema = z.strictObject({
  entityVersion: positiveSafeSequenceSchema,
  stateHash: sha256Schema,
  tombstone: z.boolean(),
});

export const operationTombstoneSchema = z.strictObject({
  entityType: z.enum(SYNC_FINANCIAL_ENTITY_TYPES),
  entityId: entityIdSchema,
  entityVersion: positiveSafeSequenceSchema,
  previousStateHash: sha256Schema,
  deletionOperationId: opaqueIdSchema,
  deletingDeviceId: opaqueIdSchema,
  deviceSequence: positiveSafeSequenceSchema,
  lamportTime: positiveSafeSequenceSchema,
  causalFrontier: causalFrontierSchema,
  deletedAt: timestampSchema,
});

interface CommandDescriptor {
  readonly entityType: SyncFinancialEntityType;
  readonly action: 'upsert' | 'delete';
}

const COMMAND_DESCRIPTORS = {
  'account.upsert': { entityType: 'account', action: 'upsert' },
  'account.delete': { entityType: 'account', action: 'delete' },
  'transaction.upsert': { entityType: 'transaction', action: 'upsert' },
  'transaction.delete': { entityType: 'transaction', action: 'delete' },
  'category.upsert': { entityType: 'category', action: 'upsert' },
  'category.delete': { entityType: 'category', action: 'delete' },
  'planned-income.upsert': { entityType: 'planned-income', action: 'upsert' },
  'planned-income.delete': { entityType: 'planned-income', action: 'delete' },
  'commitment.upsert': { entityType: 'commitment', action: 'upsert' },
  'commitment.delete': { entityType: 'commitment', action: 'delete' },
  'variable-budget.upsert': { entityType: 'variable-budget', action: 'upsert' },
  'variable-budget.delete': { entityType: 'variable-budget', action: 'delete' },
  'goal.upsert': { entityType: 'goal', action: 'upsert' },
  'goal.delete': { entityType: 'goal', action: 'delete' },
  'debt.upsert': { entityType: 'debt', action: 'upsert' },
  'debt.delete': { entityType: 'debt', action: 'delete' },
  'debt-payment.upsert': { entityType: 'debt-payment', action: 'upsert' },
  'debt-payment.delete': { entityType: 'debt-payment', action: 'delete' },
  'planned-event.upsert': { entityType: 'planned-event', action: 'upsert' },
  'planned-event.delete': { entityType: 'planned-event', action: 'delete' },
  'quick-add-preset.upsert': { entityType: 'quick-add-preset', action: 'upsert' },
  'quick-add-preset.delete': { entityType: 'quick-add-preset', action: 'delete' },
  'salary-scenario.upsert': { entityType: 'salary-scenario', action: 'upsert' },
  'salary-scenario.delete': { entityType: 'salary-scenario', action: 'delete' },
  'settings.upsert': { entityType: 'settings', action: 'upsert' },
  'settings.delete': { entityType: 'settings', action: 'delete' },
} as const satisfies Record<SyncOperationCommandType, CommandDescriptor>;

const ENTITY_SCHEMAS = {
  account: accountSchema.strict(),
  transaction: transactionSchema.strict(),
  category: categorySchema.strict(),
  'planned-income': plannedIncomeSchema.strict(),
  commitment: commitmentSchema.strict(),
  'variable-budget': variableBudgetSchema.strict(),
  goal: goalSchema.strict(),
  debt: debtSchema.strict(),
  'debt-payment': debtPaymentSchema.strict(),
  'planned-event': plannedEventSchema.strict(),
  'quick-add-preset': presetSchema.strict(),
  'salary-scenario': salaryScenarioSchema.strict(),
  settings: syncedAppSettingsSchema,
} as const satisfies Record<SyncFinancialEntityType, z.ZodType>;

export const syncCommandSchema = z
  .strictObject({
    type: z.enum(SYNC_OPERATION_COMMAND_TYPES),
    entityType: z.enum(SYNC_FINANCIAL_ENTITY_TYPES),
    entityId: entityIdSchema,
    precondition: entityPreconditionSchema,
    result: entityResultSchema,
    value: canonicalJsonSchema.nullable(),
    tombstone: operationTombstoneSchema.nullable(),
  })
  .superRefine((command, context) => {
    const descriptor = COMMAND_DESCRIPTORS[command.type];
    if (command.entityType !== descriptor.entityType) {
      context.addIssue({
        code: 'custom',
        path: ['entityType'],
        message: 'Tip komande nije dozvoljen za navedeni tip entiteta.',
      });
    }
    if (command.result.entityVersion !== command.precondition.entityVersion + 1) {
      context.addIssue({
        code: 'custom',
        path: ['result', 'entityVersion'],
        message: 'Rezultat mora povećati verziju entiteta tačno za jedan.',
      });
    }

    if (descriptor.action === 'upsert') {
      if (command.value === null || command.tombstone !== null || command.result.tombstone) {
        context.addIssue({
          code: 'custom',
          message: 'Upsert mora imati vrednost i ne sme proizvesti tombstone.',
        });
        return;
      }
      const entityResult = ENTITY_SCHEMAS[descriptor.entityType].safeParse(command.value);
      if (!entityResult.success) {
        context.addIssue({
          code: 'custom',
          path: ['value'],
          message: `Komandni sadržaj nije validan ${descriptor.entityType} entitet.`,
        });
        return;
      }
      const parsedEntity = entityResult.data as { id?: unknown };
      if (parsedEntity.id !== command.entityId) {
        context.addIssue({
          code: 'custom',
          path: ['entityId'],
          message: 'ID komande i ID sadržaja entiteta moraju biti isti.',
        });
      }
      return;
    }

    if (
      command.value !== null ||
      command.tombstone === null ||
      !command.result.tombstone ||
      command.precondition.entityVersion === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Delete zahteva postojeći živi entitet i mora proizvesti tombstone.',
      });
    }
  });

export type EntityPreconditionV1 = z.infer<typeof entityPreconditionSchema>;
export type EntityResultV1 = z.infer<typeof entityResultSchema>;
export type OperationTombstoneV1 = z.infer<typeof operationTombstoneSchema>;
export type SyncCommandV1 = z.infer<typeof syncCommandSchema>;

export const syncOperationSchema = z
  .strictObject({
    type: z.literal('mirna-sync-operation-v1'),
    protocolVersion: protocolVersionSchema,
    suite: cryptoSuiteSchema,
    vaultId: opaqueIdSchema,
    operationId: opaqueIdSchema,
    mutationGroupId: opaqueIdSchema,
    mutationGroupIndex: z.number().int().nonnegative().max(999),
    mutationGroupSize: z.number().int().positive().max(1_000),
    deviceId: opaqueIdSchema,
    deviceSequence: positiveSafeSequenceSchema,
    lamportTime: positiveSafeSequenceSchema,
    causalFrontier: causalFrontierSchema,
    resolvesOperationIds: z
      .array(opaqueIdSchema)
      .min(1)
      .max(20)
      .refine(
        (operationIds) =>
          new Set(operationIds).size === operationIds.length &&
          operationIds.every((operationId, index) =>
            index === 0 ? true : operationIds[index - 1] < operationId,
          ),
        'Reference razrešenih operacija moraju biti jedinstvene i sortirane.',
      )
      .optional(),
    command: syncCommandSchema,
    previousOperationHash: sha256Schema.nullable(),
    keyEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    createdAt: timestampSchema,
  })
  .superRefine((operation, context) => {
    if (operation.mutationGroupIndex >= operation.mutationGroupSize) {
      context.addIssue({
        code: 'custom',
        path: ['mutationGroupIndex'],
        message: 'Indeks operacije mora biti unutar mutation grupe.',
      });
    }
    const ownPredecessor = operation.causalFrontier.find(
      (entry) => entry.deviceId === operation.deviceId,
    );
    if (operation.deviceSequence === 1) {
      if (operation.previousOperationHash !== null || ownPredecessor) {
        context.addIssue({
          code: 'custom',
          message: 'Prva operacija uređaja ne sme imati prethodni hash ni sopstveni frontier.',
        });
      }
    } else if (
      operation.previousOperationHash === null ||
      ownPredecessor?.deviceSequence !== operation.deviceSequence - 1 ||
      ownPredecessor.operationHash !== operation.previousOperationHash
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Operacija mora direktno vezati prethodnu operaciju svog uređaja.',
      });
    }

    const tombstone = operation.command.tombstone;
    if (
      tombstone &&
      (tombstone.entityType !== operation.command.entityType ||
        tombstone.entityId !== operation.command.entityId ||
        tombstone.entityVersion !== operation.command.result.entityVersion ||
        tombstone.previousStateHash !== operation.command.precondition.stateHash ||
        tombstone.deletionOperationId !== operation.operationId ||
        tombstone.deletingDeviceId !== operation.deviceId ||
        tombstone.deviceSequence !== operation.deviceSequence ||
        tombstone.lamportTime !== operation.lamportTime ||
        tombstone.deletedAt !== operation.createdAt ||
        canonicalizeJson(tombstone.causalFrontier) !== canonicalizeJson(operation.causalFrontier))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['command', 'tombstone'],
        message: 'Tombstone causal/version metapodaci nisu vezani za operaciju brisanja.',
      });
    }
  });

export type SyncOperationV1 = z.infer<typeof syncOperationSchema>;

export const operationEnvelopeAadSchema = z.strictObject({
  type: z.literal('mirna-operation-envelope-aad-v1'),
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  vaultId: opaqueIdSchema,
  operationId: opaqueIdSchema,
  deviceId: opaqueIdSchema,
  deviceSequence: positiveSafeSequenceSchema,
  keyEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ciphertextLength: z.number().int().min(16).max(SYNC_LIMITS.maxOperationBytes),
});

export const unsignedOperationEnvelopeSchema = z.strictObject({
  type: z.literal(SYNC_TRANSCRIPT_TYPES.operationEnvelope),
  protocolVersion: protocolVersionSchema,
  suite: cryptoSuiteSchema,
  vaultId: opaqueIdSchema,
  operationId: opaqueIdSchema,
  deviceId: opaqueIdSchema,
  deviceSequence: positiveSafeSequenceSchema,
  keyEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ciphertextLength: z.number().int().min(16).max(SYNC_LIMITS.maxOperationBytes),
  nonce: aesGcmNonceSchema,
  aad: operationEnvelopeAadSchema,
  ciphertext: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/u)
    .min(22)
    .max(87_382),
  ciphertextHash: sha256Schema,
});

export const operationEnvelopeSchema = unsignedOperationEnvelopeSchema.extend({
  signature: signatureSchema,
});

export const acceptedOperationEnvelopeSchema = operationEnvelopeSchema.extend({
  serverCursor: positiveSafeSequenceSchema,
});

export const operationUploadRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  envelope: operationEnvelopeSchema,
});

export const operationUploadResponseSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  operationId: opaqueIdSchema,
  serverCursor: positiveSafeSequenceSchema,
  accepted: z.literal(true),
});

export const operationChangesResponseSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  changes: z.array(acceptedOperationEnvelopeSchema).max(SYNC_LIMITS.maxOperationsPerBatch),
  nextCursor: safeSequenceSchema,
  hasMore: z.boolean(),
});

export const deviceAcknowledgementRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  acknowledgedServerCursor: safeSequenceSchema,
  causalFrontierHash: sha256Schema,
  acknowledgedSnapshotId: opaqueIdSchema.nullable(),
  acknowledgedSnapshotRevision: safeSequenceSchema,
});

export const deviceAcknowledgementResponseSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  acknowledgedServerCursor: safeSequenceSchema,
  accepted: z.literal(true),
});

export type OperationEnvelopeAadV1 = z.infer<typeof operationEnvelopeAadSchema>;
export type UnsignedOperationEnvelopeV1 = z.infer<typeof unsignedOperationEnvelopeSchema>;
export type OperationEnvelopeV1 = z.infer<typeof operationEnvelopeSchema>;
export type AcceptedOperationEnvelopeV1 = z.infer<typeof acceptedOperationEnvelopeSchema>;
export type OperationChangesResponseV1 = z.infer<typeof operationChangesResponseSchema>;

export const parseSyncOperation = (value: unknown): SyncOperationV1 => {
  const parsed = syncOperationSchema.parse(value);
  const encoded = canonicalBytes(parsed);
  if (encoded.length + 16 > SYNC_LIMITS.maxOperationBytes) {
    throw new Error('Kanonska operacija je prevelika za dozvoljeni šifrovani envelope.');
  }
  return parsed;
};

export const parseOperationEnvelope = (value: unknown): OperationEnvelopeV1 => {
  const parsed = operationEnvelopeSchema.parse(value);
  const ciphertextLength = base64UrlToBytes(parsed.ciphertext).length;
  if (
    ciphertextLength !== parsed.ciphertextLength ||
    ciphertextLength > SYNC_LIMITS.maxOperationBytes
  ) {
    throw new Error('Deklarisana i stvarna dužina šifrata operacije se ne poklapaju.');
  }
  const aad = parsed.aad;
  if (
    aad.protocolVersion !== parsed.protocolVersion ||
    aad.suite !== parsed.suite ||
    aad.vaultId !== parsed.vaultId ||
    aad.operationId !== parsed.operationId ||
    aad.deviceId !== parsed.deviceId ||
    aad.deviceSequence !== parsed.deviceSequence ||
    aad.keyEpoch !== parsed.keyEpoch ||
    aad.ciphertextLength !== parsed.ciphertextLength
  ) {
    throw new Error('AAD i javni metapodaci envelope-a operacije se ne poklapaju.');
  }
  canonicalizeJson(parsed);
  return parsed;
};

export const assertOperationEnvelopeMatches = (
  envelope: OperationEnvelopeV1,
  operation: SyncOperationV1,
): void => {
  const parsedEnvelope = parseOperationEnvelope(envelope);
  const parsedOperation = parseSyncOperation(operation);
  if (
    parsedEnvelope.protocolVersion !== parsedOperation.protocolVersion ||
    parsedEnvelope.suite !== parsedOperation.suite ||
    parsedEnvelope.vaultId !== parsedOperation.vaultId ||
    parsedEnvelope.operationId !== parsedOperation.operationId ||
    parsedEnvelope.deviceId !== parsedOperation.deviceId ||
    parsedEnvelope.deviceSequence !== parsedOperation.deviceSequence ||
    parsedEnvelope.keyEpoch !== parsedOperation.keyEpoch
  ) {
    throw new Error('Dešifrovana operacija ne odgovara potpisanom envelope-u.');
  }
};

export const assertOperationCiphertextHash = async (
  envelope: OperationEnvelopeV1,
  runtime?: CryptoRuntime,
): Promise<void> => {
  const parsed = parseOperationEnvelope(envelope);
  const actualHash = bytesToBase64Url(await sha256(base64UrlToBytes(parsed.ciphertext), runtime));
  if (actualHash !== parsed.ciphertextHash) {
    throw new Error('Hash šifrata operacije nije validan.');
  }
};

export const operationEnvelopeSignatureBody = (
  envelope: OperationEnvelopeV1,
): UnsignedOperationEnvelopeV1 => {
  const { signature, ...unsigned } = parseOperationEnvelope(envelope);
  void signature;
  return unsignedOperationEnvelopeSchema.parse(unsigned);
};

export const hashSyncOperation = (
  operation: SyncOperationV1,
  runtime?: CryptoRuntime,
): Promise<string> =>
  hashDomainSeparatedCanonical(SYNC_OPERATION_DOMAIN, parseSyncOperation(operation), runtime);

export const hashEntityState = (
  input: {
    entityType: SyncFinancialEntityType;
    entityId: string;
    entityVersion: number;
    value: CanonicalJson | null;
    tombstone: OperationTombstoneV1 | null;
  },
  runtime?: CryptoRuntime,
): Promise<string> => hashDomainSeparatedCanonical(SYNC_ENTITY_STATE_DOMAIN, input, runtime);

export const operationResultStateHash = (
  operationInput: SyncOperationV1,
  runtime?: CryptoRuntime,
): Promise<string> => {
  const operation = parseSyncOperation(operationInput);
  return hashEntityState(
    {
      entityType: operation.command.entityType,
      entityId: operation.command.entityId,
      entityVersion: operation.command.result.entityVersion,
      value: operation.command.value,
      tombstone: operation.command.tombstone,
    },
    runtime,
  );
};

export const assertOperationResultStateHash = async (
  operationInput: SyncOperationV1,
  runtime?: CryptoRuntime,
): Promise<void> => {
  const operation = parseSyncOperation(operationInput);
  if ((await operationResultStateHash(operation, runtime)) !== operation.command.result.stateHash) {
    throw new Error('Resulting state hash operacije nije validan.');
  }
};

export const createEncryptedOperation = async (
  input: {
    operation: SyncOperationV1;
    vaultMasterKey: Uint8Array;
    signingPrivateKey: CryptoKey;
  },
  runtime?: CryptoRuntime,
): Promise<OperationEnvelopeV1> => {
  const operation = parseSyncOperation(input.operation);
  const plaintext = canonicalBytes(operation);
  const ciphertextLength = plaintext.byteLength + 16;
  const aad = operationEnvelopeAadSchema.parse({
    type: 'mirna-operation-envelope-aad-v1',
    protocolVersion: operation.protocolVersion,
    suite: operation.suite,
    vaultId: operation.vaultId,
    operationId: operation.operationId,
    deviceId: operation.deviceId,
    deviceSequence: operation.deviceSequence,
    keyEpoch: operation.keyEpoch,
    ciphertextLength,
  });
  const nonce = randomBytes(SYNC_LIMITS.aesGcmNonceBytes, runtime);
  const key = await deriveObjectEncryptionKey(
    input.vaultMasterKey,
    {
      vaultId: operation.vaultId,
      keyEpoch: operation.keyEpoch,
      objectType: 'operation',
      objectId: operation.operationId,
      purpose: 'operation',
    },
    runtime,
  );
  let ciphertext: Uint8Array | undefined;
  try {
    ciphertext = await encryptAesGcm(plaintext, key, nonce, aad, runtime);
    const unsigned = unsignedOperationEnvelopeSchema.parse({
      type: SYNC_TRANSCRIPT_TYPES.operationEnvelope,
      protocolVersion: operation.protocolVersion,
      suite: operation.suite,
      vaultId: operation.vaultId,
      operationId: operation.operationId,
      deviceId: operation.deviceId,
      deviceSequence: operation.deviceSequence,
      keyEpoch: operation.keyEpoch,
      ciphertextLength: ciphertext.byteLength,
      nonce: bytesToBase64Url(nonce),
      aad,
      ciphertext: bytesToBase64Url(ciphertext),
      ciphertextHash: bytesToBase64Url(await sha256(ciphertext, runtime)),
    });
    return operationEnvelopeSchema.parse({
      ...unsigned,
      signature: await signDomainSeparatedCanonical(
        SYNC_OPERATION_ENVELOPE_SIGNATURE_DOMAIN,
        unsigned,
        input.signingPrivateKey,
        runtime,
      ),
    });
  } finally {
    clearBytes(plaintext, nonce);
    if (ciphertext) clearBytes(ciphertext);
  }
};

export const openEncryptedOperation = async (
  input: {
    envelope: OperationEnvelopeV1;
    vaultMasterKey: Uint8Array;
    signingPublicKey: CryptoKey;
    expected: {
      vaultId: string;
      keyEpoch: number;
      deviceId: string;
    };
  },
  runtime?: CryptoRuntime,
): Promise<SyncOperationV1> => {
  const envelope = parseOperationEnvelope(input.envelope);
  if (
    envelope.vaultId !== input.expected.vaultId ||
    envelope.keyEpoch !== input.expected.keyEpoch ||
    envelope.deviceId !== input.expected.deviceId
  ) {
    throw new Error('Envelope operacije ne odgovara očekivanom sync kontekstu.');
  }
  await assertOperationCiphertextHash(envelope, runtime);
  if (
    !(await verifyDomainSeparatedCanonicalSignature(
      SYNC_OPERATION_ENVELOPE_SIGNATURE_DOMAIN,
      operationEnvelopeSignatureBody(envelope),
      envelope.signature,
      input.signingPublicKey,
      runtime,
    ))
  ) {
    throw new Error('Potpis envelope-a operacije nije validan.');
  }
  const ciphertext = base64UrlToBytes(envelope.ciphertext);
  const nonce = base64UrlToBytes(envelope.nonce);
  const key = await deriveObjectEncryptionKey(
    input.vaultMasterKey,
    {
      vaultId: envelope.vaultId,
      keyEpoch: envelope.keyEpoch,
      objectType: 'operation',
      objectId: envelope.operationId,
      purpose: 'operation',
    },
    runtime,
  );
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decryptAesGcm(ciphertext, key, nonce, envelope.aad, runtime);
    const operation = parseSyncOperation(
      JSON.parse(decodeUtf8(new Uint8Array(plaintext))) as unknown,
    );
    assertOperationEnvelopeMatches(envelope, operation);
    await assertOperationResultStateHash(operation, runtime);
    return operation;
  } finally {
    clearBytes(ciphertext, nonce);
    if (plaintext) clearBytes(plaintext);
  }
};

export const nextLamportTime = (...observedTimes: readonly number[]): number => {
  const greatest = observedTimes.reduce((maximum, value) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Lamport vreme mora biti nenegativan bezbedan ceo broj.');
    }
    return Math.max(maximum, value);
  }, 0);
  if (greatest >= Number.MAX_SAFE_INTEGER) throw new Error('Lamport vreme je iscrpljeno.');
  return greatest + 1;
};

export const protocolOperationDefaults = Object.freeze({
  type: 'mirna-sync-operation-v1' as const,
  protocolVersion: SYNC_PROTOCOL_VERSION,
  suite: SYNC_CRYPTO_SUITE,
});
