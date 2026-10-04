// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  METRICS,
  reconstructAccounting,
  planReconciliation,
  safeAccountingSummary,
  ACCOUNTING_SNAPSHOT_SQL,
  routeRegistryReadyForReconciliation,
} from './sync-budget-reconcile-lib.mjs';
import { parseReconcileOptions } from './sync-budget-reconcile.mjs';
import { Miniflare } from 'miniflare';

const now = Date.parse('2026-10-03T12:00:00Z');
const utcDay = (at) => new Date(at).toISOString().slice(0, 10);
const root = '11111111-1111-4111-8111-111111111111';
const vaultId = 'A'.repeat(22);
const values = (n = 0) => Object.fromEntries(METRICS.map((m) => [m, n]));
const reservation = (overrides = {}, at = now) => ({
  reservation_id: `${root}:route`,
  scope_type: 'global',
  scope_id: 'service',
  route_key: 'manifest-current',
  state: 'committed',
  created_at: at - 7200000,
  settled_at: at - 7199000,
  measurement_exact: 1,
  business_committed: 0,
  settlement_failure_code: null,
  reconciled_at: null,
  reconciliation_code: null,
  ...Object.fromEntries(
    METRICS.flatMap((m) => [
      [`reserved_${m}`, 8],
      [`committed_${m}`, 3],
      [`released_${m}`, 5],
      [`measured_${m}`, 3],
    ]),
  ),
  ...overrides,
});
const snapshot = (reservations = [reservation()], at = now) => ({
  flags: [
    {
      singleton_id: 1,
      accept_new_vaults: 1,
      accept_pairings: 1,
      accept_writes: 1,
      maintenance_mode: 0,
      accounting_fault: 0,
      state_reason: 'NONE',
      state_request_id: null,
      accounting_fault_at: null,
      updated_at: 0,
    },
  ],
  reservations,
  daily: [
    {
      scope_type: 'global',
      scope_id: 'service',
      utc_day: utcDay(at),
      ...values(3),
      updated_at: 0,
    },
  ],
  rolling: [{ scope_type: 'global', scope_id: 'service', ...values(3), refreshed_at: 0 }],
  resources: [
    {
      singleton_id: 1,
      r2_stored_bytes: 0,
      r2_object_count: 0,
      d1_storage_bytes: 4096,
      updated_at: 0,
    },
  ],
  vaultResources: [],
  inventory: [],
  vaults: [],
  pairingTotals: [{ singleton_id: 1, total_count: 0, updated_at: 0 }],
  counts: [{ vaults: 0, devices: 0, snapshots: 0, sync_changes: 0, pairing_requests: 0 }],
});
const readiness = { schema: true, registry: true, storage: true, providerD1Bytes: 4096 };
const registryMarker = JSON.parse(
  readFileSync('services/sync-worker/route-budget-conformance.json', 'utf8'),
);
const cleanupUnderestimation = () =>
  snapshot([
    reservation({
      reservation_id: `${root}:scheduled-cleanup`,
      route_key: 'scheduled-cleanup',
      reserved_d1_rows_written: 140,
      measured_d1_rows_written: 188,
      committed_d1_rows_written: 188,
      released_d1_rows_written: 0,
      settlement_failure_code: 'USAGE_RESERVATION_UNDERESTIMATED',
    }),
  ]);

