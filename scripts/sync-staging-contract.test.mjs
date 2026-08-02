import { describe, expect, it } from 'vitest';
import {
  parseCloudflareBucketBytes,
  parseCloudflareCount,
  REQUIRED_ACCOUNTING_COLUMNS,
  verifyStagingSnapshot,
} from './sync-staging-contract.mjs';

const migrations = Array.from(
  { length: 10 },
  (_, index) => `${String(index + 1).padStart(4, '0')}_migration.sql`,
);
const build = 'abcdef1';
const registryVersion = '2026-08-02.1';
const validSnapshot = () => ({
  migrations: [...migrations],
  columns: Object.fromEntries(
    Object.entries(REQUIRED_ACCOUNTING_COLUMNS).map(([table, columns]) => [table, [...columns]]),
  ),
  indexes: ['idx_usage_reservations_failure'],
  failureIndexColumns: ['settlement_failure_code', 'created_at'],
  flags: {
    row_count: 1,
    accept_new_vaults: 1,
    accept_pairings: 1,
    accept_writes: 1,
    maintenance_mode: 0,
    accounting_fault: 0,
    state_reason: 'NONE',
  },
  resources: { row_count: 1, r2_stored_bytes: 0, r2_object_count: 0, d1_storage_bytes: 1 },
  pairingTotals: { row_count: 1, total_count: 2, actual_count: 2 },
  rolling: {
    row_count: 1,
    worker_requests: 1,
    d1_rows_read: 1,
    d1_rows_written: 1,
    r2_class_a: 1,
    r2_class_b: 1,
  },
  daily: {
    row_count: 1,
    worker_requests: 1,
    d1_rows_read: 1,
    d1_rows_written: 1,
    r2_class_a: 1,
    r2_class_b: 1,
  },
  unresolved: { reserved_count: 0, unreconciled_failure_count: 0 },
  r2: { readable: true, objectCount: 0, bytes: 0 },
  health: {
    status: 'ok',
    buildCommit: build,
    services: { d1: 'ok', r2: 'ok' },
    readiness: {
      storage: 'ok',
      accountingSchema: 'ok',
      accountingState: 'ok',
      routeBudgetConformance: 'ok',
      routeBudgetRegistryVersion: registryVersion,
      writes: 'enabled',
    },
  },
});

describe('staging schema and accounting contract', () => {
  it('parses current Wrangler R2 metric formatting without losing count precision', () => {
    expect(parseCloudflareCount('12,345', 'R2 object count')).toBe(12_345);
    expect(parseCloudflareBucketBytes('1.24 kB')).toEqual({ bytes: 1_240, exact: false });
    expect(parseCloudflareBucketBytes('614 B')).toEqual({ bytes: 614, exact: true });
    expect(() => parseCloudflareCount('12.5', 'R2 object count')).toThrow(/nije ispravan/u);
    expect(() => parseCloudflareBucketBytes('1.2 nonsense')).toThrow(/nije ispravan/u);
  });

  it('accepts a fully migrated, ready and internally consistent staging snapshot', () => {
    expect(verifyStagingSnapshot(validSnapshot(), migrations, build, registryVersion)).toEqual({
      ok: true,
      errors: [],
    });
  });

  it('rejects a schema missing migration 0010 and every accounting repair field', () => {
    const snapshot = validSnapshot();
    snapshot.migrations.pop();
    snapshot.columns.usage_reservations = snapshot.columns.usage_reservations.slice(0, 1);
    snapshot.columns.service_flags = snapshot.columns.service_flags.slice(0, 5);
    const result = verifyStagingSnapshot(snapshot, migrations, build);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('migration missing: 0010_migration.sql');
    expect(result.errors).toContain('usage_reservations.measurement_exact: missing');
    expect(result.errors).toContain('service_flags.accounting_fault: missing');
  });

  it('rejects a partially applied migration and a missing failure index', () => {
    const snapshot = validSnapshot();
    snapshot.columns.usage_reservations = snapshot.columns.usage_reservations.filter(
      (column) => column !== 'reconciled_at',
    );
    snapshot.indexes = [];
    const result = verifyStagingSnapshot(snapshot, migrations, build);
    expect(result.errors).toContain('usage_reservations.reconciled_at: missing');
    expect(result.errors).toContain('idx_usage_reservations_failure: missing');
  });

  it('rejects missing singleton/rolling rows, an active fault and unresolved evidence', () => {
    const snapshot = validSnapshot();
    snapshot.flags.accounting_fault = 1;
    snapshot.flags.state_reason = 'USAGE_RESERVATION_UNDERESTIMATED';
    snapshot.resources = null;
    snapshot.rolling = null;
    snapshot.unresolved.unreconciled_failure_count = 1;
    const result = verifyStagingSnapshot(snapshot, migrations, build);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'service_flags: accounting state not ready',
        'resource_totals: singleton missing',
        'global rolling: required row missing',
        'usage_reservations: unresolved accounting evidence',
      ]),
    );
  });

  it('rejects hard limits, unreadable R2 and a mismatched Worker build', () => {
    const snapshot = validSnapshot();
    snapshot.daily.d1_rows_written = 40_000;
    snapshot.r2.readable = false;
    snapshot.health.buildCommit = '1234567';
    const result = verifyStagingSnapshot(snapshot, migrations, build);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'current daily.d1_rows_written: hard limit reached',
        'R2: inventory unreadable',
        'Worker: build mismatch',
      ]),
    );
  });

  it('rejects a legacy health response without the accounting readiness contract', () => {
    const snapshot = validSnapshot();
    delete snapshot.health.readiness;

    expect(verifyStagingSnapshot(snapshot, migrations, build).errors).toContain(
      'Worker: accounting readiness missing',
    );
  });

  it('rejects a stale or faulted route-budget registry marker', () => {
    const snapshot = validSnapshot();
    snapshot.health.readiness.routeBudgetConformance = 'fault';
    snapshot.health.readiness.routeBudgetRegistryVersion = '2026-08-01.1';

    expect(verifyStagingSnapshot(snapshot, migrations, build, registryVersion).errors).toContain(
      'Worker: accounting readiness failed',
    );
  });
});
