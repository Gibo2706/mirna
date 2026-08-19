import { z } from 'zod';
import { canonicalizeJson } from './canonical';
import { type CryptoRuntime } from './crypto';
import {
  causalFrontierSchema,
  hashSyncOperation,
  parseSyncOperation,
  type CausalFrontierEntryV1,
  type CausalFrontierV1,
  type SyncOperationV1,
} from './operation';
import { opaqueIdSchema, sha256Schema } from './schemas';

const safeSequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSafeSequenceSchema = safeSequenceSchema.positive();

export const seenOperationSchema = z.strictObject({
  operationId: opaqueIdSchema,
  operationHash: sha256Schema,
  deviceId: opaqueIdSchema,
  deviceSequence: positiveSafeSequenceSchema,
  lamportTime: positiveSafeSequenceSchema,
  serverCursor: positiveSafeSequenceSchema,
});

export const causalStateSchema = z
  .strictObject({
    frontier: causalFrontierSchema,
    lastServerCursor: safeSequenceSchema,
    seenOperations: z.array(seenOperationSchema),
  })
  .superRefine((state, context) => {
    const operationIds = new Set<string>();
    const identities = new Set<string>();
    let previousCursor = 0;
    for (const [index, seen] of state.seenOperations.entries()) {
      const identity = `${seen.deviceId}:${seen.deviceSequence}`;
      if (operationIds.has(seen.operationId)) {
        context.addIssue({
          code: 'custom',
          path: ['seenOperations', index, 'operationId'],
          message: 'Stanje sadrži duplikat operation ID-a.',
        });
      }
      if (identities.has(identity)) {
        context.addIssue({
          code: 'custom',
          path: ['seenOperations', index, 'deviceSequence'],
          message: 'Stanje sadrži ponovljen identitet sekvence uređaja.',
        });
      }
      if (seen.serverCursor <= previousCursor) {
        context.addIssue({
          code: 'custom',
          path: ['seenOperations', index, 'serverCursor'],
          message: 'Viđene operacije moraju biti strogo sortirane po server cursor-u.',
        });
      }
      operationIds.add(seen.operationId);
      identities.add(identity);
      previousCursor = seen.serverCursor;
    }
    if (previousCursor > state.lastServerCursor) {
      context.addIssue({
        code: 'custom',
        path: ['lastServerCursor'],
        message: 'Poslednji server cursor je iza istorije viđenih operacija.',
      });
    }
  });

export type SeenOperationV1 = z.infer<typeof seenOperationSchema>;
export type CausalStateV1 = z.infer<typeof causalStateSchema>;

export type CausalValidationErrorCode =
  | 'operation-id-reuse'
  | 'operation-cursor-mismatch'
  | 'device-sequence-reuse'
  | 'device-sequence-gap'
  | 'broken-previous-operation-hash'
  | 'server-cursor-reorder'
  | 'server-cursor-gap'
  | 'causal-gap'
  | 'causal-hash-mismatch'
  | 'causal-history-unavailable'
  | 'lamport-regression';

export class CausalValidationError extends Error {
  readonly code: CausalValidationErrorCode;

  constructor(code: CausalValidationErrorCode, message: string) {
    super(message);
    this.name = 'CausalValidationError';
    this.code = code;
  }
}

export type IncomingOperationResult =
  | {
      readonly kind: 'accepted';
      readonly operationHash: string;
      readonly state: CausalStateV1;
    }
  | {
      readonly kind: 'exact-duplicate';
      readonly operationHash: string;
      readonly state: CausalStateV1;
    };

const identityKey = (deviceId: string, deviceSequence: number): string =>
  `${deviceId}:${deviceSequence}`;

const frontierByDevice = (frontier: CausalFrontierV1): Map<string, CausalFrontierEntryV1> =>
  new Map(frontier.map((entry) => [entry.deviceId, entry]));

const sortedFrontier = (frontier: ReadonlyMap<string, CausalFrontierEntryV1>): CausalFrontierV1 =>
  causalFrontierSchema.parse(
    [...frontier.values()].sort((left, right) => left.deviceId.localeCompare(right.deviceId)),
  );

export const createEmptyCausalState = (): CausalStateV1 => ({
  frontier: [],
  lastServerCursor: 0,
  seenOperations: [],
});