describe('reconciliation registry readiness', () => {
  const health = (conformance) => ({
    readiness: {
      routeBudgetConformance: conformance,
      routeBudgetRegistryVersion: registryMarker.registryVersion,
    },
  });

  it('allows the health conformance fault explained by exact cleanup underestimation', () => {
    const s = cleanupUnderestimation();
    const registry = routeRegistryReadyForReconciliation(s, health('fault'), registryMarker, now);
    expect(registry).toBe(true);
    const plan = planReconciliation(s, now, { ...readiness, registry });
    expect(plan.blockers).toEqual([]);
    expect(plan.repairs).toEqual([
      {
        reservationId: `${root}:scheduled-cleanup`,
        code: 'SCHEDULED_CLEANUP_ESTIMATE_REPAIRED',
      },
    ]);
    expect(plan.statements.length).toBeGreaterThan(0);
  });

  it('still requires matching reviewed registry identity and a valid health status', () => {
    expect(routeRegistryReadyForReconciliation(snapshot(), health('ok'), registryMarker, now)).toBe(
      true,
    );
    for (const marker of [
      { ...registryMarker, registryVersion: 'wrong' },
      { ...registryMarker, status: 'incomplete' },
      { ...registryMarker, routeCount: 0 },
      { ...registryMarker, coverage: 'incomplete' },
      { ...registryMarker, suite: 'incomplete' },
    ]) {
      expect(
        routeRegistryReadyForReconciliation(cleanupUnderestimation(), health('fault'), marker, now),
      ).toBe(false);
    }
    for (const conformance of [undefined, 'unavailable', 'error']) {
      expect(
        routeRegistryReadyForReconciliation(
          cleanupUnderestimation(),
          health(conformance),
          registryMarker,
          now,
        ),
      ).toBe(false);
    }
  });

  it('refuses unexplained or unsupported conformance faults', () => {
    expect(
      routeRegistryReadyForReconciliation(snapshot(), health('fault'), registryMarker, now),
    ).toBe(false);
    for (const overrides of [
      { route_key: 'manifest-current' },
      { business_committed: 1 },
      { measurement_exact: 0 },
      { state: 'reserved' },
      { reservation_id: `${root}:route` },
    ]) {
      const s = cleanupUnderestimation();
      Object.assign(s.reservations[0], overrides);
      const registry = routeRegistryReadyForReconciliation(s, health('fault'), registryMarker, now);
      expect(registry).toBe(false);
      expect(planReconciliation(s, now, { ...readiness, registry }).statements).toEqual([]);
    }
  });
});
const stale = (overrides = {}, at = now) =>
  reservation(
    {
      state: 'reserved',
      settled_at: null,
      measurement_exact: 0,
      settlement_failure_code: 'STALE_RESERVATION_REQUIRES_RECONCILIATION',
      ...Object.fromEntries(
        METRICS.flatMap((m) => [
          [
            `reserved_${m}`,
            m === 'worker_requests'
              ? 1
              : m === 'd1_rows_read'
                ? 128
                : m === 'd1_rows_written'
                  ? 8
                  : 0,
          ],
          [`committed_${m}`, 0],
          [`released_${m}`, 0],
          [`measured_${m}`, 0],
        ]),
      ),
      ...overrides,
    },
    at,
  );
const faultSnapshot = (at = now) => {
  const s = snapshot(
    [
      stale({}, at),
      stale(
        { reservation_id: `${root}:vault-${vaultId}`, scope_type: 'vault', scope_id: vaultId },
        at,
      ),
    ],
    at,
  );
  s.vaults.push({ vault_id: vaultId, status: 'active' });
  s.counts[0].vaults = 1;
  s.flags[0] = {
    ...s.flags[0],
    accounting_fault: 1,
    state_reason: 'STALE_RESERVATION_REQUIRES_RECONCILIATION',
    accounting_fault_at: at - 3600000,
  };
  return s;
};

