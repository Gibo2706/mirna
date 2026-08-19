import { useEffect, useState } from 'react';
import { SyncApiError } from '../api';
import { SyncLifecycleError } from '../lifecycle';
import { SnapshotSyncError } from '../snapshot-service';
import type { SyncUiServices } from '../ui-services';

export const safeErrorMessage = (error: unknown): string => {
  if (
    error instanceof SyncLifecycleError ||
    error instanceof SyncApiError ||
    error instanceof SnapshotSyncError
  )
    return error.message;
  return 'Radnja nije uspela. Proverite vezu i pokušajte ponovo.';
};

export const formatDateTime = (value?: string): string => {
  if (!value) return 'Još nije zabeleženo';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Datum nije dostupan';
  return new Intl.DateTimeFormat('sr-Latn-RS', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
};

export const formatRelativeSyncTime = (value?: string, now = Date.now()): string => {
  if (!value) return 'još nije završena';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'vreme nije dostupno';
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return 'upravo';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `pre ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `pre ${hours} h`;
  if (hours < 48) return 'juče';
  return new Intl.DateTimeFormat('sr-Latn-RS', { dateStyle: 'medium' }).format(timestamp);
};

export const truncateOpaqueId = (value: string): string =>
  value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;

export const useLocalQr = (payload: string | undefined, services: SyncUiServices): string => {
  const [dataUrl, setDataUrl] = useState('');

  useEffect(() => {
    let current = true;
    setDataUrl('');
    if (!payload)
      return () => {
        current = false;
      };
    void services
      .createQrDataUrl(payload)
      .then((value) => {
        if (current) setDataUrl(value);
      })
      .catch(() => {
        if (current) setDataUrl('');
      });
    return () => {
      current = false;
    };
  }, [payload, services]);

  return dataUrl;
};
