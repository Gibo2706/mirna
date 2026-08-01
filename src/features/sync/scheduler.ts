import { useEffect } from 'react';
import { MIRNA_SYNC_LOCAL_MUTATION_EVENT } from '@/db/sync/mutation-audit';

const BASE_INTERVAL_MS = 45_000;
const VISIBILITY_DEBOUNCE_MS = 750;
const BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000] as const;

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
    let nextAllowedAt = 0;
    let debounceTimer: number | undefined;

    const run = async (): Promise<void> => {
      if (
        disposed ||
        inFlight ||
        document.visibilityState === 'hidden' ||
        navigator.onLine === false ||
        Date.now() < nextAllowedAt
      ) {
        return;
      }
      inFlight = true;
      try {
        await synchronize();
        failedAttempts = 0;
        nextAllowedAt = 0;
      } catch {
        const index = Math.min(failedAttempts, BACKOFF_MS.length - 1);
        nextAllowedAt = Date.now() + withJitter(BACKOFF_MS[index]);
        failedAttempts += 1;
      } finally {
        inFlight = false;
        if (!disposed) await onSettled().catch(() => undefined);
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