describe('durable usage reconstruction', () => {
  it('detects daily drift independently of rolling drift', () => {
    const s = snapshot();
    s.daily[0].d1_rows_read = 99;
    const r = reconstructAccounting(s, now);
    expect(r.drift).toEqual([
      expect.objectContaining({
        table: 'daily',
        metric: 'd1_rows_read',
        stored: 99,
        expected: 3,
        delta: -96,
      }),
    ]);
  });
  it('detects rolling drift independently of daily drift', () => {
    const s = snapshot();
    s.rolling[0].worker_requests = 100;
    expect(reconstructAccounting(s, now).drift).toEqual([
      expect.objectContaining({ table: 'rolling', metric: 'worker_requests', expected: 3 }),
    ]);
  });
  it('counts reserved conservatively, committed as committed and released as zero across scopes', () => {
    const s = snapshot([
      stale(),
      reservation({
        reservation_id: `${root}:vault-${vaultId}`,
        scope_type: 'vault',
        scope_id: vaultId,
      }),
      reservation({
        reservation_id: '22222222-2222-4222-8222-222222222222:route',
        state: 'released',
        ...Object.fromEntries(
          METRICS.flatMap((m) => [
            [`committed_${m}`, 0],
            [`measured_${m}`, 0],
            [`released_${m}`, 8],
          ]),
        ),
      }),
    ]);
    const r = reconstructAccounting(s, now);
    expect(r.rolling.find((x) => x.scope_type === 'global')).toMatchObject({
      worker_requests: 1,
      d1_rows_read: 128,
      d1_rows_written: 8,
    });
    expect(r.rolling.find((x) => x.scope_type === 'vault')).toMatchObject({
      worker_requests: 3,
      d1_rows_read: 3,
    });
  });
  it('uses the inclusive 30 UTC days and never resurrects older ledger rows', () => {
    const s = snapshot([
      reservation({ created_at: Date.parse('2026-09-04T00:00:00Z') }),
      reservation({
        reservation_id: '22222222-2222-4222-8222-222222222222:route',
        created_at: Date.parse('2026-09-03T23:59:59Z'),
      }),
    ]);
    const r = reconstructAccounting(s, now);
    expect(r.cutoffDay).toBe('2026-09-04');
    expect(r.rolling[0].d1_rows_read).toBe(3);
    expect(r.daily.some((x) => x.utc_day === '2026-09-03')).toBe(false);
  });
  it('rejects impossible released/committed/measured evidence', () => {
    expect(
      reconstructAccounting(snapshot([reservation({ released_d1_rows_read: 6 })]), now).errors,
    ).toContain('INVALID_RESERVATION_EVIDENCE');
  });
  it('rejects unsafe integer overflow rather than generating rounded repairs', () => {
    const a = reservation({
      committed_d1_rows_read: Number.MAX_SAFE_INTEGER,
      measured_d1_rows_read: Number.MAX_SAFE_INTEGER,
      released_d1_rows_read: 0,
    });
    const b = reservation({ reservation_id: `${root}:other` });
    expect(reconstructAccounting(snapshot([a, b]), now).errors).toContain(
      'ACCOUNTING_INTEGER_OVERFLOW',
    );
  });
});

