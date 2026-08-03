import Dexie, { type Table } from 'dexie';
import { canonicalizeJson, type CanonicalJson } from '@/domain/sync/canonical';
import {
  createEncryptedOperation,
  hashEntityState,
  hashSyncOperation,
  nextLamportTime,
  operationResultStateHash,
  parseOperationEnvelope,
  parseSyncOperation,
  protocolOperationDefaults,
  type AcceptedOperationEnvelopeV1,
  type CausalFrontierV1,
  type OperationEnvelopeV1,
  type SyncFinancialEntityType,
  type SyncOperationV1,
} from '@/domain/sync/operation';
import { validateFinanceData, readFinanceDataInTransaction } from '../finance-data';
import { db, financeTables, type FinanceDatabase } from '../database';
import { normalizeSyncJsonValue, parseSyncMutationIntent } from './mutation-audit';
import {
  SYNC_METADATA_RECORD_ID,
  type LocalSyncSetup,
  type SyncEntityStateRecord,
  type SyncInboxRecord,
  type SyncMetadataRecord,
  type SyncOutboxRecord,
  type SyncKeyRecord,
} from './records';
import { readLocalSyncSetup } from './repository';

export class LocalOperationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalOperationStateError';
  }
}

export interface OpenedRemoteOperation {
  readonly acceptedEnvelope: AcceptedOperationEnvelopeV1;
  readonly operation: SyncOperationV1;
  readonly operationHash: string;
}

const entityStateId = (
  vaultId: string,
  entityType: SyncFinancialEntityType,
  entityId: string,
): string => `${vaultId}:${entityType}:${entityId}`;

const frontierId = (vaultId: string, deviceId: string): string => `${vaultId}:${deviceId}`;

const entityTable = (
  database: FinanceDatabase,
  entityType: SyncFinancialEntityType,
): Table<{ id: string }, string> => {
  const table = (() => {
    switch (entityType) {
      case 'account':
        return database.accounts;
      case 'transaction':
        return database.transactions;
      case 'category':
        return database.categories;
      case 'planned-income':
        return database.plannedIncomes;
      case 'commitment':
        return database.commitments;
      case 'variable-budget':
        return database.variableBudgets;
      case 'goal':
        return database.goals;
      case 'debt':
        return database.debts;
      case 'debt-payment':
        return database.debtPayments;
      case 'planned-event':
        return database.plannedEvents;
      case 'quick-add-preset':
        return database.presets;
      case 'salary-scenario':
        return database.salaryScenarios;
      case 'settings':
        return database.settings;
    }
  })();
  return table as unknown as Table<{ id: string }, string>;
};

const stateFromValue = async (
  vaultId: string,
  entityType: SyncFinancialEntityType,
  entityId: string,
  valueInput: unknown,
  updatedAt: string,
): Promise<SyncEntityStateRecord> => {
  const value = normalizeSyncJsonValue(valueInput);
  return {
    id: entityStateId(vaultId, entityType, entityId),
    vaultId,
    entityType,
    entityId,
    entityVersion: 1,
    stateHash: await hashEntityState({
      entityType,
      entityId,
      entityVersion: 1,
      value,
      tombstone: null,
    }),
    tombstone: false,
    canonicalTombstone: undefined,
    lastOperationId: null,
    lastDeviceId: null,
    lastDeviceSequence: 0,
    lastLamportTime: 0,
    updatedAt,
  };
};

const operationEnvelopeFromRecord = (record: SyncOutboxRecord): OperationEnvelopeV1 => {
  if (!record.encryptedEnvelope) {
    throw new LocalOperationStateError('Outbox operacija nema šifrovani envelope.');
  }
  try {
    const envelope = parseOperationEnvelope(JSON.parse(record.encryptedEnvelope) as unknown);
    if (
      envelope.operationId !== record.operationId ||
      envelope.deviceId !== record.deviceId ||
      envelope.deviceSequence !== record.deviceSequence ||
      envelope.keyEpoch !== record.keyEpoch
    ) {
      throw new Error('mismatch');
    }
    return envelope;
  } catch {
    throw new LocalOperationStateError('Outbox envelope je neispravan.');
  }
};

