import { LocalOperationStateError, SyncOperationRepository } from '@/db/sync/operation-repository';
import type { LocalSyncSetup, SyncMetadataRecord } from '@/db/sync/records';
import {
  canRevalidateSnapshotManifest,
  SnapshotSyncError,
  type SnapshotSyncOptions,
  type SnapshotSyncResult,
} from './snapshot-service';
import type { OperationSyncOptions, OperationSyncResult } from './operation-service';

const COMPACTION_OPERATION_THRESHOLD = 100;
const COMPACTION_ENCRYPTED_BYTES_THRESHOLD = 1024 * 1024;
const MAX_PENDING_CONFLICTS = 100;
const MAX_UNCOMPACTED_OPERATIONS = 5_000;
const SAFE_PAUSE_MESSAGE =
  'Sinhronizacija je privremeno pauzirana zbog ograničenja servisa. Promene ostaju sačuvane na ovom uređaju.';

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

export type SyncCyclePhase =
  | 'setup'
  | 'manifest'
  | 'security'
  | 'bootstrap'
  | 'operations'
  | 'snapshot'
  | 'acknowledgement'
  | 'checkpoint';

export interface SyncCycleDiagnostic {
  readonly phase: SyncCyclePhase;
  readonly outcome: 'completed' | 'incomplete' | 'error';
  readonly code: string;
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
  readonly recordCompletedSync: (
    vaultId: string,
    acknowledgedServerCursor: number,
  ) => Promise<boolean>;
  readonly compactionStats: (
    vaultId: string,
    afterServerCursor: number,
  ) => Promise<{
    readonly operationCount: number;
    readonly encryptedBytes: number;
    readonly pendingConflictCount: number;
  }>;
}

const diagnosticErrorCode = (error: unknown): string => {
  if (error instanceof LocalOperationStateError) return 'LOCAL_STATE_CHANGED';
  if (error instanceof SnapshotSyncError) return error.code.replaceAll('-', '_').toUpperCase();
  return 'SYNC_CYCLE_FAILED';
};

const canContinueAfterSnapshot = (
  result: SnapshotSyncResult,
): result is Extract<SnapshotSyncResult, { kind: 'uploaded' | 'downloaded' | 'up-to-date' }> =>
  result.kind === 'uploaded' || result.kind === 'downloaded' || result.kind === 'up-to-date';

export class ContinuousSyncService {
  readonly #operations: ContinuousOperationSyncPort;
  readonly #snapshots: ContinuousSnapshotSyncPort;
  readonly #repository: ContinuousSyncRepositoryPort;
  readonly #security?: ContinuousDeviceSecurityPort;
  readonly #reportDiagnostic?: (diagnostic: SyncCycleDiagnostic) => Promise<void>;
  #queue: Promise<void> = Promise.resolve();

  constructor(input: {
    operations: ContinuousOperationSyncPort;
    snapshots: ContinuousSnapshotSyncPort;
    security?: ContinuousDeviceSecurityPort;
    repository?: ContinuousSyncRepositoryPort;
    reportDiagnostic?: (diagnostic: SyncCycleDiagnostic) => Promise<void>;
  }) {
    this.#operations = input.operations;
    this.#snapshots = input.snapshots;
    this.#security = input.security;
    this.#reportDiagnostic = input.reportDiagnostic;
    this.#repository = input.repository ?? new SyncOperationRepository();
  }

  synchronize(options: ContinuousSyncOptions = {}): Promise<ContinuousSyncResult> {
    const operation = this.#queue.then(async () => {
      const phase = { current: 'setup' as SyncCyclePhase };
      const setPhase = (next: SyncCyclePhase) => {
        phase.current = next;
      };
      try {
        const result = await this.#synchronizeOnce(options, setPhase);
        const completed =
          result.kind === 'synchronized' &&
          result.pendingLocalOperations === 0 &&
          result.conflictedGroups === 0 &&
          phase.current === 'checkpoint';
        await this.#report({
          phase: phase.current,
          outcome: completed ? 'completed' : 'incomplete',
          code: completed ? 'SYNC_COMPLETED' : 'SYNC_INCOMPLETE',
        });
        return result;
      } catch (error) {
        await this.#report({
          phase: phase.current,
          outcome: 'error',
          code: diagnosticErrorCode(error),
        });
        throw error;
      }
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #report(diagnostic: SyncCycleDiagnostic): Promise<void> {
    try {
      await this.#reportDiagnostic?.(diagnostic);
    } catch {
      // Local diagnostics must never change the result of a financial sync.
    }
  }

  async #synchronizeOnce(
    options: ContinuousSyncOptions,
    setPhase: (phase: SyncCyclePhase) => void,
  ): Promise<ContinuousSyncResult> {
    const beforeSecurity = await this.#repository.readSetup();
    if (beforeSecurity && canRevalidateSnapshotManifest(beforeSecurity.metadata)) {
      setPhase('manifest');
      const revalidated = await this.#snapshots.synchronize({
        continuousOperations: true,
        signal: options.signal,
      });
      if (!canContinueAfterSnapshot(revalidated)) return revalidated;
    }
    setPhase('security');
    await this.#security?.reconcileKeyEpoch();
    const initialSetup = await this.#repository.readSetup();
    if (!initialSetup) throw new Error('Sinhronizacija nije uključena na ovom uređaju.');
    const bootstrapping = initialSetup.metadata.lastSnapshotRevision === 0;
    if (bootstrapping) {
      setPhase('bootstrap');
      const bootstrap = await this.#snapshots.synchronize({
        allowInitialUpload: options.allowInitialUpload,
        continuousOperations: true,
        signal: options.signal,
      });
      if (!canContinueAfterSnapshot(bootstrap)) return bootstrap;
    }

    setPhase('operations');
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
    setPhase('snapshot');
    const snapshotResult = await this.#snapshots.synchronize({
      continuousOperations: true,
      forceCompaction: shouldCompact,
      signal: options.signal,
    });
    if (!canContinueAfterSnapshot(snapshotResult)) return snapshotResult;
    setPhase('acknowledgement');
    const acknowledgedServerCursor = await this.#operations.acknowledge();
    setPhase('checkpoint');
    const metadata = await this.#repository.readMetadata();
    if (!metadata) throw new Error('Sync metadata nedostaje posle potvrde frontiera.');
    if (
      operationResult.pendingLocalOperations === 0 &&
      !(await this.#repository.recordCompletedSync(
        setupAfterOperations.vault.vaultId,
        acknowledgedServerCursor,
      ))
    ) {
      throw new LocalOperationStateError(
        'Sinhronizacija nije završena: lokalno stanje se promenilo tokom provere.',
      );
    }
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