describe('fail-closed reconciliation', () => {
  it('refuses arbitrary underestimation and settlement failures', () => {
    for (const code of ['USAGE_RESERVATION_UNDERESTIMATED', 'USAGE_SETTLEMENT_FAILED']) {
      const s = faultSnapshot();
      s.reservations[0].settlement_failure_code = code;
      expect(planReconciliation(s, now, readiness).blockers).toContain(
        'UNSUPPORTED_UNRESOLVED_RESERVATION',
      );
    }
  });
  it('refuses stale write routes, recent reservations and missing fault origins', () => {
    const s = faultSnapshot();
    s.reservations[0].route_key = 'operation-upload';
    expect(planReconciliation(s, now, readiness).blockers).toContain(
      'UNSUPPORTED_UNRESOLVED_RESERVATION',
    );
    s.reservations[0] = stale({ created_at: now - 10 });
    expect(planReconciliation(s, now, readiness).blockers).toContain(
      'UNSUPPORTED_UNRESOLVED_RESERVATION',
    );
    s.reservations = [];
    expect(planReconciliation(s, now, readiness).blockers).toContain(
      'ACCOUNTING_FAULT_WITHOUT_ORIGIN',
    );
  });
  it('keeps stale manifest reads fully charged, without claiming exact measurement', () => {
    const p = planReconciliation(faultSnapshot(), now, readiness);
    expect(p.blockers).toEqual([]);
    expect(p.repairs).toHaveLength(2);
    expect(p.repairs[0]).toMatchObject({ code: 'STALE_MANIFEST_READ_CONSERVATIVELY_COMMITTED' });
    expect(p.accounting.rolling.find((x) => x.scope_type === 'global').d1_rows_read).toBe(128);
  });
  it('requires every readiness/resource/pairing/service invariant', () => {
    for (const flag of ['accept_writes', 'accept_pairings', 'accept_new_vaults']) {
      const s = faultSnapshot();
      s.flags[0][flag] = 0;
      expect(planReconciliation(s, now, readiness).blockers).toContain('SERVICE_FLAGS_NOT_OPEN');
    }
    const s = faultSnapshot();
    s.pairingTotals[0].total_count = 1;
    expect(planReconciliation(s, now, readiness).blockers).toContain('PAIRING_TOTALS_MISMATCH');
    expect(
      planReconciliation(faultSnapshot(), now, { ...readiness, schema: false }).blockers,
    ).toContain('ACCOUNTING_SCHEMA_NOT_READY');
    expect(
      planReconciliation(faultSnapshot(), now, { ...readiness, registry: false }).blockers,
    ).toContain('ROUTE_REGISTRY_NOT_READY');
    s.resources = [];
    expect(planReconciliation(s, now, readiness).blockers).toContain('RESOURCE_SINGLETON_MISSING');
  });
  it('never raises limits or clears a true hard limit', () => {
    const s = faultSnapshot();
    s.reservations[0].reserved_d1_rows_written = 80000;
    expect(planReconciliation(s, now, readiness).blockers).toContain('HARD_LIMIT_REACHED');
  });
  it('refuses malformed stale read families', () => {
    const s = faultSnapshot();
    s.reservations[1].scope_type = 'global';
    s.reservations[1].scope_id = 'service';
    expect(planReconciliation(s, now, readiness).blockers).toContain(
      'UNSUPPORTED_UNRESOLVED_RESERVATION',
    );
  });
  it('allows multiple proven exact scheduled-cleanup failures', () => {
    const s = snapshot([
      reservation({
        reservation_id: `${root}:scheduled-cleanup`,
        route_key: 'scheduled-cleanup',
        reserved_d1_rows_read: 1,
        released_d1_rows_read: 0,
        settlement_failure_code: 'USAGE_RESERVATION_UNDERESTIMATED',
      }),
      reservation({
        reservation_id: '22222222-2222-4222-8222-222222222222:scheduled-cleanup',
        route_key: 'scheduled-cleanup',
        reserved_d1_rows_read: 1,
        released_d1_rows_read: 0,
        settlement_failure_code: 'USAGE_RESERVATION_UNDERESTIMATED',
      }),
    ]);
    const plan = planReconciliation(s, now, readiness);
    expect(plan.blockers).toEqual([]);
    expect(plan.repairs).toHaveLength(2);
  });
});

describe('operator boundaries', () => {
  it('requires explicit staging and makes dry-run the default', () => {
    expect(parseReconcileOptions(['--env', 'staging'])).toEqual({
      staging: true,
      apply: false,
      verify: false,
    });
    for (const args of [
      [],
      ['--apply'],
      ['--env', 'production', '--apply'],
      ['--env', 'staging', '--verify', '--apply'],
      ['--env', 'staging', '--force'],
    ])
      expect(() => parseReconcileOptions(args)).toThrow();
  });
  it('prints only allowlisted fault reasons, routes and valid UUIDs', () => {
    const s = faultSnapshot();
    s.flags[0].state_reason = 'private request data';
    s.flags[0].state_request_id = 'secret';
    s.reservations[0].route_key = 'private payload';
    expect(safeAccountingSummary(s, reconstructAccounting(s, now))).toMatchObject({
      reason: 'UNKNOWN',
      request: null,
      routes: ['unknown', 'manifest-current'],
    });
  });
});

