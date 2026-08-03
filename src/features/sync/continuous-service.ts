import { SyncOperationRepository } from '@/db/sync/operation-repository';
import type { LocalSyncSetup, SyncMetadataRecord } from '@/db/sync/records';
import type { SnapshotSyncOptions, SnapshotSyncResult } from './snapshot-service';
import type { OperationSyncOptions, OperationSyncResult } from './operation-service';

const COMPACTION_OPERATION_THRESHOLD = 100;
const COMPACTION_ENCRYPTED_BYTES_THRESHOLD = 1024 * 1024;
const MAX_PENDING_CONFLICTS = 100;
const MAX_UNCOMPACTED_OPERATIONS = 5_000;
const SAFE_PAUSE_MESSAGE =
  'Beta sinhronizacija je privremeno pauzirana zbog ograničenja testnog servisa. Promene ostaju sačuvane na ovom uređaju.';

export type ContinuousSyncResult =
  | SnapshotSyncResult
  | {
      readonly kind: 'synchronized';
      readonly revision: number;
      readonly uploadedOperations: number;
      readonly downloadedOperations: number;
      readonly appliedGroups: number;
      readonly conflictedGroups: number;
      readonly pendingLocalOperations: number;
      readonly acknowledgedServerCursor: number;
      readonly compacted: boolean;
    };

export interface ContinuousSyncOptions {
  readonly allowInitialUpload?: boolean;
  readonly forceCompaction?: boolean;
  readonly signal?: AbortSignal;
}

export interface ContinuousOperationSyncPort {
  readonly synchronize: (options?: OperationSyncOptions) => Promise<OperationSyncResult>;
  readonly acknowledge: () => Promise<number>;
}

export interface ContinuousSnapshotSyncPort {
  readonly synchronize: (options?: SnapshotSyncOptions) => Promise<SnapshotSyncResult>;
}

export interface ContinuousDeviceSecurityPort {
  readonly reconcileKeyEpoch: () => Promise<LocalSyncSetup>;
}

export interface ContinuousSyncRepositoryPort {
  readonly readSetup: () => Promise<LocalSyncSetup | undefined>;
  readonly readMetadata: () => Promise<SyncMetadataRecord | undefined>;
  readonly compactionStats: (
    vaultId: string,
    afterServerCursor: number,
  ) => Promise<{
    readonly operationCount: number;
    readonly encryptedBytes: number;
    readonly pendingConflictCount: number;
  }>;
}

const canContinueAfterSnapshot = (
  result: SnapshotSyncResult,
): result is Extract<SnapshotSyncResult, { kind: 'uploaded' | 'downloaded' | 'up-to-date' }> =>
  result.kind === 'uploaded' || result.kind === 'downloaded' || result.kind === 'up-to-date';

export class ContinuousSyncService {
  readonly #operations: ContinuousOperationSyncPort;
  readonly #snapshots: ContinuousSnapshotSyncPort;
  readonly #repository: ContinuousSyncRepositoryPort;
  readonly #security?: ContinuousDeviceSecurityPort;
  #queue: Promise<void> = Promise.resolve();

  constructor(input: {
    operations: ContinuousOperationSyncPort;
    snapshots: ContinuousSnapshotSyncPort;
    security?: ContinuousDeviceSecurityPort;
    repository?: ContinuousSyncRepositoryPort;
  }) {
    this.#operations = input.operations;
    this.#snapshots = input.snapshots;
    this.#security = input.security;
    this.#repository = input.repository ?? new SyncOperationRepository();
  }

  synchronize(options: ContinuousSyncOptions = {}): Promise<ContinuousSyncResult> {
    const operation = this.#queue.then(() => this.#synchronizeOnce(options));
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #synchronizeOnce(options: ContinuousSyncOptions): Promise<ContinuousSyncResult> {
    await this.#security?.reconcileKeyEpoch();
    const initialSetup = await this.#repository.readSetup();
    if (!initialSetup) throw new Error('Sinhronizacija nije uključena na ovom uređaju.');
    const bootstrapping = initialSetup.metadata.lastSnapshotRevision === 0;
    if (bootstrapping) {
      const bootstrap = await this.#snapshots.synchronize({
        allowInitialUpload: options.allowInitialUpload,
        continuousOperations: true,
        signal: options.signal,
      });
      if (!canContinueAfterSnapshot(bootstrap)) return bootstrap;
    }

    const operationResult = await this.#operations.synchronize({ acknowledge: false });
    const setupAfterOperations = await this.#repository.readSetup();
    if (!setupAfterOperations) throw new Error('Lokalno sync stanje je uklonjeno tokom obrade.');
    const stats = await this.#repository.compactionStats(
      setupAfterOperations.vault.vaultId,
      setupAfterOperations.metadata.lastSnapshotServerCursor,
    );
    if (
      stats.pendingConflictCount >= MAX_PENDING_CONFLICTS ||
      stats.operationCount >= MAX_UNCOMPACTED_OPERATIONS
    ) {
      throw new Error(SAFE_PAUSE_MESSAGE);
    }
    if (stats.pendingConflictCount > 0) {
      const metadata = await this.#repository.readMetadata();
      if (!metadata) throw new Error('Sync metadata nedostaje posle obrade konflikta.');
      return this.#result(
        operationResult,
        operationResult.acknowledgedServerCursor,
        metadata.lastSnapshotRevision,
        false,
      );
    }
    const shouldCompact =
      (!bootstrapping &&
        (options.forceCompaction === true ||
          setupAfterOperations.metadata.pendingKeyRotationSnapshotEpoch ===
            setupAfterOperations.vault.keyEpoch)) ||
      stats.operationCount >= COMPACTION_OPERATION_THRESHOLD ||
      stats.encryptedBytes >= COMPACTION_ENCRYPTED_BYTES_THRESHOLD;
    const snapshotResult = await this.#snapshots.synchronize({
      continuousOperations: true,
      forceCompaction: shouldCompact,
      signal: options.signal,
    });
    if (!canContinueAfterSnapshot(snapshotResult)) return snapshotResult;
    const acknowledgedServerCursor = await this.#operations.acknowledge();
    const metadata = await this.#repository.readMetadata();
    if (!metadata) throw new Error('Sync metadata nedostaje posle potvrde frontiera.');
    return this.#result(
      operationResult,
      acknowledgedServerCursor,
      metadata.lastSnapshotRevision,
      shouldCompact,
    );
  }

  #result(
    operations: OperationSyncResult,
    acknowledgedServerCursor: number,
    revision: number,
    compacted: boolean,
  ): Extract<ContinuousSyncResult, { kind: 'synchronized' }> {
    return {
      kind: 'synchronized',
      revision,
      uploadedOperations: operations.uploaded,
      downloadedOperations: operations.downloaded,
      appliedGroups: operations.appliedGroups,
      conflictedGroups: operations.conflictedGroups,
      pendingLocalOperations: operations.pendingLocalOperations,
      acknowledgedServerCursor,
      compacted,
    };
  }
}
