import { canonicalizeJson } from '@/domain/sync/canonical';
import type { FinanceData } from '@/domain/types';
import { db, financeTables, type FinanceDatabase } from '../database';
import {
  readFinanceDataInTransaction,
  readRawFinanceDataInTransaction,
  replaceFinanceDataInTransaction,
  validateFinanceData,
} from '../finance-data';
import { readLocalSyncSetup, writeLocalSyncSetup } from './repository';
import {
  SYNC_CHECKPOINT_RECORD_ID,
  SYNC_METADATA_RECORD_ID,
  type LocalSyncSetup,
  type SyncMetadataRecord,
} from './records';
import type { SnapshotCausalFrontierV1 } from '@/domain/sync/snapshot';
import {
  createBaselineSnapshotEntityStates,
  createSyncFinanceData,
  snapshotEntityStatesSchema,
  type SnapshotEntityStateV1,
} from '@/domain/sync/snapshot';
import { operationTombstoneSchema } from '@/domain/sync/operation';

export class LocalSnapshotRaceError extends Error {
  constructor() {
    super('Lokalno sync stanje se promenilo tokom obrade snimka.');
    this.name = 'LocalSnapshotRaceError';
  }
}

export type SnapshotMetadataChanges = Pick<
  SyncMetadataRecord,
  | 'firstUploadConsent'
  | 'lastServerCursor'
  | 'lastSnapshotServerCursor'
  | 'lastSnapshotRevision'
  | 'lastSnapshotId'
  | 'lastSnapshotHash'
  | 'lastSnapshotContentHash'
  | 'lastManifestHash'
  | 'lastLocalDataHash'
> &
  Partial<
    Pick<
      SyncMetadataRecord,
      'lastSyncAt' | 'lastSuccessfulSyncAt' | 'lastErrorCode' | 'syncBlockReason'
    >
  >;

export class SyncSnapshotRepository {
  constructor(private readonly database: FinanceDatabase = db) {}

  readSetup(): Promise<LocalSyncSetup | undefined> {
    return readLocalSyncSetup(this.database);
  }

  writeSetup(setup: LocalSyncSetup): Promise<void> {
    return writeLocalSyncSetup(setup, this.database);
  }

  readFinanceData(): Promise<FinanceData> {
    return this.database.transaction('r', financeTables(this.database), () =>
      readFinanceDataInTransaction(this.database),
    );
  }

  readFinanceDataForRemoteBootstrap(): Promise<FinanceData | null> {
    return this.database.transaction('r', financeTables(this.database), async () => {
      const data = await readRawFinanceDataInTransaction(this.database);
      if (Object.values(data).every((records) => records.length === 0)) return null;
      return validateFinanceData(data);
    });
  }

  async readCausalFrontier(vaultId: string): Promise<SnapshotCausalFrontierV1> {
    const rows = await this.database.syncFrontier.where('vaultId').equals(vaultId).toArray();
    return {
      serverCursor: rows.reduce(
        (maximum, row) => Math.max(maximum, row.acknowledgedServerCursor),
        0,
      ),
      devices: rows
        .filter((row) => row.lastDeviceSequence > 0 && row.lastOperationHash !== null)
        .map((row) => ({
          deviceId: row.deviceId,
          deviceSequence: row.lastDeviceSequence,
          lastOperationHash: row.lastOperationHash!,
        })),
    };
  }

  async readEntityStatesForSnapshot(
    vaultId: string,
    data: FinanceData,
  ): Promise<SnapshotEntityStateV1[]> {
    const baseline = await createBaselineSnapshotEntityStates(createSyncFinanceData(data));
    const states = new Map(
      baseline.map((state) => [`${state.entityType}\u0000${state.entityId}`, state] as const),
    );
    const stored = await this.database.syncEntityStates.where('vaultId').equals(vaultId).toArray();
    for (const state of stored) {
      states.set(`${state.entityType}\u0000${state.entityId}`, {
        entityType: state.entityType,
        entityId: state.entityId,
        entityVersion: state.entityVersion,
        stateHash: state.stateHash,
        tombstone: state.tombstone,
        tombstoneMetadata: state.canonicalTombstone
          ? operationTombstoneSchema.parse(JSON.parse(state.canonicalTombstone) as unknown)
          : null,
        lastOperationId: state.lastOperationId,
        lastDeviceId: state.lastDeviceId,
        lastDeviceSequence: state.lastDeviceSequence,
        lastLamportTime: state.lastLamportTime,
      });
    }
    return snapshotEntityStatesSchema.parse(
      [...states.values()].sort(
        (left, right) =>
          left.entityType.localeCompare(right.entityType) ||
          left.entityId.localeCompare(right.entityId),
      ),
    );
  }