const database = (s, at = now) => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE vaults(vault_id TEXT PRIMARY KEY,status TEXT); CREATE TABLE devices(id TEXT);
    CREATE TABLE snapshots(id TEXT,ciphertext BLOB); CREATE TABLE sync_changes(id TEXT,ciphertext BLOB);
    CREATE TABLE pairing_requests(id TEXT); CREATE TABLE pairing_request_totals(singleton_id INTEGER PRIMARY KEY,total_count INTEGER,updated_at INTEGER);`);
  for (const migration of [
    '0005_staging_usage_budgets.sql',
    '0006_r2_inventory_reservations.sql',
    '0007_usage_reconciliation.sql',
    '0008_r2_reconciliation_cursor.sql',
    '0010_usage_accounting_repair.sql',
  ]) {
    db.exec(readFileSync(`services/sync-worker/migrations/${migration}`, 'utf8'));
  }
  for (const [name, table] of Object.entries({
    flags: 'service_flags',
    daily: 'usage_daily_buckets',
    rolling: 'usage_rolling_totals',
    reservations: 'usage_reservations',
    resources: 'resource_totals',
    vaultResources: 'vault_resource_totals',
    inventory: 'resource_inventory',
    vaults: 'vaults',
    pairingTotals: 'pairing_request_totals',
  })) {
    db.exec(`DELETE FROM ${table}`);
    for (const row of s[name]) {
      const keys = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
      ).run(...Object.values(row));
    }
  }
  // JavaScript fake timers do not control SQLite's native clock.
  db.function('date', { varargs: true }, (value, modifier) => {
    if (value === 'now' && modifier === undefined) return utcDay(at);
    if (modifier === 'unixepoch') return utcDay(value * 1000);
    throw new Error('Unexpected SQLite date arguments in the repair test');
  });
  return db;
};
const apply = (db, statements) => {
  db.exec('BEGIN');
  try {
    for (const sql of statements) db.exec(sql);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};
describe('real SQLite repair transaction', () => {
  it('repairs only aggregate caches and is idempotent', () => {
    const s = snapshot();
    s.daily[0].d1_rows_read = 999;
    s.rolling[0].d1_rows_read = 900;
    const db = database(s);
    const before = db.prepare('SELECT * FROM usage_reservations').all();
    const p = planReconciliation(s, now, readiness);
    apply(db, p.statements);
    expect(db.prepare('SELECT d1_rows_read FROM usage_daily_buckets').get().d1_rows_read).toBe(3);
    expect(db.prepare('SELECT d1_rows_read FROM usage_rolling_totals').get().d1_rows_read).toBe(3);
    expect(db.prepare('SELECT * FROM usage_reservations').all()).toEqual(before);
    s.daily = db.prepare('SELECT * FROM usage_daily_buckets').all();
    s.rolling = db.prepare('SELECT * FROM usage_rolling_totals').all();
    expect(planReconciliation(s, now + 1, readiness).statements).toEqual([]);
    db.close();
  });
  it.each(['2026-10-03T12:00:00Z', '2026-11-01T00:30:00Z'])(
    'settles a proven stale read family and clears the fault only after equality (%s)',
    (timestamp) => {
      const at = Date.parse(timestamp);
      const s = faultSnapshot(at);
      const db = database(s, at);
      apply(db, planReconciliation(s, at, readiness).statements);
      expect(db.prepare('SELECT accounting_fault,state_reason FROM service_flags').get()).toEqual({
        accounting_fault: 0,
        state_reason: 'NONE',
      });
      const rows = db.prepare('SELECT * FROM usage_reservations').all();
      expect(rows).toHaveLength(2);
      expect(
        rows.every(
          (x) =>
            x.committed_d1_rows_read === 128 && x.measurement_exact === 0 && x.reconciled_at === at,
        ),
      ).toBe(true);
      db.close();
    },
  );
  it('CAS rejects a concurrent ledger/flags/cache/resource change with complete rollback', () => {
    for (const sql of [
      'UPDATE usage_reservations SET reserved_d1_rows_read=129',
      'UPDATE service_flags SET updated_at=99',
      'UPDATE usage_daily_buckets SET d1_rows_read=555',
      'UPDATE resource_totals SET r2_object_count=1',
    ]) {
      const s = faultSnapshot();
      const db = database(s);
      const plan = planReconciliation(s, now, readiness);
      db.exec(sql);
      const before = db.prepare('SELECT * FROM usage_reservations').all();
      expect(() => apply(db, plan.statements)).toThrow();
      expect(db.prepare('SELECT * FROM usage_reservations').all()).toEqual(before);
      expect(db.prepare('SELECT accounting_fault FROM service_flags').get().accounting_fault).toBe(
        1,
      );
      db.close();
    }
  });
  it.each(['2026-10-03T23:59:59Z', '2026-12-31T23:59:59Z'])(
    'accepts a current plan and refuses it after UTC midnight (%s)',
    (timestamp) => {
      const at = Date.parse(timestamp),
        s = faultSnapshot(at),
        plan = planReconciliation(s, at, readiness),
        current = database(s, at),
        db = database(s, at + 1000);
      expect(plan.blockers).toEqual([]);
      apply(current, plan.statements);
      expect(
        current.prepare('SELECT accounting_fault FROM service_flags').get().accounting_fault,
      ).toBe(0);
      const before = db.prepare('SELECT * FROM usage_reservations').all();
      expect(() => apply(db, plan.statements)).toThrow();
      expect(db.prepare('SELECT * FROM usage_reservations').all()).toEqual(before);
      expect(db.prepare('SELECT accounting_fault FROM service_flags').get().accounting_fault).toBe(
        1,
      );
      current.close();
      db.close();
    },
  );
});

it('real Miniflare D1 batch rolls back all repairs and fault clearing on a late failure', async () => {
  let sqlite;
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } }',
    compatibilityDate: '2026-07-31',
    d1Databases: { DB: 'accounting-test' },
  });
  try {
    const db = await mf.getD1Database('DB');
    // Keep the real D1 clock and its fail-closed UTC-day guard aligned with the fixture.
    const at = (await db.prepare("SELECT unixepoch('now') * 1000 AS now").first()).now;
    sqlite = database(faultSnapshot(at), at);
    const schema = sqlite
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
      )
      .all();
    for (const table of schema) {
      await db.prepare(table.sql).run();
      for (const row of sqlite.prepare(`SELECT * FROM ${table.name}`).all())
        await db
          .prepare(
            `INSERT INTO ${table.name}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row)
              .map(() => '?')
              .join(',')})`,
          )
          .bind(...Object.values(row))
          .run();
    }
    const read = async () =>
      JSON.parse((await db.prepare(ACCOUNTING_SNAPSHOT_SQL).first()).snapshot);
    const before = await read(),
      plan = planReconciliation(before, at, readiness);
    expect(plan.blockers).toEqual([]);
    await expect(
      db.batch(
        [
          ...plan.statements,
          'INSERT INTO resource_totals(singleton_id,updated_at) VALUES(1,0)',
        ].map((sql) => db.prepare(sql)),
      ),
    ).rejects.toThrow(/UNIQUE constraint failed: resource_totals\.singleton_id/);
    expect(await read()).toEqual(before);
    await db.batch(plan.statements.map((sql) => db.prepare(sql)));
    const after = await read();
    expect(after.flags[0].accounting_fault).toBe(0);
    expect(after.counts).toEqual(before.counts);
    expect(planReconciliation(after, at + 1, readiness).statements).toEqual([]);
  } finally {
    sqlite?.close();
    await mf.dispose();
  }
});
