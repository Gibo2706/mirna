export interface MeteredUsage {
  readonly workerRequests: number;
  readonly d1RowsRead: number;
  readonly d1RowsWritten: number;
  readonly r2ClassA: number;
  readonly r2ClassB: number;
}

export interface UsageCeilings extends MeteredUsage {
  readonly workerRequestsPerUtcDay?: number;
  readonly d1RowsReadPerUtcDay?: number;
  readonly d1RowsWrittenPerUtcDay?: number;
  readonly r2ClassAPerUtcDay?: number;
  readonly r2ClassBPerUtcDay?: number;
}

export interface StagingBudgets {
  readonly rollingWindowDays: number;
  readonly global: UsageCeilings;
  readonly perVault: UsageCeilings;
  readonly resources: Readonly<{
    r2StoredBytes: number;
    r2ObjectCount: number;
    d1StorageBytes: number;
    activeVaults: number;
  }>;
  readonly perVaultResources: Readonly<{
    r2StoredBytes: number;
    r2ObjectCount: number;
    unresolvedConflicts: number;
    uncompactedOperations: number;
  }>;
}

/**
 * These are deploy-time safety boundaries, not tuning knobs. They deliberately
 * cannot be raised by Worker vars, D1 rows, headers or client input. Tests may
 * inject a smaller immutable object into the budget controller.
 */
export const STAGING_BUDGETS: StagingBudgets = Object.freeze({
  rollingWindowDays: 30,
  global: Object.freeze({
    workerRequests: 1_500_000,
    workerRequestsPerUtcDay: 50_000,
    r2ClassA: 400_000,
    r2ClassAPerUtcDay: 20_000,
    r2ClassB: 4_000_000,
    r2ClassBPerUtcDay: 200_000,
    d1RowsRead: 25_000_000,
    d1RowsReadPerUtcDay: 2_000_000,
    d1RowsWritten: 500_000,
    // Keep headroom below Cloudflare Free's 100000 D1 rows-written/day allowance.
    d1RowsWrittenPerUtcDay: 80_000,
  }),
  perVault: Object.freeze({
    workerRequests: 25_000,
    r2ClassA: 1_000,
    r2ClassB: 10_000,
    d1RowsRead: 250_000,
    d1RowsWritten: 25_000,
  }),
  resources: Object.freeze({
    r2StoredBytes: 4 * 1_024 * 1_024 * 1_024,
    r2ObjectCount: 100_000,
    d1StorageBytes: 256 * 1_024 * 1_024,
    activeVaults: 50,
  }),
  perVaultResources: Object.freeze({
    r2StoredBytes: 64 * 1_024 * 1_024,
    r2ObjectCount: 2_000,
    unresolvedConflicts: 100,
    uncompactedOperations: 5_000,
  }),
});

export const ZERO_USAGE: MeteredUsage = Object.freeze({
  workerRequests: 0,
  d1RowsRead: 0,
  d1RowsWritten: 0,
  r2ClassA: 0,
  r2ClassB: 0,
});
