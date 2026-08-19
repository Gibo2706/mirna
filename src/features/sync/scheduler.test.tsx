import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIRNA_SYNC_LOCAL_MUTATION_EVENT } from '@/db/sync/mutation-audit';
import { SyncApiError } from './api';
import {
  BUDGET_BACKOFF_MS,
  FOREGROUND_RESUME_STALE_MS,
  LOCAL_MUTATION_DEBOUNCE_MS,
  MIN_AUTO_SYNC_GAP_MS,
  VISIBLE_SYNC_INTERVAL_MS,
  useSnapshotSyncScheduler,
  type SyncSchedulerStatus,
  type SyncTrigger,
} from './scheduler';

const vaultId = 'VVVVVVVVVVVVVVVVVVVVVV';

const setVisibility = (value: DocumentVisibilityState): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
};

const setOnline = (value: boolean): void => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
};

const flush = async (milliseconds = 0): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    vi.advanceTimersByTime(milliseconds);
    await Promise.resolve();
  });
};

const SchedulerHarness = ({
  status,
  synchronize,
}: {
  status: SyncSchedulerStatus;
  synchronize: (trigger: SyncTrigger) => Promise<unknown>;
}) => {
  useSnapshotSyncScheduler({
    enabled: true,
    vaultId,
    getStatus: () => status,
    synchronize,
    onSettled: () => Promise.resolve(),
  });
  return null;
};

describe('global foreground sync scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T12:00:00.000Z'));
    window.localStorage.clear();
    setOnline(true);
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once on a cold visible start', async () => {
    const status: { pendingLocalOperationCount: number; lastSuccessfulSyncAt?: string } = {
      pendingLocalOperationCount: 0,
    };
    const synchronize = vi.fn(() => {
      status.lastSuccessfulSyncAt = new Date().toISOString();
      return Promise.resolve();
    });
    render(<SchedulerHarness status={status} synchronize={synchronize} />);

    await flush();

    expect(synchronize).toHaveBeenCalledWith('cold-start');
  });

  it('ignores a quick foreground switch when state is fresh', async () => {
    const status: { pendingLocalOperationCount: number; lastSuccessfulSyncAt?: string } = {
      pendingLocalOperationCount: 0,
    };
    const synchronize = vi.fn(() => {
      status.lastSuccessfulSyncAt = new Date().toISOString();
      return Promise.resolve();
    });
    render(<SchedulerHarness status={status} synchronize={synchronize} />);
    await flush();
    setVisibility('hidden');
    await flush(5_000);
    setVisibility('visible');
    await flush();

    expect(synchronize).toHaveBeenCalledTimes(1);
  });

  it('syncs after a stale foreground resume or pending local work', async () => {
    const status: { pendingLocalOperationCount: number; lastSuccessfulSyncAt?: string } = {
      pendingLocalOperationCount: 0,
    };
    const synchronize = vi.fn(() => {
      status.lastSuccessfulSyncAt = new Date().toISOString();
      status.pendingLocalOperationCount = 0;
      return Promise.resolve();
    });
    render(<SchedulerHarness status={status} synchronize={synchronize} />);
    await flush();
    setVisibility('hidden');
    await flush(FOREGROUND_RESUME_STALE_MS);
    setVisibility('visible');
    await flush();
    expect(synchronize).toHaveBeenCalledTimes(2);

    setVisibility('hidden');
    status.pendingLocalOperationCount = 1;
    await flush(5_000);
    setVisibility('visible');
    await flush(MIN_AUTO_SYNC_GAP_MS);
    expect(synchronize).toHaveBeenCalledTimes(3);
  });

  it('syncs when the network returns without overlapping work', async () => {
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const synchronize = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
    render(
      <SchedulerHarness status={{ pendingLocalOperationCount: 0 }} synchronize={synchronize} />,
    );
    await flush();
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    expect(synchronize).toHaveBeenCalledTimes(1);
    await act(() => {
      resolveFirst?.();
      return Promise.resolve();
    });
    await flush(MIN_AUTO_SYNC_GAP_MS);
    expect(synchronize).toHaveBeenCalledTimes(2);
  });

  it('defers a mutation inside the minimum gap instead of losing it', async () => {
    const synchronize = vi.fn(() => Promise.resolve());
    render(
      <SchedulerHarness
        status={{ pendingLocalOperationCount: 0, lastSuccessfulSyncAt: new Date().toISOString() }}
        synchronize={synchronize}
      />,
    );
    await flush();
    await flush(10_000);
    window.dispatchEvent(new Event(MIRNA_SYNC_LOCAL_MUTATION_EVENT));
    await flush(LOCAL_MUTATION_DEBOUNCE_MS);
    expect(synchronize).toHaveBeenCalledTimes(1);

    await flush(MIN_AUTO_SYNC_GAP_MS - 10_000 - LOCAL_MUTATION_DEBOUNCE_MS);
    expect(synchronize).toHaveBeenCalledTimes(2);
  });

  it('coalesces duplicate local triggers into one deferred run', async () => {
    const synchronize = vi.fn(() => Promise.resolve());
    render(
      <SchedulerHarness
        status={{ pendingLocalOperationCount: 0, lastSuccessfulSyncAt: new Date().toISOString() }}
        synchronize={synchronize}
      />,
    );
    await flush();
    window.dispatchEvent(new Event(MIRNA_SYNC_LOCAL_MUTATION_EVENT));
    window.dispatchEvent(new Event(MIRNA_SYNC_LOCAL_MUTATION_EVENT));
    window.dispatchEvent(new Event(MIRNA_SYNC_LOCAL_MUTATION_EVENT));
    await flush(MIN_AUTO_SYNC_GAP_MS);

    expect(synchronize).toHaveBeenCalledTimes(2);
  });

  it('does not periodic-poll while the page is hidden', async () => {
    const synchronize = vi.fn(() => Promise.resolve());
    render(
      <SchedulerHarness
        status={{ pendingLocalOperationCount: 0, lastSuccessfulSyncAt: new Date().toISOString() }}
        synchronize={synchronize}
      />,
    );
    await flush();
    setVisibility('hidden');
    await flush(VISIBLE_SYNC_INTERVAL_MS * 3);

    expect(synchronize).toHaveBeenCalledTimes(1);
  });

  it('respects a persisted six-hour service pause', async () => {
    const pauseUntil = Date.now() + BUDGET_BACKOFF_MS;
    window.localStorage.setItem(`mirna:sync-budget-pause:${vaultId}`, String(pauseUntil));
    const synchronize = vi.fn(() => Promise.resolve());
    render(
      <SchedulerHarness status={{ pendingLocalOperationCount: 0 }} synchronize={synchronize} />,
    );
    await flush(BUDGET_BACKOFF_MS - 1);
    expect(synchronize).not.toHaveBeenCalled();
    await flush(1);
    expect(synchronize).toHaveBeenCalledOnce();
  });

  it('persists a service-limit pause and clears it after a later success', async () => {
    const synchronize = vi
      .fn()
      .mockRejectedValueOnce(new SyncApiError('SERVICE_BUDGET_EXHAUSTED', 503))
      .mockResolvedValue(undefined);
    render(
      <SchedulerHarness status={{ pendingLocalOperationCount: 0 }} synchronize={synchronize} />,
    );
    await flush();
    const pauseKey = `mirna:sync-budget-pause:${vaultId}`;
    const pauseUntil = Number(window.localStorage.getItem(pauseKey));
    expect(pauseUntil).toBeGreaterThan(Date.now());

    await flush(pauseUntil - Date.now());
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(pauseKey)).toBeNull();
  });
});