export type CausalOrder = 'equal' | 'before' | 'after' | 'concurrent';

export const compareCausalFrontiers = (
  leftInput: CausalFrontierV1,
  rightInput: CausalFrontierV1,
): CausalOrder => {
  const left = causalFrontierSchema.parse(leftInput);
  const right = causalFrontierSchema.parse(rightInput);
  const leftByDevice = frontierByDevice(left);
  const rightByDevice = frontierByDevice(right);
  let leftAhead = false;
  let rightAhead = false;

  for (const deviceId of new Set([...leftByDevice.keys(), ...rightByDevice.keys()])) {
    const leftEntry = leftByDevice.get(deviceId);
    const rightEntry = rightByDevice.get(deviceId);
    const leftSequence = leftEntry?.deviceSequence ?? 0;
    const rightSequence = rightEntry?.deviceSequence ?? 0;
    if (
      leftSequence === rightSequence &&
      leftSequence > 0 &&
      leftEntry?.operationHash !== rightEntry?.operationHash
    ) {
      throw new CausalValidationError(
        'causal-hash-mismatch',
        `Causal frontier ima dva hash-a za isti događaj uređaja ${deviceId}.`,
      );
    }
    if (leftSequence > rightSequence) leftAhead = true;
    if (rightSequence > leftSequence) rightAhead = true;
  }

  if (!leftAhead && !rightAhead) return 'equal';
  if (leftAhead && rightAhead) return 'concurrent';
  return leftAhead ? 'after' : 'before';
};

const operationClock = async (
  operation: SyncOperationV1,
  runtime?: CryptoRuntime,
): Promise<CausalFrontierV1> => {
  const parsed = parseSyncOperation(operation);
  const clock = frontierByDevice(parsed.causalFrontier);
  clock.set(parsed.deviceId, {
    deviceId: parsed.deviceId,
    deviceSequence: parsed.deviceSequence,
    operationHash: await hashSyncOperation(parsed, runtime),
  });
  return sortedFrontier(clock);
};

const findSeenCausalEntry = (
  state: CausalStateV1,
  entry: CausalFrontierEntryV1,
): SeenOperationV1 | undefined =>
  state.seenOperations.find(
    (seen) => seen.deviceId === entry.deviceId && seen.deviceSequence === entry.deviceSequence,
  );

const validateClaimedFrontier = (state: CausalStateV1, operation: SyncOperationV1): number => {
  const knownFrontier = frontierByDevice(state.frontier);
  let greatestKnownLamport = 0;

  for (const claimed of operation.causalFrontier) {
    const known = knownFrontier.get(claimed.deviceId);
    if (!known || claimed.deviceSequence > known.deviceSequence) {
      throw new CausalValidationError(
        'causal-gap',
        `Nedostaje causal prethodnik uređaja ${claimed.deviceId}.`,
      );
    }

    if (claimed.deviceSequence === known.deviceSequence) {
      if (claimed.operationHash !== known.operationHash) {
        throw new CausalValidationError(
          'causal-hash-mismatch',
          `Causal hash uređaja ${claimed.deviceId} se ne poklapa sa lokalnim frontier-om.`,
        );
      }
    } else {
      const historical = findSeenCausalEntry(state, claimed);
      if (!historical) {
        throw new CausalValidationError(
          'causal-history-unavailable',
          `Nije moguće proveriti istorijski causal događaj uređaja ${claimed.deviceId}.`,
        );
      }
      if (historical.operationHash !== claimed.operationHash) {
        throw new CausalValidationError(
          'causal-hash-mismatch',
          `Istorijski causal hash uređaja ${claimed.deviceId} nije validan.`,
        );
      }
    }

    const causalEvent = findSeenCausalEntry(state, claimed);
    if (causalEvent) greatestKnownLamport = Math.max(greatestKnownLamport, causalEvent.lamportTime);
  }

  return greatestKnownLamport;
};