const compareOutbox = (left: SyncOutboxRecord, right: SyncOutboxRecord): number =>
  left.createdAt.localeCompare(right.createdAt) ||
  left.mutationGroupId.localeCompare(right.mutationGroupId) ||
  left.mutationGroupIndex - right.mutationGroupIndex;

const assertCompleteGroup = (records: readonly SyncOutboxRecord[]): void => {
  const first = records[0];
  if (
    !first ||
    records.length !== first.mutationGroupSize ||
    records.some(
      (record, index) =>
        record.mutationGroupId !== first.mutationGroupId ||
        record.mutationGroupSize !== first.mutationGroupSize ||
        record.mutationGroupIndex !== index,
    )
  ) {
    throw new LocalOperationStateError('Outbox mutation grupa nije kompletna.');
  }
};

const assertConsistentGroupRemainder = (records: readonly SyncOutboxRecord[]): void => {
  const first = records[0];
  const indexes = new Set(records.map((record) => record.mutationGroupIndex));
  if (
    !first ||
    indexes.size !== records.length ||
    records.some(
      (record) =>
        record.mutationGroupId !== first.mutationGroupId ||
        record.mutationGroupSize !== first.mutationGroupSize ||
        record.mutationGroupIndex < 0 ||
        record.mutationGroupIndex >= first.mutationGroupSize,
    )
  ) {
    throw new LocalOperationStateError('Preostali outbox mutation zapisi nisu konzistentni.');
  }
};

const causalFrontierFromRows = (
  rows: readonly {
    deviceId: string;
    lastDeviceSequence: number;
    lastOperationHash: string | null;
  }[],
): CausalFrontierV1 =>
  rows
    .filter((row) => row.lastDeviceSequence > 0 && row.lastOperationHash !== null)
    .map((row) => ({
      deviceId: row.deviceId,
      deviceSequence: row.lastDeviceSequence,
      operationHash: row.lastOperationHash!,
    }))
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId));