  async writeSafetyCheckpoint(
    setup: LocalSyncSetup,
    data: FinanceData,
    createdAt: string,
  ): Promise<void> {
    const validated = validateFinanceData(data);
    await this.database.syncCheckpoints.put({
      id: SYNC_CHECKPOINT_RECORD_ID,
      vaultId: setup.vault.vaultId,
      replacedSnapshotRevision: setup.metadata.lastSnapshotRevision,
      data: validated,
      createdAt,
    });
  }

  async updateMetadata(
    vaultId: string,
    expectedSnapshotRevision: number,
    changes: SnapshotMetadataChanges,
  ): Promise<void> {
    await this.database.transaction('rw', this.database.syncMetadata, async () => {
      const current = await this.database.syncMetadata.get(SYNC_METADATA_RECORD_ID);
      if (
        !current ||
        current.vaultId !== vaultId ||
        current.lastSnapshotRevision !== expectedSnapshotRevision
      ) {
        throw new LocalSnapshotRaceError();
      }
      await this.database.syncMetadata.put({ ...current, ...changes });
    });
  }

  async applyRemoteSnapshot(
    setup: LocalSyncSetup,
    data: FinanceData,
    changes: SnapshotMetadataChanges,
    entityStates?: readonly SnapshotEntityStateV1[],
  ): Promise<void> {
    const validated = validateFinanceData(data);
    const snapshotStates =
      entityStates ?? (await createBaselineSnapshotEntityStates(createSyncFinanceData(validated)));
    await this.database.transaction(
      'rw',
      [...financeTables(this.database), this.database.syncMetadata, this.database.syncEntityStates],
      async () => {
        const current = await this.database.syncMetadata.get(SYNC_METADATA_RECORD_ID);
        if (
          !current ||
          current.vaultId !== setup.vault.vaultId ||
          current.lastSnapshotRevision !== setup.metadata.lastSnapshotRevision ||
          current.lastSnapshotHash !== setup.metadata.lastSnapshotHash
        ) {
          throw new LocalSnapshotRaceError();
        }
        await replaceFinanceDataInTransaction(this.database, validated);
        await this.database.syncEntityStates.clear();
        await this.database.syncEntityStates.bulkPut(
          snapshotStates.map((state) => ({
            id: `${setup.vault.vaultId}:${state.entityType}:${state.entityId}`,
            vaultId: setup.vault.vaultId,
            entityType: state.entityType,
            entityId: state.entityId,
            entityVersion: state.entityVersion,
            stateHash: state.stateHash,
            tombstone: state.tombstone,
            canonicalTombstone: state.tombstoneMetadata
              ? canonicalizeJson(state.tombstoneMetadata)
              : undefined,
            lastOperationId: state.lastOperationId,
            lastDeviceId: state.lastDeviceId,
            lastDeviceSequence: state.lastDeviceSequence,
            lastLamportTime: state.lastLamportTime,
            updatedAt: changes.lastSyncAt ?? new Date().toISOString(),
          })),
        );
        await this.database.syncMetadata.put({ ...current, ...changes });
      },
    );
  }

