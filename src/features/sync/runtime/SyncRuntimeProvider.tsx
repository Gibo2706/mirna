import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ContinuousSyncResult } from '../continuous-service';
import {
  useSnapshotSyncScheduler,
  type SyncSchedulerActivity,
  type SyncTrigger,
} from '../scheduler';
import {
  createDefaultSyncUiServices,
  type SyncUiLocalStatus,
  type SyncUiServices,
} from '../ui-services';

export type SyncActivity =
  | { readonly kind: 'idle' }
  | { readonly kind: 'syncing'; readonly reason: SyncTrigger | 'manual' | 'first-upload' }
  | { readonly kind: 'synced'; readonly at: string }
  | { readonly kind: 'offline' }
  | { readonly kind: 'pending'; readonly count: number }
  | { readonly kind: 'paused'; readonly until: number }
  | { readonly kind: 'attention'; readonly reason: string; readonly retryAt?: number };

export interface SyncRuntimeValue {
  readonly services: SyncUiServices;
  readonly localStatus?: SyncUiLocalStatus;
  readonly loadError: string;
  readonly activity: SyncActivity;
  readonly refresh: () => Promise<void>;
  readonly synchronize: (options?: {
    readonly allowInitialUpload?: boolean;
    readonly reason?: 'manual' | 'first-upload';
  }) => Promise<ContinuousSyncResult>;
}

const SyncRuntimeContext = createContext<SyncRuntimeValue | null>(null);

const deriveRestingActivity = (status: SyncUiLocalStatus): SyncActivity => {
  if (!status.setup) return { kind: 'idle' };
  if (navigator.onLine === false) return { kind: 'offline' };
  if (status.setup.metadata.syncBlockReason) {
    return { kind: 'attention', reason: status.setup.metadata.syncBlockReason };
  }
  if (status.pendingLocalOperationCount > 0) {
    return { kind: 'pending', count: status.pendingLocalOperationCount };
  }
  const lastSuccessfulSyncAt = status.setup.metadata.lastSuccessfulSyncAt;
  return lastSuccessfulSyncAt ? { kind: 'synced', at: lastSuccessfulSyncAt } : { kind: 'idle' };
};

export const SyncRuntimeProvider = ({
  children,
  services: providedServices,
}: {
  readonly children: ReactNode;
  readonly services?: SyncUiServices;
}) => {
  const services = useMemo(
    () => providedServices ?? createDefaultSyncUiServices(),
    [providedServices],
  );
  const [localStatus, setLocalStatus] = useState<SyncUiLocalStatus>();
  const statusRef = useRef<SyncUiLocalStatus | undefined>(undefined);
  const [loadError, setLoadError] = useState('');
  const [activity, setActivity] = useState<SyncActivity>({ kind: 'idle' });

  const refresh = useCallback(async () => {
    setLoadError('');
    try {
      const status = await services.loadLocalStatus();
      statusRef.current = status;
      setLocalStatus(status);
      setActivity((current) =>
        current.kind === 'syncing' || current.kind === 'paused'
          ? current
          : deriveRestingActivity(status),
      );
    } catch {
      setLoadError(
        'Lokalno sync podešavanje nije moguće bezbedno pročitati. Ne pokrećemo mrežne radnje.',
      );
      setActivity({ kind: 'attention', reason: 'local-state-unavailable' });
    }
  }, [services]);

  const getSchedulerStatus = useCallback(() => {
    const status = statusRef.current;
    return {
      pendingLocalOperationCount: status?.pendingLocalOperationCount ?? 0,
      lastSuccessfulSyncAt: status?.setup?.metadata.lastSuccessfulSyncAt,
    };
  }, []);

  const synchronizeAutomatically = useCallback(
    () => services.synchronize(false, false),
    [services],
  );

  const handleSchedulerActivity = useCallback((next: SyncSchedulerActivity) => {
    switch (next.kind) {
      case 'started':
        setActivity({ kind: 'syncing', reason: next.trigger });
        return;
      case 'succeeded':
        setActivity({ kind: 'synced', at: next.at });
        return;
      case 'paused':
        setActivity({ kind: 'paused', until: next.until });
        return;
      case 'failed':
        setActivity({
          kind: 'attention',
          reason: 'temporary-sync-failure',
          retryAt: next.retryAt,
        });
    }
  }, []);

  useSnapshotSyncScheduler({
    enabled: Boolean(localStatus?.setup),
    vaultId: localStatus?.setup?.vault.vaultId,
    getStatus: getSchedulerStatus,
    synchronize: synchronizeAutomatically,
    onSettled: refresh,
    onActivity: handleSchedulerActivity,
  });

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => () => services.dispose?.(), [services]);

  const synchronize = useCallback(
    async (
      options: {
        readonly allowInitialUpload?: boolean;
        readonly reason?: 'manual' | 'first-upload';
      } = {},
    ) => {
      setActivity({
        kind: 'syncing',
        reason: options.reason ?? (options.allowInitialUpload ? 'first-upload' : 'manual'),
      });
      try {
        const result = await services.synchronize(options.allowInitialUpload ?? false, false);
        await refresh();
        return result;
      } catch (error) {
        setActivity({ kind: 'attention', reason: 'manual-sync-failure' });
        await refresh();
        throw error;
      }
    },
    [refresh, services],
  );

  const value = useMemo<SyncRuntimeValue>(
    () => ({ services, localStatus, loadError, activity, refresh, synchronize }),
    [activity, loadError, localStatus, refresh, services, synchronize],
  );

  return <SyncRuntimeContext.Provider value={value}>{children}</SyncRuntimeContext.Provider>;
};

// This colocated hook is the intentionally small public API of the provider.
// eslint-disable-next-line react-refresh/only-export-components
export const useSyncRuntime = (): SyncRuntimeValue => {
  const runtime = useContext(SyncRuntimeContext);
  if (!runtime) throw new Error('Sync runtime provider is not mounted.');
  return runtime;
};

// eslint-disable-next-line react-refresh/only-export-components
export const useOptionalSyncRuntime = (): SyncRuntimeValue | null => useContext(SyncRuntimeContext);
