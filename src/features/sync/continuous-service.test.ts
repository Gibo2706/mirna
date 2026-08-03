import { describe, expect, it, vi } from 'vitest';
import type { LocalSyncSetup, SyncMetadataRecord } from '@/db/sync/records';
import type { SnapshotSyncResult } from './snapshot-service';
import {
  ContinuousSyncService,
  type ContinuousOperationSyncPort,
  type ContinuousSnapshotSyncPort,
  type ContinuousSyncRepositoryPort,
} from './continuous-service';

const vaultId = 'VVVVVVVVVVVVVVVVVVVVVV';

const metadata = (overrides: Partial<SyncMetadataRecord> = {}): SyncMetadataRecord => ({
  id: 'sync-metadata',
  vaultId,
  localSchemaVersion: 1,
  bootstrapMode: overrides.bootstrapMode ?? 'complete',
  firstUploadConsent: 'accepted',
  lastServerCursor: 8,
  lastSnapshotServerCursor: 3,
  lastSnapshotRevision: 2,
  lastSnapshotId: 'SSSSSSSSSSSSSSSSSSSSSS',
  lastSnapshotHash: 'H'.repeat(43),
  lastSnapshotContentHash: 'C'.repeat(43),
  lastManifestHash: 'M'.repeat(43),
  lastLocalDataHash: 'D'.repeat(43),
  enabledAt: '2034-01-01T00:00:00.000Z',
  ...overrides,
});

const setup = (value: SyncMetadataRecord): LocalSyncSetup =>
  ({ vault: { vaultId }, metadata: value }) as LocalSyncSetup;

const operationResult = {
  uploaded: 2,
  downloaded: 3,
  appliedGroups: 2,
  conflictedGroups: 0,
  pendingLocalOperations: 0,
  acknowledgedServerCursor: 8,
} as const;

const createPorts = (input?: {
  initialMetadata?: SyncMetadataRecord;
  stats?: { operationCount: number; encryptedBytes: number; pendingConflictCount: number };
  snapshotResult?: SnapshotSyncResult;
}) => {
  const initial = input?.initialMetadata ?? metadata();
  const readSetup = vi.fn<ContinuousSyncRepositoryPort['readSetup']>(() =>
    Promise.resolve(setup(initial)),
  );
  const repository: ContinuousSyncRepositoryPort = {
    readSetup,
    readMetadata: vi.fn(() => Promise.resolve(initial)),
    compactionStats: vi.fn(() =>
      Promise.resolve(
        input?.stats ?? {
          operationCount: 1,
          encryptedBytes: 256,
          pendingConflictCount: 0,
        },
      ),
    ),
  };
  const operations: ContinuousOperationSyncPort = {
    synchronize: vi.fn(() => Promise.resolve(operationResult)),
    acknowledge: vi.fn(() => Promise.resolve(8)),
  };
  const snapshots: ContinuousSnapshotSyncPort = {
    synchronize: vi.fn(() =>
      Promise.resolve<SnapshotSyncResult>(
        input?.snapshotResult ?? { kind: 'up-to-date', revision: 2 },
      ),
    ),
  };
  return { repository, operations, snapshots, readSetup };
};

describe('continuous encrypted sync orchestration', () => {
  it('does not start operation sync before explicit initial snapshot consent', async () => {
    const ports = createPorts({
      initialMetadata: metadata({
        firstUploadConsent: 'pending',
        lastServerCursor: 0,
        lastSnapshotServerCursor: 0,
        lastSnapshotRevision: 0,
        lastSnapshotId: null,
        lastSnapshotHash: null,
        lastSnapshotContentHash: null,
        lastLocalDataHash: null,
      }),
    });
    vi.mocked(ports.snapshots.synchronize).mockResolvedValue({
      kind: 'awaiting-upload-consent',
      revision: 0,
    });
    const service = new ContinuousSyncService(ports);

    await expect(service.synchronize()).resolves.toEqual({
      kind: 'awaiting-upload-consent',
      revision: 0,
    });
    expect(ports.operations.synchronize).not.toHaveBeenCalled();
    expect(ports.operations.acknowledge).not.toHaveBeenCalled();
  });

  it('uploads and pulls operations before snapshot reconciliation and ACK', async () => {
    const ports = createPorts({
      stats: { operationCount: 100, encryptedBytes: 1_024, pendingConflictCount: 0 },
    });
    const order: string[] = [];
    vi.mocked(ports.operations.synchronize).mockImplementation(() => {
      order.push('operations');
      return Promise.resolve(operationResult);
    });
    vi.mocked(ports.snapshots.synchronize).mockImplementation(() => {
      order.push('snapshot');
      return Promise.resolve({ kind: 'uploaded', revision: 3 });
    });
    vi.mocked(ports.operations.acknowledge).mockImplementation(() => {
      order.push('ack');
      return Promise.resolve(8);
    });
    vi.mocked(ports.repository.readMetadata).mockResolvedValue(
      metadata({ lastSnapshotRevision: 3 }),
    );
    const service = new ContinuousSyncService(ports);

    await expect(service.synchronize()).resolves.toMatchObject({
      kind: 'synchronized',
      revision: 3,
      uploadedOperations: 2,
      downloadedOperations: 3,
      compacted: true,
    });
    expect(order).toEqual(['operations', 'snapshot', 'ack']);
    expect(ports.operations.synchronize).toHaveBeenCalledWith({ acknowledge: false });
    expect(ports.snapshots.synchronize).toHaveBeenCalledWith({
      continuousOperations: true,
      forceCompaction: true,
      signal: undefined,
    });
  });

  it('does not ACK past a snapshot reconciliation conflict', async () => {
    const ports = createPorts({
      snapshotResult: {
        kind: 'blocked',
        revision: 2,
        reason: 'local-remote-conflict',
      },
    });
    const service = new ContinuousSyncService(ports);

    await expect(service.synchronize()).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'local-remote-conflict',
    });
    expect(ports.operations.acknowledge).not.toHaveBeenCalled();
  });

  it('defers snapshot reconciliation and server ACK while a conflict awaits resolution', async () => {
    const ports = createPorts({
      stats: { operationCount: 4, encryptedBytes: 1_024, pendingConflictCount: 1 },
    });
    vi.mocked(ports.operations.synchronize).mockResolvedValue({
      ...operationResult,
      conflictedGroups: 1,
    });
    const service = new ContinuousSyncService(ports);

    await expect(service.synchronize({ forceCompaction: true })).resolves.toMatchObject({
      kind: 'synchronized',
      revision: 2,
      conflictedGroups: 1,
      compacted: false,
      acknowledgedServerCursor: 8,
    });
    expect(ports.snapshots.synchronize).not.toHaveBeenCalled();
    expect(ports.operations.acknowledge).not.toHaveBeenCalled();
  });
});
