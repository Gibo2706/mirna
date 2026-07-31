/** Synthetic causal histories only. No production or user financial data. */
import { describe, expect, it } from 'vitest';
import {
  acceptIncomingOperation,
  assertConflictResolutionOperation,
  CausalValidationError,
  classifyOperationMerge,
  compareCausalFrontiers,
  createEmptyCausalState,
  type CausalStateV1,
} from './causal';
import {
  hashSyncOperation,
  parseSyncOperation,
  protocolOperationDefaults,
  type CausalFrontierV1,
  type SyncOperationV1,
} from './operation';

const timestamp = '2026-07-31T10:00:00.000Z';
const opaque = (character: string): string => character.repeat(22);
const digest = (character = 'H'): string => character.repeat(43);

const accountValue = (id: string, openingBalance = 10_000) => ({
  id,
  name: `Račun ${id}`,
  kind: 'checking' as const,
  openingBalance,
  protected: false,
  color: '#123456',
  archived: false,
  createdAt: timestamp,
});

interface OperationFixtureInput {
  readonly operationCharacter: string;
  readonly deviceCharacter: string;
  readonly deviceSequence?: number;
  readonly lamportTime?: number;
  readonly causalFrontier?: CausalFrontierV1;
  readonly previousOperationHash?: string | null;
  readonly entityId?: string;
  readonly expectedVersion?: number;
  readonly openingBalance?: number;
  readonly deletion?: boolean;
}

const makeOperation = (input: OperationFixtureInput): SyncOperationV1 => {
  const operationId = opaque(input.operationCharacter);
  const deviceId = opaque(input.deviceCharacter);
  const deviceSequence = input.deviceSequence ?? 1;
  const lamportTime = input.lamportTime ?? 1;
  const causalFrontier = input.causalFrontier ?? [];
  const entityId = input.entityId ?? 'account-1';
  const expectedVersion = input.expectedVersion ?? 0;
  const deletion = input.deletion ?? false;
  const previousStateHash = expectedVersion === 0 ? null : digest('S');
  const resultVersion = expectedVersion + 1;
  const tombstone = deletion
    ? {
        entityType: 'account' as const,
        entityId,
        entityVersion: resultVersion,
        previousStateHash: previousStateHash!,
        deletionOperationId: operationId,
        deletingDeviceId: deviceId,
        deviceSequence,
        lamportTime,
        causalFrontier,
        deletedAt: timestamp,
      }
    : null;

  return parseSyncOperation({
    ...protocolOperationDefaults,
    vaultId: opaque('V'),
    operationId,
    deviceId,
    deviceSequence,
    lamportTime,
    causalFrontier,
    command: {
      type: deletion ? 'account.delete' : 'account.upsert',
      entityType: 'account',
      entityId,
      precondition: {
        entityVersion: expectedVersion,
        stateHash: previousStateHash,
        tombstone: false,
      },
      result: {
        entityVersion: resultVersion,
        stateHash: digest(input.operationCharacter),
        tombstone: deletion,
      },
      value: deletion ? null : accountValue(entityId, input.openingBalance),
      tombstone,
    },
    previousOperationHash: input.previousOperationHash ?? null,
    keyEpoch: 1,
    createdAt: timestamp,
  });
};

const errorCode = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof CausalValidationError ? error.code : undefined;
  }
};

describe('causal frontier ordering', () => {
  it('distinguishes equal, before, after and concurrent vectors without wall-clock time', () => {
    const a1 = { deviceId: opaque('A'), deviceSequence: 1, operationHash: digest('A') };
    const a2 = { ...a1, deviceSequence: 2, operationHash: digest('B') };
    const b1 = { deviceId: opaque('B'), deviceSequence: 1, operationHash: digest('C') };

    expect(compareCausalFrontiers([a1], [a1])).toBe('equal');
    expect(compareCausalFrontiers([a1], [a2])).toBe('before');
    expect(compareCausalFrontiers([a2], [a1])).toBe('after');
    expect(compareCausalFrontiers([a2], [a1, b1])).toBe('concurrent');
  });

  it('rejects two hashes claiming the same device event', () => {
    const left = [{ deviceId: opaque('A'), deviceSequence: 1, operationHash: digest('A') }];
    const right = [{ deviceId: opaque('A'), deviceSequence: 1, operationHash: digest('B') }];
    expect(() => compareCausalFrontiers(left, right)).toThrowError(
      expect.objectContaining({ code: 'causal-hash-mismatch' }),
    );
  });
});

