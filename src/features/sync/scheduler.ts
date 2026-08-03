import { useEffect } from 'react';
import { MIRNA_SYNC_LOCAL_MUTATION_EVENT } from '@/db/sync/mutation-audit';
import { SyncApiError } from './api';

const BASE_INTERVAL_MS = 5 * 60_000;
const VISIBILITY_DEBOUNCE_MS = 3_000;
const MIN_AUTO_SYNC_GAP_MS = 30_000;
const BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000] as const;
const BUDGET_BACKOFF_MS = 6 * 60 * 60 * 1_000;

const withJitter = (milliseconds: number): number => {
  const value = crypto.getRandomValues(new Uint16Array(1))[0] ?? 0;
  return Math.round(milliseconds * (0.8 + (value / 65_535) * 0.4));
};

export const useSnapshotSyncScheduler = (input: {
  enabled: boolean;
  vaultId?: string;
  synchronize: () => Promise<unknown>;
  onSettled: () => Promise<void>;
}): void => {
  const { enabled, vaultId, synchronize, onSettled } = input;

  useEffect(() => {
    if (!enabled || !vaultId) return;
    let disposed = false;
    let inFlight = false;
    let failedAttempts = 0;
    const budgetPauseKey = `mirna:sync-budget-pause:${vaultId}`;
    let lastStartedAt = 0;

    const storedPause = Number(window.localStorage.getItem(budgetPauseKey));
    let nextAllowedAt = Number.isFinite(storedPause) && storedPause > Date.now() ? storedPause : 0;
    let debounceTimer: number | undefined;

    const run = async (): Promise<void> => {
      const now = Date.now();

      if (
        disposed ||
        inFlight ||
        document.visibilityState === 'hidden' ||
        navigator.onLine === false ||
        now < nextAllowedAt ||
        now - lastStartedAt < MIN_AUTO_SYNC_GAP_MS
      ) {
        return;
      }

      lastStartedAt = now;
      inFlight = true;

      try {
        await synchronize();

        failedAttempts = 0;
        nextAllowedAt = 0;

        try {
          window.localStorage.removeItem(budgetPauseKey);
        } catch {
          // Storage može biti nedostupan; trenutna sesija i dalje nastavlja.
        }
      } catch (error) {
        const budgetPause =
          error instanceof SyncApiError &&
          [
            'SERVICE_BUDGET_EXHAUSTED',
            'SERVICE_QUOTA_EXHAUSTED',
            'VAULT_QUOTA_EXCEEDED',
            'SERVICE_MAINTENANCE',
            'USAGE_ACCOUNTING_UNAVAILABLE',
            'USAGE_RESERVATION_UNDERESTIMATED',
            'USAGE_SETTLEMENT_FAILED',
            'D1_STORAGE_LIMIT_REACHED',
          ].includes(error.code);

        const index = Math.min(failedAttempts, BACKOFF_MS.length - 1);
        const pauseUntil =
          Date.now() + withJitter(budgetPause ? BUDGET_BACKOFF_MS : BACKOFF_MS[index]);

        nextAllowedAt = pauseUntil;

        if (budgetPause) {
          try {
            window.localStorage.setItem(budgetPauseKey, String(pauseUntil));
          } catch {
            // In-memory nextAllowedAt i dalje sprečava ponovno bombardovanje.
          }
        }

        failedAttempts += 1;
      } finally {
        inFlight = false;

        if (!disposed) {
          await onSettled().catch(() => undefined);
        }
      }
    };

    const debouncedRun = (): void => {
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => void run(), VISIBILITY_DEBOUNCE_MS);
    };
    const visibilityChanged = (): void => {
      if (document.visibilityState === 'visible') debouncedRun();
    };

    const interval = window.setInterval(() => void run(), BASE_INTERVAL_MS);
    window.addEventListener('online', debouncedRun);
    window.addEventListener(MIRNA_SYNC_LOCAL_MUTATION_EVENT, debouncedRun);
    document.addEventListener('visibilitychange', visibilityChanged);
    queueMicrotask(() => void run());

    return () => {
      disposed = true;
      window.clearInterval(interval);
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      window.removeEventListener('online', debouncedRun);
      window.removeEventListener(MIRNA_SYNC_LOCAL_MUTATION_EVENT, debouncedRun);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [enabled, onSettled, synchronize, vaultId]);
};