export const acceptIncomingOperation = async (input: {
  state: CausalStateV1;
  operation: SyncOperationV1;
  serverCursor: number;
  runtime?: CryptoRuntime;
}): Promise<IncomingOperationResult> => {
  const state = causalStateSchema.parse(input.state);
  const operation = parseSyncOperation(input.operation);
  const serverCursor = positiveSafeSequenceSchema.parse(input.serverCursor);
  const operationHash = await hashSyncOperation(operation, input.runtime);
  const seenByOperationId = state.seenOperations.find(
    (seen) => seen.operationId === operation.operationId,
  );

  if (seenByOperationId) {
    if (
      seenByOperationId.operationHash !== operationHash ||
      seenByOperationId.deviceId !== operation.deviceId ||
      seenByOperationId.deviceSequence !== operation.deviceSequence
    ) {
      throw new CausalValidationError(
        'operation-id-reuse',
        'Isti operation ID je ponovljen sa različitim kanonskim sadržajem ili identitetom.',
      );
    }
    if (seenByOperationId.serverCursor !== serverCursor) {
      throw new CausalValidationError(
        'operation-cursor-mismatch',
        'Tačna duplicate operacija je vraćena sa drugim server cursor-om.',
      );
    }
    return { kind: 'exact-duplicate', operationHash, state };
  }

  const seenByIdentity = state.seenOperations.find(
    (seen) =>
      identityKey(seen.deviceId, seen.deviceSequence) ===
      identityKey(operation.deviceId, operation.deviceSequence),
  );
  if (seenByIdentity) {
    throw new CausalValidationError(
      'device-sequence-reuse',
      'Uređaj je ponovo upotrebio već prihvaćenu sekvencu za drugu operaciju.',
    );
  }

  if (serverCursor <= state.lastServerCursor) {
    throw new CausalValidationError(
      'server-cursor-reorder',
      'Server cursor nije strogo veći od poslednjeg prihvaćenog cursor-a.',
    );
  }
  if (serverCursor !== state.lastServerCursor + 1) {
    throw new CausalValidationError(
      'server-cursor-gap',
      'Server cursor preskače operacije koje još nisu obrađene.',
    );
  }

  const frontier = frontierByDevice(state.frontier);
  const previous = frontier.get(operation.deviceId);
  const expectedSequence = (previous?.deviceSequence ?? 0) + 1;
  if (operation.deviceSequence < expectedSequence) {
    throw new CausalValidationError(
      'device-sequence-reuse',
      'Sekvenca uređaja je starija od prihvaćenog frontier-a.',
    );
  }
  if (operation.deviceSequence > expectedSequence) {
    throw new CausalValidationError(
      'device-sequence-gap',
      'Sekvenca uređaja preskače jednu ili više operacija.',
    );
  }
  if (operation.previousOperationHash !== (previous?.operationHash ?? null)) {
    throw new CausalValidationError(
      'broken-previous-operation-hash',
      'Hash lanac operacija uređaja je prekinut.',
    );
  }

  const greatestKnownLamport = validateClaimedFrontier(state, operation);
  if (operation.lamportTime <= greatestKnownLamport) {
    throw new CausalValidationError(
      'lamport-regression',
      'Lamport vreme mora biti veće od svih navedenih causal prethodnika.',
    );
  }

  frontier.set(operation.deviceId, {
    deviceId: operation.deviceId,
    deviceSequence: operation.deviceSequence,
    operationHash,
  });
  const nextState = causalStateSchema.parse({
    frontier: sortedFrontier(frontier),
    lastServerCursor: serverCursor,
    seenOperations: [
      ...state.seenOperations,
      {
        operationId: operation.operationId,
        operationHash,
        deviceId: operation.deviceId,
        deviceSequence: operation.deviceSequence,
        lamportTime: operation.lamportTime,
        serverCursor,
      },
    ],
  });

  return { kind: 'accepted', operationHash, state: nextState };
};

export type OperationMergeDecision =
  | { readonly kind: 'exact-duplicate'; readonly action: 'ignore' }
  | { readonly kind: 'incoming-before-existing'; readonly action: 'ignore' }
  | { readonly kind: 'incoming-after-existing'; readonly action: 'apply' }
  | { readonly kind: 'concurrent-disjoint-entities'; readonly action: 'apply' }
  | { readonly kind: 'tombstone-resurrection'; readonly action: 'require-user-review' }
  | {
      readonly kind: 'concurrent-same-entity';
      readonly action: 'require-user-review';
      readonly conflictType: 'edit-edit' | 'edit-delete' | 'delete-delete';
    };