describe('incoming append-only operation validation', () => {
  it('accepts contiguous per-device chains and causal dependencies', async () => {
    const first = makeOperation({ operationCharacter: 'A', deviceCharacter: 'A' });
    const acceptedFirst = await acceptIncomingOperation({
      state: createEmptyCausalState(),
      operation: first,
      serverCursor: 1,
    });
    expect(acceptedFirst.kind).toBe('accepted');
    const firstHash = await hashSyncOperation(first);
    const second = makeOperation({
      operationCharacter: 'B',
      deviceCharacter: 'A',
      deviceSequence: 2,
      lamportTime: 2,
      causalFrontier: [{ deviceId: first.deviceId, deviceSequence: 1, operationHash: firstHash }],
      previousOperationHash: firstHash,
      entityId: 'account-2',
    });
    const acceptedSecond = await acceptIncomingOperation({
      state: acceptedFirst.state,
      operation: second,
      serverCursor: 2,
    });

    expect(acceptedSecond.kind).toBe('accepted');
    expect(acceptedSecond.state.frontier).toEqual([
      {
        deviceId: first.deviceId,
        deviceSequence: 2,
        operationHash: await hashSyncOperation(second),
      },
    ]);
    expect(acceptedSecond.state.lastServerCursor).toBe(2);
  });

  it('returns exact duplicate idempotently but rejects same operation ID with different bytes', async () => {
    const original = makeOperation({ operationCharacter: 'A', deviceCharacter: 'A' });
    const accepted = await acceptIncomingOperation({
      state: createEmptyCausalState(),
      operation: original,
      serverCursor: 1,
    });
    const duplicate = await acceptIncomingOperation({
      state: accepted.state,
      operation: original,
      serverCursor: 1,
    });
    expect(duplicate.kind).toBe('exact-duplicate');

    const altered = makeOperation({
      operationCharacter: 'A',
      deviceCharacter: 'A',
      openingBalance: 99_999,
    });
    expect(
      await errorCode(
        acceptIncomingOperation({ state: accepted.state, operation: altered, serverCursor: 1 }),
      ),
    ).toBe('operation-id-reuse');
  });

  it('rejects the same device sequence reused for a different operation identity', async () => {
    const original = makeOperation({ operationCharacter: 'A', deviceCharacter: 'A' });
    const accepted = await acceptIncomingOperation({
      state: createEmptyCausalState(),
      operation: original,
      serverCursor: 1,
    });
    const reused = makeOperation({ operationCharacter: 'B', deviceCharacter: 'A' });
    expect(
      await errorCode(
        acceptIncomingOperation({ state: accepted.state, operation: reused, serverCursor: 2 }),
      ),
    ).toBe('device-sequence-reuse');
  });

  it('rejects skipped device sequences before attempting a merge', async () => {
    const skipped = makeOperation({
      operationCharacter: 'C',
      deviceCharacter: 'A',
      deviceSequence: 2,
      lamportTime: 2,
      previousOperationHash: digest('P'),
      causalFrontier: [{ deviceId: opaque('A'), deviceSequence: 1, operationHash: digest('P') }],
    });
    expect(
      await errorCode(
        acceptIncomingOperation({
          state: createEmptyCausalState(),
          operation: skipped,
          serverCursor: 1,
        }),
      ),
    ).toBe('device-sequence-gap');
  });

  it('rejects a broken previous-operation hash chain', async () => {
    const first = makeOperation({ operationCharacter: 'A', deviceCharacter: 'A' });
    const accepted = await acceptIncomingOperation({
      state: createEmptyCausalState(),
      operation: first,
      serverCursor: 1,
    });
    const broken = makeOperation({
      operationCharacter: 'B',
      deviceCharacter: 'A',
      deviceSequence: 2,
      lamportTime: 2,
      previousOperationHash: digest('Z'),
      causalFrontier: [{ deviceId: opaque('A'), deviceSequence: 1, operationHash: digest('Z') }],
    });
    expect(
      await errorCode(
        acceptIncomingOperation({ state: accepted.state, operation: broken, serverCursor: 2 }),
      ),
    ).toBe('broken-previous-operation-hash');
  });

  it('rejects reordered and skipped server cursors', async () => {
    const first = makeOperation({ operationCharacter: 'A', deviceCharacter: 'A' });
    const accepted = await acceptIncomingOperation({
      state: createEmptyCausalState(),
      operation: first,
      serverCursor: 1,
    });
    const independent = makeOperation({ operationCharacter: 'B', deviceCharacter: 'B' });
    expect(
      await errorCode(
        acceptIncomingOperation({
          state: accepted.state,
          operation: independent,
          serverCursor: 1,
        }),
      ),
    ).toBe('server-cursor-reorder');
    expect(
      await errorCode(
        acceptIncomingOperation({
          state: accepted.state,
          operation: independent,
          serverCursor: 3,
        }),
      ),
    ).toBe('server-cursor-gap');
  });

  it('rejects missing or forged causal predecessors and Lamport regression', async () => {
    const first = makeOperation({ operationCharacter: 'A', deviceCharacter: 'A' });
    const accepted = await acceptIncomingOperation({
      state: createEmptyCausalState(),
      operation: first,
      serverCursor: 1,
    });
    const unknownCausal = makeOperation({
      operationCharacter: 'B',
      deviceCharacter: 'B',
      lamportTime: 2,
      causalFrontier: [{ deviceId: opaque('C'), deviceSequence: 1, operationHash: digest('C') }],
    });
    expect(
      await errorCode(
        acceptIncomingOperation({
          state: accepted.state,
          operation: unknownCausal,
          serverCursor: 2,
        }),
      ),
    ).toBe('causal-gap');

    const forgedCausal = makeOperation({
      operationCharacter: 'C',
      deviceCharacter: 'B',
      lamportTime: 2,
      causalFrontier: [{ deviceId: opaque('A'), deviceSequence: 1, operationHash: digest('Z') }],
    });
    expect(
      await errorCode(
        acceptIncomingOperation({
          state: accepted.state,
          operation: forgedCausal,
          serverCursor: 2,
        }),
      ),
    ).toBe('causal-hash-mismatch');

    const firstHash = await hashSyncOperation(first);
    const regressedLamport = makeOperation({
      operationCharacter: 'D',
      deviceCharacter: 'B',
      lamportTime: 1,
      causalFrontier: [{ deviceId: opaque('A'), deviceSequence: 1, operationHash: firstHash }],
    });
    expect(
      await errorCode(
        acceptIncomingOperation({
          state: accepted.state,
          operation: regressedLamport,
          serverCursor: 2,
        }),
      ),
    ).toBe('lamport-regression');
  });

  it('does not mutate prior causal state when accepting a new operation', async () => {
    const original: CausalStateV1 = createEmptyCausalState();
    const operation = makeOperation({ operationCharacter: 'A', deviceCharacter: 'A' });
    const accepted = await acceptIncomingOperation({ state: original, operation, serverCursor: 1 });
    expect(original).toEqual(createEmptyCausalState());
    expect(accepted.state).not.toBe(original);
  });
});

