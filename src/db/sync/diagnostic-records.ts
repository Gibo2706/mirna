export interface SyncBetaSupportRecord {
  readonly id: 'sync-beta-support';
  readonly supportId: string;
  readonly createdAt: string;
}

export interface SyncBetaDiagnosticEventRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly eventType: string;
  readonly severity: 'info' | 'error';
  readonly action?: string;
  readonly requestId?: string;
  readonly safeCode?: string;
  readonly build?: string;
  readonly online?: boolean;
}