export class SyncOperationRepository {
  constructor(
    private readonly database: FinanceDatabase = db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  readSetup(): Promise<LocalSyncSetup | undefined> {
    return readLocalSyncSetup(this.database);
  }

  readMetadata(): Promise<SyncMetadataRecord | undefined> {
    return this.database.syncMetadata.get(SYNC_METADATA_RECORD_ID);
  }

  readVaultKey(vaultId: string, keyEpoch: number): Promise<SyncKeyRecord | undefined> {
    return this.database.syncKeys.where('[vaultId+keyEpoch]').equals([vaultId, keyEpoch]).first();
  }

  pendingLocalOperationCount(vaultId: string): Promise<number> {
    return this.database.syncOutbox.where('vaultId').equals(vaultId).count();
  }

  async compactionStats(
    vaultId: string,
    afterServerCursor: number,
  ): Promise<{
    readonly operationCount: number;
    readonly encryptedBytes: number;
    readonly pendingConflictCount: number;
  }> {
    const [records, pendingConflictCount] = await Promise.all([
      this.database.syncInbox
        .where('vaultId')
        .equals(vaultId)
        .filter((record) => record.serverCursor > afterServerCursor)
        .toArray(),
      this.database.syncConflicts
        .where('[vaultId+resolutionState]')
        .equals([vaultId, 'pending'])
        .count(),
    ]);
    return {
      operationCount: records.length,
      encryptedBytes: records.reduce(
        (total, record) => total + new TextEncoder().encode(record.encryptedEnvelope).byteLength,
        0,
      ),
      pendingConflictCount,
    };
  }

  async prepareNextGroup(
    setup: LocalSyncSetup,
    vaultMasterKey: Uint8Array,
  ): Promise<readonly SyncOutboxRecord[]> {
    const pending = (
      await this.database.syncOutbox.where('vaultId').equals(setup.vault.vaultId).toArray()
    )
      .filter((record) => record.state !== 'uploading')
      .sort(compareOutbox);
    const first = pending[0];
    if (!first) return [];
    const group = pending
      .filter((record) => record.mutationGroupId === first.mutationGroupId)
      .sort((left, right) => left.mutationGroupIndex - right.mutationGroupIndex);
    assertConsistentGroupRemainder(group);
    if (group.every((record) => record.encryptedEnvelope)) return group;
    assertCompleteGroup(group);
    if (group.some((record) => record.encryptedEnvelope)) {
      throw new LocalOperationStateError('Outbox mutation grupa je delimično pripremljena.');
    }

    return this.database.transaction(
      'rw',
      [
        ...financeTables(this.database),
        this.database.syncOutbox,
        this.database.syncFrontier,
        this.database.syncEntityStates,
      ],
      async () => {
        const currentGroup = (
          await this.database.syncOutbox.where('vaultId').equals(setup.vault.vaultId).toArray()
        )
          .filter((record) => record.mutationGroupId === first.mutationGroupId)
          .sort((left, right) => left.mutationGroupIndex - right.mutationGroupIndex);
        assertCompleteGroup(currentGroup);
        const frontierRows = await this.database.syncFrontier
          .where('vaultId')
          .equals(setup.vault.vaultId)
          .toArray();
        const states = await this.database.syncEntityStates
          .where('vaultId')
          .equals(setup.vault.vaultId)
          .toArray();
        let maximumLamport = states.reduce(
          (maximum, state) => Math.max(maximum, state.lastLamportTime),
          0,
        );
        const frontierByDevice = new Map(frontierRows.map((row) => [row.deviceId, row]));
        const stateById = new Map(states.map((state) => [state.id, state]));
        const prepared: SyncOutboxRecord[] = [];

        for (const record of currentGroup) {
          const intent = parseSyncMutationIntent(record.canonicalPayload);
          if (
            intent.mutationGroupId !== record.mutationGroupId ||
            intent.mutationGroupIndex !== record.mutationGroupIndex ||
            intent.mutationGroupSize !== record.mutationGroupSize ||
            intent.entityType !== record.entityType ||
            intent.entityId !== record.entityId ||
            intent.commandType !== record.command
          ) {
            throw new LocalOperationStateError(
              'Outbox intent i indeksirani metapodaci se ne poklapaju.',
            );
          }
          const stateId = entityStateId(setup.vault.vaultId, intent.entityType, intent.entityId);
          let state = stateById.get(stateId);
          if (!state && intent.previousValue !== null) {
            state = await Dexie.waitFor(
              stateFromValue(
                setup.vault.vaultId,
                intent.entityType,
                intent.entityId,
                intent.previousValue,
                record.createdAt,
              ),
            );
          }
          if (state && !state.tombstone) {
            if (intent.previousValue === null) {
              throw new LocalOperationStateError(
                'Outbox precondition nema prethodnu živu vrednost.',
              );
            }
            const previousHash = await Dexie.waitFor(
              hashEntityState({
                entityType: intent.entityType,
                entityId: intent.entityId,
                entityVersion: state.entityVersion,
                value: intent.previousValue,
                tombstone: null,
              }),
            );
            if (previousHash !== state.stateHash) {
              throw new LocalOperationStateError(
                'Lokalni entitet se promenio mimo outbox redosleda.',
              );
            }
          }
          const precondition = state
            ? {
                entityVersion: state.entityVersion,
                stateHash: state.stateHash,
                tombstone: state.tombstone,
              }
            : { entityVersion: 0, stateHash: null, tombstone: false };
          const ownFrontier = frontierByDevice.get(setup.device.deviceId);
          const deviceSequence = (ownFrontier?.lastDeviceSequence ?? 0) + 1;
          const previousOperationHash = ownFrontier?.lastOperationHash ?? null;
          const causalFrontier = causalFrontierFromRows([...frontierByDevice.values()]);
          maximumLamport = nextLamportTime(maximumLamport);
          const createdAt = record.createdAt;
          const tombstone = intent.commandType.endsWith('.delete')
            ? {
                entityType: intent.entityType,
                entityId: intent.entityId,
                entityVersion: precondition.entityVersion + 1,
                previousStateHash: precondition.stateHash!,
                deletionOperationId: record.operationId,
                deletingDeviceId: setup.device.deviceId,
                deviceSequence,
                lamportTime: maximumLamport,
                causalFrontier,
                deletedAt: createdAt,
              }
            : null;
          const provisional = parseSyncOperation({
            ...protocolOperationDefaults,
            vaultId: setup.vault.vaultId,
            operationId: record.operationId,
            mutationGroupId: record.mutationGroupId,
            mutationGroupIndex: record.mutationGroupIndex,
            mutationGroupSize: record.mutationGroupSize,
            deviceId: setup.device.deviceId,
            deviceSequence,
            lamportTime: maximumLamport,
            causalFrontier,
            ...(intent.resolvesOperationIds
              ? { resolvesOperationIds: intent.resolvesOperationIds }
              : {}),
            command: {
              type: intent.commandType,
              entityType: intent.entityType,
              entityId: intent.entityId,
              precondition,
              result: {
                entityVersion: precondition.entityVersion + 1,
                stateHash: 'A'.repeat(43),
                tombstone: tombstone !== null,
              },
              value: intent.value,
              tombstone,
            },
            previousOperationHash,
            keyEpoch: setup.vault.keyEpoch,
            createdAt,
          });
          const operation = parseSyncOperation({
            ...provisional,
            command: {
              ...provisional.command,
              result: {
                ...provisional.command.result,
                stateHash: await Dexie.waitFor(operationResultStateHash(provisional)),
              },
            },
          });
          const envelope = await Dexie.waitFor(
            createEncryptedOperation({
              operation,
              vaultMasterKey,
              signingPrivateKey: setup.device.signingPrivateKey,
            }),
          );
          const operationHash = await Dexie.waitFor(hashSyncOperation(operation));
          const now = this.now().toISOString();
          const nextRecord: SyncOutboxRecord = {
            ...record,
            deviceSequence,
            state: 'encrypted',
            encryptedEnvelope: canonicalizeJson(envelope),
            updatedAt: now,
          };
          const nextState: SyncEntityStateRecord = {
            id: stateId,
            vaultId: setup.vault.vaultId,
            entityType: intent.entityType,
            entityId: intent.entityId,
            entityVersion: operation.command.result.entityVersion,
            stateHash: operation.command.result.stateHash,
            tombstone: operation.command.result.tombstone,
            canonicalTombstone: operation.command.tombstone
              ? canonicalizeJson(operation.command.tombstone)
              : undefined,
            lastOperationId: operation.operationId,
            lastDeviceId: operation.deviceId,
            lastDeviceSequence: operation.deviceSequence,
            lastLamportTime: operation.lamportTime,
            updatedAt: now,
          };
          const nextFrontier = {
            id: frontierId(setup.vault.vaultId, setup.device.deviceId),
            vaultId: setup.vault.vaultId,
            deviceId: setup.device.deviceId,
            lastDeviceSequence: deviceSequence,
            lastOperationHash: operationHash,
            acknowledgedServerCursor: ownFrontier?.acknowledgedServerCursor ?? 0,
            updatedAt: now,
          };
          await Promise.all([
            this.database.syncOutbox.put(nextRecord),
            this.database.syncEntityStates.put(nextState),
            this.database.syncFrontier.put(nextFrontier),
          ]);
          prepared.push(nextRecord);
          stateById.set(stateId, nextState);
          frontierByDevice.set(setup.device.deviceId, nextFrontier);
        }
        return prepared;
      },
    );
  }

  envelopes(records: readonly SyncOutboxRecord[]): readonly OperationEnvelopeV1[] {
    return records.map(operationEnvelopeFromRecord);
  }

  async markUploadFailed(operationId: string): Promise<void> {
    const record = await this.database.syncOutbox.get(operationId);
    if (!record) return;
    await this.database.syncOutbox.put({
      ...record,
      state: 'failed',
      attemptCount: record.attemptCount + 1,
      updatedAt: this.now().toISOString(),
    });
  }

  async recordAcceptedLocal(
    setup: LocalSyncSetup,
    record: SyncOutboxRecord,
    serverCursor: number,
    operationHash: string,
  ): Promise<void> {
    const envelope = operationEnvelopeFromRecord(record);
    const now = this.now().toISOString();
    await this.database.transaction(
      'rw',
      [this.database.syncOutbox, this.database.syncInbox],
      async () => {
        const current = await this.database.syncOutbox.get(record.id);
        if (!current || current.encryptedEnvelope !== record.encryptedEnvelope) {
          throw new LocalOperationStateError('Outbox operacija se promenila tokom slanja.');
        }
        await this.database.syncInbox.put({
          id: record.operationId,
          vaultId: setup.vault.vaultId,
          operationId: record.operationId,
          serverCursor,
          deviceId: record.deviceId,
          deviceSequence: record.deviceSequence,
          operationHash,
          mutationGroupId: record.mutationGroupId,
          mutationGroupIndex: record.mutationGroupIndex,
          mutationGroupSize: record.mutationGroupSize,
          state: 'applied',
          encryptedEnvelope: canonicalizeJson(envelope),
          receivedAt: now,
          processedAt: now,
        });
        await this.database.syncOutbox.delete(record.id);
      },
    );
  }

  async stageRemoteOperations(
    setup: LocalSyncSetup,
    operations: readonly OpenedRemoteOperation[],
    nextCursor: number,
  ): Promise<void> {
    await this.database.transaction(
      'rw',
      [this.database.syncInbox, this.database.syncFrontier, this.database.syncMetadata],
      async () => {
        const metadata = await this.database.syncMetadata.get(SYNC_METADATA_RECORD_ID);
        if (!metadata || metadata.vaultId !== setup.vault.vaultId) {
          throw new LocalOperationStateError('Sync metadata nedostaje.');
        }
        for (const opened of operations) {
          const { operation, acceptedEnvelope, operationHash } = opened;
          const { serverCursor: acceptedServerCursor, ...rawEnvelope } = acceptedEnvelope;
          const envelope = parseOperationEnvelope(rawEnvelope);
          const existing = await this.database.syncInbox.get(operation.operationId);
          if (existing) {
            if (
              existing.serverCursor !== acceptedServerCursor ||
              existing.encryptedEnvelope !== canonicalizeJson(envelope)
            ) {
              throw new LocalOperationStateError('Server je vratio fork postojeće operacije.');
            }
            continue;
          }
          if (operation.deviceSequence > 1) {
            const predecessor = await this.database.syncInbox
              .where('[vaultId+deviceId+deviceSequence]')
              .equals([setup.vault.vaultId, operation.deviceId, operation.deviceSequence - 1])
              .first();
            const appliedFrontier = await this.database.syncFrontier.get(
              frontierId(setup.vault.vaultId, operation.deviceId),
            );
            const predecessorHash =
              predecessor?.operationHash ??
              (appliedFrontier?.lastDeviceSequence === operation.deviceSequence - 1
                ? appliedFrontier.lastOperationHash
                : null);
            if (predecessorHash !== operation.previousOperationHash) {
              throw new LocalOperationStateError('Prekinut je per-device lanac operacija.');
            }
          }
          for (const causal of operation.causalFrontier) {
            const frontier = await this.database.syncFrontier.get(
              frontierId(setup.vault.vaultId, causal.deviceId),
            );
            if (
              frontier &&
              frontier.lastDeviceSequence === causal.deviceSequence &&
              frontier.lastOperationHash === causal.operationHash
            ) {
              continue;
            }
            const referenced = await this.database.syncInbox
              .where('[vaultId+deviceId+deviceSequence]')
              .equals([setup.vault.vaultId, causal.deviceId, causal.deviceSequence])
              .first();
            if (
              !referenced ||
              referenced.operationHash !== causal.operationHash ||
              referenced.serverCursor >= acceptedServerCursor
            ) {
              throw new LocalOperationStateError('Causal frontier operacije nije lokalno dokaziv.');
            }
          }
          const now = this.now().toISOString();
          await this.database.syncInbox.add({
            id: operation.operationId,
            vaultId: setup.vault.vaultId,
            operationId: operation.operationId,
            serverCursor: acceptedServerCursor,
            deviceId: operation.deviceId,
            deviceSequence: operation.deviceSequence,
            operationHash,
            mutationGroupId: operation.mutationGroupId,
            mutationGroupIndex: operation.mutationGroupIndex,
            mutationGroupSize: operation.mutationGroupSize,
            state: 'received',
            encryptedEnvelope: canonicalizeJson(envelope),
            receivedAt: now,
          });
        }
        if (nextCursor < metadata.lastServerCursor) {
          throw new LocalOperationStateError('Server cursor pokušava rollback.');
        }
        await this.database.syncMetadata.put({
          ...metadata,
          lastServerCursor: nextCursor,
          lastSyncAt: this.now().toISOString(),
        });
      },
    );
  }

  async receivedGroups(vaultId: string): Promise<readonly SyncInboxRecord[][]> {
    const received = await this.database.syncInbox
      .where('[vaultId+state]')
      .equals([vaultId, 'received'])
      .toArray();
    const grouped = new Map<string, SyncInboxRecord[]>();
    for (const record of received) {
      if (!record.mutationGroupId) continue;
      const records = grouped.get(record.mutationGroupId) ?? [];
      records.push(record);
      grouped.set(record.mutationGroupId, records);
    }
    return [...grouped.values()]
      .filter((records) => records.length === records[0]?.mutationGroupSize)
      .map((records) =>
        records.sort(
          (left, right) => (left.mutationGroupIndex ?? 0) - (right.mutationGroupIndex ?? 0),
        ),
      )
      .sort((left, right) => left[0].serverCursor - right[0].serverCursor);
  }

  async applyRemoteGroup(
    setup: LocalSyncSetup,
    openedGroup: readonly OpenedRemoteOperation[],
  ): Promise<'applied' | 'conflicted'> {
    const ordered = [...openedGroup].sort(
      (left, right) => left.operation.mutationGroupIndex - right.operation.mutationGroupIndex,
    );
    const first = ordered[0]?.operation;
    if (
      !first ||
      ordered.length !== first.mutationGroupSize ||
      ordered.some(
        ({ operation }, index) =>
          operation.mutationGroupId !== first.mutationGroupId ||
          operation.mutationGroupSize !== first.mutationGroupSize ||
          operation.mutationGroupIndex !== index,
      )
    ) {
      throw new LocalOperationStateError('Primljena mutation grupa nije kompletna.');
    }
    return this.database.transaction(
      'rw',
      [
        ...financeTables(this.database),
        this.database.syncEntityStates,
        this.database.syncFrontier,
        this.database.syncInbox,
        this.database.syncConflicts,
      ],
      async () => {
        const now = this.now().toISOString();
        const workingStates = new Map<string, SyncEntityStateRecord | null>();
        const proposals: Array<{
          opened: OpenedRemoteOperation;
          current: SyncEntityStateRecord | null;
          localValue: { id: string } | undefined;
          preconditionMatches: boolean;
          resultMatchesCurrent: boolean;
          resolvedConflictIds: readonly string[];
          accepted: boolean;
        }> = [];
        for (const opened of ordered) {
          const { operation } = opened;
          const { command } = operation;
          const stateId = entityStateId(setup.vault.vaultId, command.entityType, command.entityId);
          let current = workingStates.get(stateId);
          const table = entityTable(this.database, command.entityType);
          const localValue = await table.get(command.entityId);
          if (current === undefined) {
            current = (await this.database.syncEntityStates.get(stateId)) ?? null;
            if (!current && localValue) {
              current = await Dexie.waitFor(
                stateFromValue(
                  setup.vault.vaultId,
                  command.entityType,
                  command.entityId,
                  localValue,
                  now,
                ),
              );
            }
          }
          const preconditionMatches = current
            ? command.precondition.entityVersion === current.entityVersion &&
              command.precondition.stateHash === current.stateHash &&
              command.precondition.tombstone === current.tombstone
            : command.precondition.entityVersion === 0 &&
              command.precondition.stateHash === null &&
              !command.precondition.tombstone;
          const resultMatchesCurrent = Boolean(
            current &&
            command.result.stateHash === current.stateHash &&
            command.result.tombstone === current.tombstone,
          );
          const resolvedConflictIds = operation.resolvesOperationIds
            ? (
                await this.database.syncConflicts
                  .where('[vaultId+resolutionState]')
                  .equals([setup.vault.vaultId, 'pending'])
                  .filter(
                    (conflict) =>
                      conflict.entityType === command.entityType &&
                      conflict.entityId === command.entityId &&
                      operation.resolvesOperationIds!.includes(conflict.remoteOperationId),
                  )
                  .toArray()
              ).map((conflict) => conflict.id)
            : [];
          const accepted =
            preconditionMatches || resultMatchesCurrent || resolvedConflictIds.length > 0;
          proposals.push({
            opened,
            current,
            localValue,
            preconditionMatches,
            resultMatchesCurrent,
            resolvedConflictIds,
            accepted,
          });
          if (accepted) {
            const preservesNewerEquivalentState =
              resultMatchesCurrent &&
              current !== null &&
              command.result.entityVersion <= current.entityVersion;
            workingStates.set(
              stateId,
              preservesNewerEquivalentState
                ? current
                : {
                    id: stateId,
                    vaultId: setup.vault.vaultId,
                    entityType: command.entityType,
                    entityId: command.entityId,
                    entityVersion: command.result.entityVersion,
                    stateHash: command.result.stateHash,
                    tombstone: command.result.tombstone,
                    canonicalTombstone: command.tombstone
                      ? canonicalizeJson(command.tombstone)
                      : undefined,
                    lastOperationId: operation.operationId,
                    lastDeviceId: operation.deviceId,
                    lastDeviceSequence: operation.deviceSequence,
                    lastLamportTime: operation.lamportTime,
                    updatedAt: now,
                  },
            );
          }
        }

        if (proposals.every((proposal) => proposal.accepted)) {
          for (const { operation } of ordered) {
            const table = entityTable(this.database, operation.command.entityType);
            if (operation.command.value === null) {
              await table.delete(operation.command.entityId);
            } else {
              const localSettings =
                operation.command.entityType === 'settings'
                  ? await this.database.settings.get('settings')
                  : undefined;
              const value =
                operation.command.entityType === 'settings' && localSettings
                  ? {
                      ...(operation.command.value as Record<string, CanonicalJson>),
                      appearance: localSettings.appearance,
                      installHintDismissed: localSettings.installHintDismissed,
                      ...(localSettings.lastBackupAt
                        ? { lastBackupAt: localSettings.lastBackupAt }
                        : {}),
                    }
                  : operation.command.value;
              await table.put(value as { id: string });
            }
          }
          validateFinanceData(await readFinanceDataInTransaction(this.database));
          await this.database.syncEntityStates.bulkPut(
            [...workingStates.values()].filter(
              (state): state is SyncEntityStateRecord => state !== null,
            ),
          );
          for (const proposal of proposals) {
            const { operation } = proposal.opened;
            for (const conflictId of proposal.resolvedConflictIds) {
              const conflict = await this.database.syncConflicts.get(conflictId);
              if (!conflict || conflict.resolutionState !== 'pending') continue;
              await this.database.syncConflicts.put({
                ...conflict,
                resolutionState: 'resolved-custom',
                resolvedAt: now,
                resolutionOperationId: operation.operationId,
              });
            }
          }
        } else {
          for (const proposal of proposals) {
            const { operation } = proposal.opened;
            await this.database.syncConflicts.put({
              id: `${setup.vault.vaultId}:${operation.operationId}`,
              vaultId: setup.vault.vaultId,
              entityType: operation.command.entityType,
              entityId: operation.command.entityId,
              localOperationId: proposal.current?.lastOperationId ?? 'snapshot-baseline',
              remoteOperationId: operation.operationId,
              mutationGroupId: operation.mutationGroupId,
              mutationGroupIndex: operation.mutationGroupIndex,
              mutationGroupSize: operation.mutationGroupSize,
              localCanonicalProposal: canonicalizeJson(
                normalizeSyncJsonValue(
                  proposal.localValue ?? {
                    tombstone: proposal.current?.tombstone ?? false,
                    stateHash: proposal.current?.stateHash ?? null,
                  },
                ),
              ),
              remoteCanonicalProposal: canonicalizeJson({
                value: operation.command.value,
                tombstone: operation.command.tombstone,
              }),
              causalMetadata: canonicalizeJson({
                mutationGroupId: operation.mutationGroupId,
                mutationGroupIndex: operation.mutationGroupIndex,
                mutationGroupSize: operation.mutationGroupSize,
                localState: proposal.current
                  ? {
                      entityVersion: proposal.current.entityVersion,
                      stateHash: proposal.current.stateHash,
                      tombstone: proposal.current.tombstone,
                    }
                  : null,
                remotePrecondition: operation.command.precondition,
                remoteFrontier: operation.causalFrontier,
              }),
              resolutionState: 'pending',
              detectedAt: now,
            });
          }
        }

        for (const opened of ordered) {
          const { operation, operationHash } = opened;
          const currentFrontier = await this.database.syncFrontier.get(
            frontierId(setup.vault.vaultId, operation.deviceId),
          );
          if (
            currentFrontier &&
            operation.deviceSequence !== currentFrontier.lastDeviceSequence + 1
          ) {
            throw new LocalOperationStateError('Primena bi preskočila per-device sequence.');
          }
          await this.database.syncFrontier.put({
            id: frontierId(setup.vault.vaultId, operation.deviceId),
            vaultId: setup.vault.vaultId,
            deviceId: operation.deviceId,
            lastDeviceSequence: operation.deviceSequence,
            lastOperationHash: operationHash,
            acknowledgedServerCursor: currentFrontier?.acknowledgedServerCursor ?? 0,
            updatedAt: now,
          });
          const inbox = await this.database.syncInbox.get(operation.operationId);
          if (!inbox) throw new LocalOperationStateError('Primljena operacija nije staged.');
          await this.database.syncInbox.put({
            ...inbox,
            state: proposals.every((proposal) => proposal.accepted) ? 'applied' : 'conflicted',
            processedAt: now,
          });
        }
        return proposals.every((proposal) => proposal.accepted) ? 'applied' : 'conflicted';
      },
    );
  }

  async advanceAcknowledgedCursor(setup: LocalSyncSetup): Promise<number> {
    return this.database.transaction(
      'rw',
      [this.database.syncInbox, this.database.syncFrontier, this.database.syncMetadata],
      async () => {
        const metadata = await this.database.syncMetadata.get(SYNC_METADATA_RECORD_ID);
        if (!metadata || metadata.vaultId !== setup.vault.vaultId) return 0;
        const pending = await this.database.syncInbox
          .where('[vaultId+state]')
          .equals([setup.vault.vaultId, 'received'])
          .sortBy('serverCursor');
        const cursor = pending[0]
          ? Math.max(
              0,
              ...(
                await this.database.syncInbox
                  .where('vaultId')
                  .equals(setup.vault.vaultId)
                  .filter((record) => record.serverCursor < pending[0].serverCursor)
                  .toArray()
              ).map((record) => record.serverCursor),
            )
          : metadata.lastServerCursor;
        const id = frontierId(setup.vault.vaultId, setup.device.deviceId);
        const frontier = await this.database.syncFrontier.get(id);
        await this.database.syncFrontier.put({
          id,
          vaultId: setup.vault.vaultId,
          deviceId: setup.device.deviceId,
          lastDeviceSequence: frontier?.lastDeviceSequence ?? 0,
          lastOperationHash: frontier?.lastOperationHash ?? null,
          acknowledgedServerCursor: Math.max(frontier?.acknowledgedServerCursor ?? 0, cursor),
          updatedAt: this.now().toISOString(),
        });
        return cursor;
      },
    );
  }
}