describe('deterministic conflict classification without last-write-wins', () => {
  it('automatically applies commutative operations for disjoint entity identities', async () => {
    const existing = makeOperation({ operationCharacter: 'A', deviceCharacter: 'A' });
    const incoming = makeOperation({
      operationCharacter: 'B',
      deviceCharacter: 'B',
      entityId: 'account-2',
    });
    await expect(classifyOperationMerge(existing, incoming)).resolves.toEqual({
      kind: 'concurrent-disjoint-entities',
      action: 'apply',
    });
  });

  it('requires review for concurrent edits to the same financial entity', async () => {
    const existing = makeOperation({
      operationCharacter: 'A',
      deviceCharacter: 'A',
      expectedVersion: 1,
      openingBalance: 10_001,
    });
    const incoming = makeOperation({
      operationCharacter: 'B',
      deviceCharacter: 'B',
      expectedVersion: 1,
      openingBalance: 10_002,
    });
    await expect(classifyOperationMerge(existing, incoming)).resolves.toEqual({
      kind: 'concurrent-same-entity',
      action: 'require-user-review',
      conflictType: 'edit-edit',
    });
  });

  it('requires review for edit/delete and delete/delete conflicts', async () => {
    const edit = makeOperation({
      operationCharacter: 'A',
      deviceCharacter: 'A',
      expectedVersion: 1,
    });
    const deletion = makeOperation({
      operationCharacter: 'B',
      deviceCharacter: 'B',
      expectedVersion: 1,
      deletion: true,
    });
    await expect(classifyOperationMerge(edit, deletion)).resolves.toMatchObject({
      action: 'require-user-review',
      conflictType: 'edit-delete',
    });
    const otherDeletion = makeOperation({
      operationCharacter: 'C',
      deviceCharacter: 'C',
      expectedVersion: 1,
      deletion: true,
    });
    await expect(classifyOperationMerge(deletion, otherDeletion)).resolves.toMatchObject({
      action: 'require-user-review',
      conflictType: 'delete-delete',
    });
  });

  it('applies a causally later edit, ignores an older one, and never compares createdAt', async () => {
    const existing = makeOperation({
      operationCharacter: 'A',
      deviceCharacter: 'A',
      expectedVersion: 1,
    });
    const existingHash = await hashSyncOperation(existing);
    const incoming = makeOperation({
      operationCharacter: 'B',
      deviceCharacter: 'B',
      lamportTime: 2,
      expectedVersion: 2,
      causalFrontier: [
        { deviceId: existing.deviceId, deviceSequence: 1, operationHash: existingHash },
      ],
    });
    await expect(classifyOperationMerge(existing, incoming)).resolves.toEqual({
      kind: 'incoming-after-existing',
      action: 'apply',
    });
    await expect(classifyOperationMerge(incoming, existing)).resolves.toEqual({
      kind: 'incoming-before-existing',
      action: 'ignore',
    });
  });

  it('blocks tombstone resurrection even when the upsert is causally later', async () => {
    const deletion = makeOperation({
      operationCharacter: 'A',
      deviceCharacter: 'A',
      expectedVersion: 1,
      deletion: true,
    });
    const deletionHash = await hashSyncOperation(deletion);
    const resurrection = makeOperation({
      operationCharacter: 'B',
      deviceCharacter: 'B',
      lamportTime: 2,
      expectedVersion: 2,
      causalFrontier: [
        { deviceId: deletion.deviceId, deviceSequence: 1, operationHash: deletionHash },
      ],
    });
    await expect(classifyOperationMerge(deletion, resurrection)).resolves.toEqual({
      kind: 'tombstone-resurrection',
      action: 'require-user-review',
    });
  });

  it('distinguishes an exact duplicate from reused operation or device-sequence identity', async () => {
    const original = makeOperation({ operationCharacter: 'A', deviceCharacter: 'A' });
    await expect(classifyOperationMerge(original, original)).resolves.toEqual({
      kind: 'exact-duplicate',
      action: 'ignore',
    });
    const reusedOperationId = makeOperation({
      operationCharacter: 'A',
      deviceCharacter: 'B',
      entityId: 'account-2',
    });
    await expect(classifyOperationMerge(original, reusedOperationId)).rejects.toMatchObject({
      code: 'operation-id-reuse',
    });
    const reusedSequence = makeOperation({
      operationCharacter: 'B',
      deviceCharacter: 'A',
      entityId: 'account-2',
    });
    await expect(classifyOperationMerge(original, reusedSequence)).rejects.toMatchObject({
      code: 'device-sequence-reuse',
    });
  });

  it('accepts conflict resolution only as a new normal allowlisted command causally after both sides', async () => {
    const left = makeOperation({
      operationCharacter: 'A',
      deviceCharacter: 'A',
      expectedVersion: 1,
      openingBalance: 11_000,
    });
    const right = makeOperation({
      operationCharacter: 'B',
      deviceCharacter: 'B',
      expectedVersion: 1,
      openingBalance: 12_000,
    });
    const [leftHash, rightHash] = await Promise.all([
      hashSyncOperation(left),
      hashSyncOperation(right),
    ]);
    const resolution = makeOperation({
      operationCharacter: 'C',
      deviceCharacter: 'C',
      lamportTime: 3,
      expectedVersion: 2,
      openingBalance: 11_500,
      causalFrontier: [
        { deviceId: left.deviceId, deviceSequence: 1, operationHash: leftHash },
        { deviceId: right.deviceId, deviceSequence: 1, operationHash: rightHash },
      ],
    });

    expect(resolution.command.type).toBe('account.upsert');
    await expect(
      assertConflictResolutionOperation(resolution, [left, right]),
    ).resolves.toBeUndefined();

    const missingRight = makeOperation({
      operationCharacter: 'D',
      deviceCharacter: 'C',
      lamportTime: 3,
      expectedVersion: 2,
      causalFrontier: [{ deviceId: left.deviceId, deviceSequence: 1, operationHash: leftHash }],
    });
    await expect(assertConflictResolutionOperation(missingRight, [left, right])).rejects.toThrow(
      /obe konfliktne/u,
    );
  });
});
