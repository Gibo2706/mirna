import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LocalSyncSetup } from '@/db/sync/records';
import { SyncRuntimeProvider, useSyncRuntime } from './SyncRuntimeProvider';
import type { SyncUiServices } from '../ui-services';
import { MIRNA_SYNC_LOCAL_MUTATION_EVENT } from '@/db/sync/mutation-audit';
import { MIN_AUTO_SYNC_GAP_MS } from '../scheduler';

const setup = {
  vault: { vaultId: 'VVVVVVVVVVVVVVVVVVVVVV' },
  metadata: {
    bootstrapMode: 'complete',
    lastSnapshotRevision: 1,
  },
} as LocalSyncSetup;

const createServices = (): SyncUiServices => ({
  probeCapability: vi.fn(),
  loadLocalStatus: vi.fn(() =>
    Promise.resolve({
      setup,
      pendingConflictCount: 0,
      pendingLocalOperationCount: 0,
      pendingConflicts: [],
      pendingPairingFinalization: false,
      deviceAliases: [],
    }),
  ),
  disableLocalDevice: vi.fn(),
  clearSession: vi.fn(),
  resolveConflictGroup: vi.fn(),
  synchronize: vi.fn(() => Promise.resolve({ kind: 'up-to-date' as const, revision: 1 })),
  renewDevice: vi.fn(),
  saveDeviceAlias: vi.fn(),
  secureRevokeDevice: vi.fn(),
  deleteCloudVault: vi.fn(),
  createEnableLifecycle: vi.fn(),
  createNewDevicePairingLifecycle: vi.fn(),
  createExistingDevicePairingLifecycle: vi.fn(),
  createRecoveryLifecycle: vi.fn(),
  createQrDataUrl: vi.fn(),
  copySecret: vi.fn(),
  downloadSecret: vi.fn(),
  printSecret: vi.fn(),
});

const ManualSyncProbe = () => {
  const runtime = useSyncRuntime();
  return (
    <main>
      <button onClick={() => void runtime.synchronize().catch(() => undefined)}>Sync</button>
      <span data-testid="activity">{runtime.activity.kind}</span>
    </main>
  );
};

const DashboardProbe = () => {
  const runtime = useSyncRuntime();
  return (
    <main>
      <h1>Dashboard</h1>
      <span>{runtime.localStatus?.setup ? 'runtime-ready' : 'runtime-loading'}</span>
    </main>
  );
};

describe('app-level sync runtime', () => {
  it('keeps attention visible when a manual result has no fresh durable checkpoint', async () => {
    const services = createServices();
    vi.mocked(services.synchronize).mockResolvedValue({
      kind: 'synchronized',
      revision: 1,
      uploadedOperations: 0,
      downloadedOperations: 0,
      appliedGroups: 0,
      conflictedGroups: 0,
      pendingLocalOperations: 0,
      acknowledgedServerCursor: 8,
      compacted: false,
    });
    vi.mocked(services.loadLocalStatus).mockResolvedValue({
      setup: {
        ...setup,
        metadata: { ...setup.metadata, lastSuccessfulSyncAt: '2020-01-01T00:00:00.000Z' },
      },
      pendingConflictCount: 0,
      pendingLocalOperationCount: 0,
      pendingConflicts: [],
      pendingPairingFinalization: false,
      deviceAliases: [],
    });

    render(
      <SyncRuntimeProvider services={services}>
        <ManualSyncProbe />
      </SyncRuntimeProvider>,
    );
    await waitFor(() => expect(services.loadLocalStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));
    await waitFor(() => expect(screen.getByTestId('activity')).toHaveTextContent('attention'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('activity')).toHaveTextContent('attention');
  });

  it('cold-starts one shared service graph while an ordinary page is mounted', async () => {
    const services = createServices();

    render(
      <SyncRuntimeProvider services={services}>
        <DashboardProbe />
      </SyncRuntimeProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    expect(await screen.findByText('runtime-ready')).toBeVisible();
    await waitFor(() => expect(services.synchronize).toHaveBeenCalledWith(false, false));
    expect(services.loadLocalStatus).toHaveBeenCalled();
  });

  it('reacts to a finance mutation while the ordinary dashboard stays mounted', async () => {
    vi.useFakeTimers();
    try {
      const services = createServices();
      render(
        <SyncRuntimeProvider services={services}>
          <DashboardProbe />
        </SyncRuntimeProvider>,
      );

      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(services.synchronize).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

      window.dispatchEvent(new Event(MIRNA_SYNC_LOCAL_MUTATION_EVENT));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MIN_AUTO_SYNC_GAP_MS);
      });

      expect(services.synchronize).toHaveBeenCalledTimes(2);
      expect(services.synchronize).toHaveBeenLastCalledWith(false, false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('automatically bootstraps a paired device without visiting sync settings', async () => {
    const pairedSetup = {
      ...setup,
      metadata: {
        ...setup.metadata,
        bootstrapMode: 'paired-download' as const,
        lastSnapshotRevision: 0,
        lastSnapshotId: 'SSSSSSSSSSSSSSSSSSSSSS',
      },
    } as LocalSyncSetup;
    let currentSetup = pairedSetup;
    const services = createServices();
    vi.mocked(services.loadLocalStatus).mockImplementation(() =>
      Promise.resolve({
        setup: currentSetup,
        pendingConflictCount: 0,
        pendingLocalOperationCount: 0,
        pendingConflicts: [],
        pendingPairingFinalization: false,
        deviceAliases: [],
      }),
    );
    vi.mocked(services.synchronize).mockImplementation(() => {
      currentSetup = {
        ...pairedSetup,
        metadata: {
          ...pairedSetup.metadata,
          bootstrapMode: 'complete',
          lastSnapshotRevision: 1,
          lastSuccessfulSyncAt: '2026-08-19T12:00:00.000Z',
        },
      };
      return Promise.resolve({ kind: 'downloaded', revision: 1 });
    });

    render(
      <SyncRuntimeProvider services={services}>
        <DashboardProbe />
      </SyncRuntimeProvider>,
    );

    await waitFor(() => expect(services.synchronize).toHaveBeenCalledWith(false, false));
    await waitFor(() =>
      expect(vi.mocked(services.loadLocalStatus).mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    expect(currentSetup.metadata.bootstrapMode).toBe('complete');
  });
});