  async acceptCompactionSnapshot(
    setup: LocalSyncSetup,
    changes: SnapshotMetadataChanges,
    causalFrontier: SnapshotCausalFrontierV1,
    entityStates: readonly SnapshotEntityStateV1[],
  ): Promise<boolean> {
    return this.database.transaction(
      'rw',
      [
        this.database.syncMetadata,
        this.database.syncFrontier,
        this.database.syncInbox,
        this.database.syncEntityStates,
        this.database.syncConflicts,
      ],
      async () => {
        const currentMetadata = await this.database.syncMetadata.get(SYNC_METADATA_RECORD_ID);
        if (
          !currentMetadata ||
          currentMetadata.vaultId !== setup.vault.vaultId ||
          currentMetadata.lastSnapshotRevision !== setup.metadata.lastSnapshotRevision ||
          currentMetadata.lastSnapshotHash !== setup.metadata.lastSnapshotHash ||
          causalFrontier.serverCursor > currentMetadata.lastServerCursor
        ) {
          return false;
        }
        const unresolvedConflict = await this.database.syncConflicts
          .where('[vaultId+resolutionState]')
          .equals([setup.vault.vaultId, 'pending'])
          .first();
        if (unresolvedConflict) return false;

        for (const device of causalFrontier.devices) {
          const localFrontier = await this.database.syncFrontier.get(
            `${setup.vault.vaultId}:${device.deviceId}`,
          );
          if (
            localFrontier?.lastDeviceSequence === device.deviceSequence &&
            localFrontier.lastOperationHash === device.lastOperationHash
          ) {
            continue;
          }
          const referenced = await this.database.syncInbox
            .where('[vaultId+deviceId+deviceSequence]')
            .equals([setup.vault.vaultId, device.deviceId, device.deviceSequence])
            .first();
          if (
            referenced?.operationHash !== device.lastOperationHash ||
            referenced.state !== 'applied'
          ) {
            return false;
          }
        }

        for (const state of entityStates) {
          const localState = await this.database.syncEntityStates.get(
            `${setup.vault.vaultId}:${state.entityType}:${state.entityId}`,
          );
          if (!localState || localState.entityVersion < state.entityVersion) return false;
          if (
            localState.entityVersion === state.entityVersion &&
            (localState.stateHash !== state.stateHash || localState.tombstone !== state.tombstone)
          ) {
            return false;
          }
          if (state.lastOperationId) {
            const accepted = await this.database.syncInbox.get(state.lastOperationId);
            if (accepted?.state !== 'applied') return false;
          }
        }

        await this.database.syncMetadata.put({ ...currentMetadata, ...changes });
        return true;
      },
    );
  }

  async recordSnapshotConflict(input: {
    setup: LocalSyncSetup;
    remoteSnapshotId: string;
    remoteRevision: number;
    remoteHash: string;
    localDataHash: string;
    detectedAt: string;
  }): Promise<void> {
    const { setup } = input;
    await this.database.transaction(
      'rw',
      [this.database.syncConflicts, this.database.syncMetadata],
      async () => {
        await this.database.syncConflicts.put({
          id: `snapshot:${setup.vault.vaultId}:${input.remoteSnapshotId}`,
          vaultId: setup.vault.vaultId,
          entityType: 'snapshot',
          entityId: input.remoteSnapshotId,
          localOperationId: setup.metadata.lastSnapshotId ?? 'local-uncommitted-state',
          remoteOperationId: input.remoteSnapshotId,
          localCanonicalProposal: canonicalizeJson({
            localDataHash: input.localDataHash,
            baseRevision: setup.metadata.lastSnapshotRevision,
          }),
          remoteCanonicalProposal: canonicalizeJson({
            snapshotHash: input.remoteHash,
            revision: input.remoteRevision,
          }),
          causalMetadata: canonicalizeJson({
            localSnapshotHash: setup.metadata.lastSnapshotHash,
            remoteSnapshotHash: input.remoteHash,
          }),
          resolutionState: 'pending',
          detectedAt: input.detectedAt,
        });
        const current = await this.database.syncMetadata.get(SYNC_METADATA_RECORD_ID);
        if (!current || current.vaultId !== setup.vault.vaultId) {
          throw new LocalSnapshotRaceError();
        }
        await this.database.syncMetadata.put({
          ...current,
          lastSyncAt: input.detectedAt,
          lastErrorCode: 'LOCAL_REMOTE_SNAPSHOT_CONFLICT',
          syncBlockReason: 'local-remote-conflict',
        });
      },
    );
  }
}
