import { useEffect } from 'react';
import { MIRNA_SYNC_LOCAL_MUTATION_EVENT } from '@/db/sync/mutation-audit';
import { SyncApiError } from './api';

export const VISIBLE_SYNC_INTERVAL_MS = 5 * 60_000;
export const FOREGROUND_RESUME_STALE_MS = 2 * 60_000;
export const LAST_SUCCESS_STALE_MS = 5 * 60_000;
export const LOCAL_MUTATION_DEBOUNCE_MS = 3_000;
export const MIN_AUTO_SYNC_GAP_MS = 30_000;
export const BUDGET_BACKOFF_MS = 6 * 60 * 60 * 1_000;

const RETRY_BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000] as const;

const SERVICE_PAUSE_CODES = new Set([
  'SERVICE_BUDGET_EXHAUSTED',
  'SERVICE_QUOTA_EXHAUSTED',
  'VAULT_QUOTA_EXCEEDED',
  'SERVICE_MAINTENANCE',
  'USAGE_ACCOUNTING_UNAVAILABLE',
  'USAGE_RESERVATION_UNDERESTIMATED',
  'USAGE_SETTLEMENT_FAILED',
  'D1_STORAGE_LIMIT_REACHED',
]);

export type SyncTrigger =
  'cold-start' | 'local-mutation' | 'network-returned' | 'foreground-resume' | 'periodic' | 'retry';

export interface SyncSchedulerStatus {
  readonly pendingLocalOperationCount: number;
  readonly lastSuccessfulSyncAt?: string;
}

export type SyncSchedulerActivity =
  | { readonly kind: 'started'; readonly trigger: SyncTrigger }
  | { readonly kind: 'succeeded'; readonly trigger: SyncTrigger; readonly at: string }
  | {
      readonly kind: 'paused';
      readonly trigger: SyncTrigger;
      readonly until: number;
      readonly serviceLimit: boolean;
    }
  | { readonly kind: 'failed'; readonly trigger: SyncTrigger; readonly retryAt: number };

const withJitter = (milliseconds: number): number => {
  const value = crypto.getRandomValues(new Uint16Array(1))[0] ?? 0;
  return Math.round(milliseconds * (0.8 + (value / 65_535) * 0.4));
};

const validTimestamp = (value?: string): number | undefined => {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
};

const shouldSyncAfterResume = (
  hiddenAt: number | undefined,
  networkReturnedWhileHidden: boolean,
  status: SyncSchedulerStatus,
  now: number,
): boolean => {
  const lastSuccess = validTimestamp(status.lastSuccessfulSyncAt);
  return (
    networkReturnedWhileHidden ||
    status.pendingLocalOperationCount > 0 ||
    lastSuccess === undefined ||
    now - lastSuccess >= LAST_SUCCESS_STALE_MS ||
    (hiddenAt !== undefined && now - hiddenAt >= FOREGROUND_RESUME_STALE_MS)
  );
};