const operationIdentityMatches = (left: SyncOperationV1, right: SyncOperationV1): boolean =>
  left.deviceId === right.deviceId && left.deviceSequence === right.deviceSequence;

export const classifyOperationMerge = async (
  existingInput: SyncOperationV1,
  incomingInput: SyncOperationV1,
  runtime?: CryptoRuntime,
): Promise<OperationMergeDecision> => {
  const existing = parseSyncOperation(existingInput);
  const incoming = parseSyncOperation(incomingInput);
  const [existingHash, incomingHash] = await Promise.all([
    hashSyncOperation(existing, runtime),
    hashSyncOperation(incoming, runtime),
  ]);

  if (existing.operationId === incoming.operationId) {
    if (
      existingHash !== incomingHash ||
      canonicalizeJson(existing) !== canonicalizeJson(incoming)
    ) {
      throw new CausalValidationError(
        'operation-id-reuse',
        'Isti operation ID predstavlja različite kanonske operacije.',
      );
    }
    return { kind: 'exact-duplicate', action: 'ignore' };
  }
  if (operationIdentityMatches(existing, incoming)) {
    throw new CausalValidationError(
      'device-sequence-reuse',
      'Isti uređaj i sekvenca predstavljaju različite operacije.',
    );
  }

  const order = compareCausalFrontiers(
    await operationClock(existing, runtime),
    await operationClock(incoming, runtime),
  );
  if (order === 'before') {
    const sameEntity =
      existing.command.entityType === incoming.command.entityType &&
      existing.command.entityId === incoming.command.entityId;
    if (sameEntity && existing.command.tombstone !== null && incoming.command.tombstone === null) {
      return { kind: 'tombstone-resurrection', action: 'require-user-review' };
    }
    return { kind: 'incoming-after-existing', action: 'apply' };
  }
  if (order === 'after') return { kind: 'incoming-before-existing', action: 'ignore' };

  const sameEntity =
    existing.command.entityType === incoming.command.entityType &&
    existing.command.entityId === incoming.command.entityId;
  if (!sameEntity) return { kind: 'concurrent-disjoint-entities', action: 'apply' };

  const existingDelete = existing.command.tombstone !== null;
  const incomingDelete = incoming.command.tombstone !== null;
  return {
    kind: 'concurrent-same-entity',
    action: 'require-user-review',
    conflictType:
      existingDelete && incomingDelete
        ? 'delete-delete'
        : existingDelete || incomingDelete
          ? 'edit-delete'
          : 'edit-edit',
  };
};

export const assertConflictResolutionOperation = async (
  resolutionInput: SyncOperationV1,
  conflictingInputs: readonly [SyncOperationV1, SyncOperationV1],
  runtime?: CryptoRuntime,
): Promise<void> => {
  const resolution = parseSyncOperation(resolutionInput);
  const conflicting = conflictingInputs.map(parseSyncOperation) as [
    SyncOperationV1,
    SyncOperationV1,
  ];
  const merge = await classifyOperationMerge(conflicting[0], conflicting[1], runtime);
  if (merge.kind !== 'concurrent-same-entity') {
    throw new Error('Resolution operacija zahteva stvarni concurrent konflikt istog entiteta.');
  }
  if (
    conflicting.some(
      (operation) =>
        resolution.operationId === operation.operationId ||
        resolution.command.entityType !== operation.command.entityType ||
        resolution.command.entityId !== operation.command.entityId,
    )
  ) {
    throw new Error('Resolution mora biti nova normalna komanda za konfliktni entitet.');
  }
  const greatestConflictingVersion = Math.max(
    ...conflicting.map((operation) => operation.command.result.entityVersion),
  );
  if (resolution.command.precondition.entityVersion < greatestConflictingVersion) {
    throw new Error('Resolution precondition ne obuhvata konfliktne verzije entiteta.');
  }
  for (const conflict of conflicting) {
    const relation = compareCausalFrontiers(
      await operationClock(conflict, runtime),
      await operationClock(resolution, runtime),
    );
    if (relation !== 'before') {
      throw new Error('Resolution causal frontier mora obuhvatiti obe konfliktne operacije.');
    }
  }
};