export const useSnapshotSyncScheduler = (input: {
  enabled: boolean;
  vaultId?: string;
  getStatus: () => SyncSchedulerStatus;
  synchronize: (trigger: SyncTrigger) => Promise<unknown>;
  onSettled: () => Promise<void>;
  onActivity?: (activity: SyncSchedulerActivity) => void;
}): void => {
  const { enabled, vaultId, getStatus, synchronize, onSettled, onActivity } = input;

  useEffect(() => {
    if (!enabled || !vaultId) return;

    let disposed = false;
    let inFlight = false;
    let failedAttempts = 0;
    let pendingTrigger: SyncTrigger | undefined;
    let hiddenAt = document.visibilityState === 'hidden' ? Date.now() : undefined;
    let networkReturnedWhileHidden = false;
    let lastStartedAt = Number.NEGATIVE_INFINITY;
    let triggerTimer: number | undefined;
    let triggerTimerDueAt = Number.POSITIVE_INFINITY;
    let periodicTimer: number | undefined;
    const budgetPauseKey = `mirna:sync-budget-pause:${vaultId}`;
    const storedPause = Number(window.localStorage.getItem(budgetPauseKey));
    let nextAllowedAt = Number.isFinite(storedPause) && storedPause > Date.now() ? storedPause : 0;

    const clearTriggerTimer = (): void => {
      if (triggerTimer !== undefined) window.clearTimeout(triggerTimer);
      triggerTimer = undefined;
      triggerTimerDueAt = Number.POSITIVE_INFINITY;
    };

    const stopPeriodic = (): void => {
      if (periodicTimer !== undefined) window.clearInterval(periodicTimer);
      periodicTimer = undefined;
    };

    function requestRun(trigger: SyncTrigger, delay = 0): void {
      pendingTrigger ??= trigger;
      schedulePending(delay);
    }

    const startPeriodic = (): void => {
      if (periodicTimer !== undefined || document.visibilityState === 'hidden') return;
      periodicTimer = window.setInterval(() => requestRun('periodic'), VISIBLE_SYNC_INTERVAL_MS);
    };

    function schedulePending(delay = 0): void {
      if (
        disposed ||
        inFlight ||
        !pendingTrigger ||
        document.visibilityState === 'hidden' ||
        navigator.onLine === false
      ) {
        return;
      }

      const now = Date.now();
      const dueAt = Math.max(now + delay, nextAllowedAt, lastStartedAt + MIN_AUTO_SYNC_GAP_MS);
      if (triggerTimer !== undefined && triggerTimerDueAt <= dueAt) return;
      clearTriggerTimer();
      triggerTimerDueAt = dueAt;
      triggerTimer = window.setTimeout(
        () => {
          triggerTimer = undefined;
          triggerTimerDueAt = Number.POSITIVE_INFINITY;
          void runPending();
        },
        Math.max(0, dueAt - now),
      );
    }

    async function runPending(): Promise<void> {
      if (disposed || inFlight || !pendingTrigger) return;
      if (document.visibilityState === 'hidden' || navigator.onLine === false) return;

      const now = Date.now();
      if (now < nextAllowedAt || now - lastStartedAt < MIN_AUTO_SYNC_GAP_MS) {
        schedulePending();
        return;
      }

      const trigger = pendingTrigger;
      pendingTrigger = undefined;
      lastStartedAt = now;
      inFlight = true;
      onActivity?.({ kind: 'started', trigger });

      try {
        await synchronize(trigger);
        failedAttempts = 0;
        nextAllowedAt = 0;
        try {
          window.localStorage.removeItem(budgetPauseKey);
        } catch {
          // Storage can be unavailable; the current runtime still resumes safely.
        }
        onActivity?.({ kind: 'succeeded', trigger, at: new Date().toISOString() });
      } catch (error) {
        const serviceLimit = error instanceof SyncApiError && SERVICE_PAUSE_CODES.has(error.code);
        const retryDelay = serviceLimit
          ? BUDGET_BACKOFF_MS
          : RETRY_BACKOFF_MS[Math.min(failedAttempts, RETRY_BACKOFF_MS.length - 1)];
        nextAllowedAt = Date.now() + withJitter(retryDelay);
        if (serviceLimit) {
          try {
            window.localStorage.setItem(budgetPauseKey, String(nextAllowedAt));
          } catch {
            // The in-memory pause still prevents request storms for this runtime.
          }
          onActivity?.({ kind: 'paused', trigger, until: nextAllowedAt, serviceLimit: true });
        } else {
          onActivity?.({ kind: 'failed', trigger, retryAt: nextAllowedAt });
        }
        failedAttempts += 1;
        pendingTrigger ??= 'retry';
      } finally {
        inFlight = false;
        if (!disposed) {
          await onSettled().catch(() => undefined);
          schedulePending();
        }
      }
    }

    const localMutation = (): void => requestRun('local-mutation', LOCAL_MUTATION_DEBOUNCE_MS);
    const online = (): void => {
      networkReturnedWhileHidden = document.visibilityState === 'hidden';
      requestRun('network-returned');
    };
    const visibilityChanged = (): void => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        stopPeriodic();
        clearTriggerTimer();
        return;
      }

      startPeriodic();
      const now = Date.now();
      if (shouldSyncAfterResume(hiddenAt, networkReturnedWhileHidden, getStatus(), now)) {
        requestRun('foreground-resume');
      } else {
        schedulePending();
      }
      hiddenAt = undefined;
      networkReturnedWhileHidden = false;
    };

    startPeriodic();
    window.addEventListener('online', online);
    window.addEventListener(MIRNA_SYNC_LOCAL_MUTATION_EVENT, localMutation);
    document.addEventListener('visibilitychange', visibilityChanged);
    queueMicrotask(() => requestRun('cold-start'));

    return () => {
      disposed = true;
      clearTriggerTimer();
      stopPeriodic();
      window.removeEventListener('online', online);
      window.removeEventListener(MIRNA_SYNC_LOCAL_MUTATION_EVENT, localMutation);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [enabled, getStatus, onActivity, onSettled, synchronize, vaultId]);
};
