import { STAGING_BUDGETS } from '../services/sync-worker/src/config/staging-budgets.ts';
import { API_ROUTE_REGISTRY } from '../services/sync-worker/src/route-registry.ts';

export const METRICS = [
  'worker_requests',
  'd1_rows_read',
  'd1_rows_written',
  'r2_class_a',
  'r2_class_b',
];
const budgetKeys = ['workerRequests', 'd1RowsRead', 'd1RowsWritten', 'r2ClassA', 'r2ClassB'];
const DAY = 86400000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const quote = (value) =>
  value === null
    ? 'NULL'
    : typeof value === 'number'
      ? String(value)
      : "'" + String(value).replaceAll("'", "''") + "'";
const zero = () => Object.fromEntries(METRICS.map((m) => [m, 0]));
const day = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);
const key = (row) =>
  JSON.stringify([row.scope_type, row.scope_id, ...(row.utc_day ? [row.utc_day] : [])]);
const compareRows = (fields) => (a, b) => {
  for (const k of fields) {
    if (a[k] < b[k]) return -1;
    if (a[k] > b[k]) return 1;
  }
  return 0;
};
const ordered = (rows) => [...rows].sort(compareRows(['scope_type', 'scope_id', 'utc_day']));
const unresolved = (row) =>
  row.state === 'reserved' || (row.settlement_failure_code !== null && row.reconciled_at === null);

const tables = {
  flags: ['service_flags', 'singleton_id'],
  daily: ['usage_daily_buckets', 'scope_type, scope_id, utc_day'],
  rolling: ['usage_rolling_totals', 'scope_type, scope_id'],
  reservations: ['usage_reservations', 'reservation_id'],
  resources: ['resource_totals', 'singleton_id'],
  vaultResources: ['vault_resource_totals', 'vault_id'],
  inventory: ['resource_inventory', 'object_key'],
  vaults: ['vaults', 'vault_id'],
  pairingTotals: ['pairing_request_totals', 'singleton_id'],
};
const columns = {
  flags: [
    'singleton_id',
    'accept_new_vaults',
    'accept_pairings',
    'accept_writes',
    'maintenance_mode',
    'accounting_fault',
    'state_reason',
    'state_request_id',
    'accounting_fault_at',
    'updated_at',
  ],
  daily: ['scope_type', 'scope_id', 'utc_day', ...METRICS, 'updated_at'],
  rolling: ['scope_type', 'scope_id', ...METRICS, 'refreshed_at'],
  reservations: [
    'reservation_id',
    'scope_type',
    'scope_id',
    'route_key',
    'state',
    ...['reserved', 'committed', 'released', 'measured'].flatMap((p) =>
      METRICS.map((m) => p + '_' + m),
    ),
    'created_at',
    'settled_at',
    'measurement_exact',
    'settlement_failure_code',
    'business_committed',
    'reconciled_at',
    'reconciliation_code',
  ],
  resources: [
    'singleton_id',
    'r2_stored_bytes',
    'r2_object_count',
    'd1_storage_bytes',
    'updated_at',
    'r2_reconcile_cursor',
    'r2_reconciled_at',
  ],
  vaultResources: [
    'vault_id',
    'r2_stored_bytes',
    'r2_object_count',
    'updated_at',
    'release_reservation_id',
  ],
  inventory: [
    'object_key',
    'vault_id',
    'object_type',
    'state',
    'ciphertext_bytes',
    'created_at',
    'updated_at',
    'accounting_reservation_id',
  ],
  vaults: ['vault_id', 'status'],
  pairingTotals: ['singleton_id', 'total_count', 'updated_at'],
};
const countSql =
  'SELECT (SELECT COUNT(*) FROM vaults) AS vaults, (SELECT COUNT(*) FROM devices) AS devices, (SELECT COUNT(*) FROM snapshots) AS snapshots, (SELECT COUNT(*) FROM sync_changes) AS sync_changes, (SELECT COUNT(*) FROM pairing_requests) AS pairing_requests';
const jsonRows = (table, fields, order, where = '1') =>
  '(SELECT json_group_array(json_object(' +
  fields.flatMap((c) => [quote(c), c]).join(',') +
  ')) FROM (SELECT * FROM ' +
  table +
  ' WHERE ' +
  where +
  ' ORDER BY ' +
  order +
  '))';
// One statement, hence one consistent read snapshot. No business payloads are selected.
export const ACCOUNTING_SNAPSHOT_SQL =
  'SELECT json_object(' +
  Object.entries(tables)
    .flatMap(([name, [table, order]]) => [
      quote(name),
      'json(' + jsonRows(table, columns[name], order) + ')',
    ])
    .join(',') +
  ",'counts',json((SELECT json_group_array(json_object('vaults',vaults,'devices',devices,'snapshots',snapshots,'sync_changes',sync_changes,'pairing_requests',pairing_requests)) FROM (" +
  countSql +
  ')))) AS snapshot';

function validReservation(row, now) {
  if (
    !['reserved', 'committed', 'released'].includes(row.state) ||
    !Number.isSafeInteger(row.created_at) ||
    row.created_at > now ||
    row.created_at < 0
  )
    return false;
  if (
    row.state !== 'reserved' &&
    (!Number.isSafeInteger(row.settled_at) || row.settled_at < row.created_at)
  )
    return false;
  if (row.state === 'reserved' && row.settled_at !== null) return false;
  if (![0, 1].includes(row.measurement_exact) || ![0, 1].includes(row.business_committed))
    return false;
  for (const m of METRICS) {
    for (const p of ['reserved', 'committed', 'released', 'measured'])
      if (!Number.isSafeInteger(row[p + '_' + m]) || row[p + '_' + m] < 0) return false;
    if (row.state === 'reserved') {
      if (row['committed_' + m] || row['released_' + m]) return false;
    } else {
      if (row['released_' + m] !== Math.max(0, row['reserved_' + m] - row['committed_' + m]))
        return false;
      if (row.measurement_exact === 1 && row['measured_' + m] !== row['committed_' + m])
        return false;
      if (row.state === 'released' && row['committed_' + m] !== 0) return false;
    }
  }
  return true;
}

export function reconstructAccounting(snapshot, now) {
  const cutoffDay = day(now - (STAGING_BUDGETS.rollingWindowDays - 1) * DAY);
  const today = day(now),
    daily = new Map(),
    rolling = new Map(),
    errors = [],
    drift = [];
  const ensure = (map, row) => {
    if (!map.has(key(row))) map.set(key(row), { ...row, ...zero() });
    return map.get(key(row));
  };
  for (const row of snapshot.reservations) {
    if (!validReservation(row, now)) {
      errors.push('INVALID_RESERVATION_EVIDENCE');
      continue;
    }
    const utc_day = day(row.created_at);
    if (utc_day < cutoffDay) continue;
    const target = ensure(daily, { scope_type: row.scope_type, scope_id: row.scope_id, utc_day });
    for (const m of METRICS)
      target[m] += row[(row.state === 'reserved' ? 'reserved' : 'committed') + '_' + m];
  }
  // Preserve legitimate zero seeds; today's global seed is required by deployment verification.
  for (const row of snapshot.daily)
    if (row.utc_day >= cutoffDay && row.utc_day <= today)
      ensure(daily, { scope_type: row.scope_type, scope_id: row.scope_id, utc_day: row.utc_day });
  ensure(daily, { scope_type: 'global', scope_id: 'service', utc_day: today });
  if ([...daily.values()].some((r) => METRICS.some((m) => !Number.isSafeInteger(r[m]))))
    errors.push('ACCOUNTING_INTEGER_OVERFLOW');
  for (const row of daily.values()) {
    const target = ensure(rolling, { scope_type: row.scope_type, scope_id: row.scope_id });
    for (const m of METRICS) target[m] += row[m];
  }
  if ([...rolling.values()].some((r) => METRICS.some((m) => !Number.isSafeInteger(r[m]))))
    errors.push('ACCOUNTING_INTEGER_OVERFLOW');
  for (const row of snapshot.rolling)
    ensure(rolling, { scope_type: row.scope_type, scope_id: row.scope_id });
  ensure(rolling, { scope_type: 'global', scope_id: 'service' });
  for (const [table, map] of [
    ['daily', daily],
    ['rolling', rolling],
  ]) {
    const stored = new Map(snapshot[table].map((r) => [key(r), r]));
    for (const k of new Set([...map.keys(), ...stored.keys()])) {
      const actual = stored.get(k),
        expected = map.get(k);
      for (const m of METRICS)
        if ((actual?.[m] ?? 0) !== (expected?.[m] ?? 0))
          drift.push({
            table,
            key: k,
            metric: m,
            stored: actual?.[m] ?? 0,
            expected: expected?.[m] ?? 0,
            delta: (expected?.[m] ?? 0) - (actual?.[m] ?? 0),
          });
      if (!actual && expected?.scope_type === 'global')
        drift.push({ table, key: k, metric: 'row', stored: 0, expected: 1, delta: 1 });
      if (!expected && actual)
        drift.push({ table, key: k, metric: 'expired-row', stored: 1, expected: 0, delta: -1 });
    }
  }
  const headroom = [];
  for (const row of rolling.values())
    for (const [i, m] of METRICS.entries()) {
      const limits =
        row.scope_type === 'global' ? STAGING_BUDGETS.global : STAGING_BUDGETS.perVault;
      const dailyLimit = limits[budgetKeys[i] + 'PerUtcDay'] ?? null;
      const dailyActual = daily.get(key({ ...row, utc_day: today }))?.[m] ?? 0;
      headroom.push({
        scope_type: row.scope_type,
        scope_id: row.scope_id,
        metric: m,
        rolling: row[m],
        rollingLimit: limits[budgetKeys[i]],
        rollingRemaining: limits[budgetKeys[i]] - row[m],
        daily: dailyActual,
        dailyLimit,
        dailyRemaining: dailyLimit === null ? null : dailyLimit - dailyActual,
      });
    }
  return {
    cutoffDay,
    today,
    daily: ordered([...daily.values()]),
    rolling: ordered([...rolling.values()]),
    drift,
    headroom,
    errors: [...new Set(errors)],
  };
}

function classifyRepair(row, snapshot, now) {
  if (
    row.route_key === 'scheduled-cleanup' &&
    row.scope_type === 'global' &&
    row.scope_id === 'service' &&
    row.reservation_id.endsWith(':scheduled-cleanup') &&
    row.state === 'committed' &&
    row.measurement_exact === 1 &&
    row.business_committed === 0 &&
    row.settlement_failure_code === 'USAGE_RESERVATION_UNDERESTIMATED' &&
    METRICS.some((m) => row['committed_' + m] > row['reserved_' + m])
  )
    return 'SCHEDULED_CLEANUP_ESTIMATE_REPAIRED';
  // Deliberately narrow: this route reads manifests and updates session last_used_at only.
  // Full reservation remains charged; never infer the outcome of a business write.
  const route = API_ROUTE_REGISTRY.find((r) => r.id === 'manifest-current');
  const root = row.reservation_id.slice(0, 36);
  if (
    row.route_key !== route.id ||
    !UUID.test(root) ||
    row.state !== 'reserved' ||
    row.created_at >= now - 3600000 ||
    row.business_committed !== 0 ||
    row.measurement_exact !== 0 ||
    row.reconciled_at !== null ||
    row.settlement_failure_code !== 'STALE_RESERVATION_REQUIRES_RECONCILIATION' ||
    METRICS.some(
      (m, i) =>
        row['reserved_' + m] !== (i === 0 ? 1 : route.usage[budgetKeys[i]]) ||
        row['measured_' + m] !== 0,
    )
  )
    return null;
  const family = snapshot.reservations.filter((r) => r.reservation_id.startsWith(root + ':'));
  if (
    family.length > 2 ||
    family.filter(
      (r) =>
        r.reservation_id === root + ':route' &&
        r.scope_type === 'global' &&
        r.scope_id === 'service',
    ).length !== 1 ||
    family.some(
      (r) =>
        r.route_key !== route.id ||
        r.business_committed !== 0 ||
        !(
          (r.scope_type === 'global' &&
            r.scope_id === 'service' &&
            r.reservation_id === root + ':route') ||
          (r.scope_type === 'vault' && r.reservation_id === root + ':vault-' + r.scope_id)
        ),
    )
  )
    return null;
  return 'STALE_MANIFEST_READ_CONSERVATIVELY_COMMITTED';
}

function resourceBlockers(snapshot, readiness) {
  const result = [],
    r = snapshot.resources[0];
  if (snapshot.resources.length !== 1 || r?.singleton_id !== 1)
    return ['RESOURCE_SINGLETON_MISSING'];
  const bytes = snapshot.inventory.reduce((n, x) => n + x.ciphertext_bytes, 0);
  if (bytes !== r.r2_stored_bytes || snapshot.inventory.length !== r.r2_object_count)
    result.push('RESOURCE_INVENTORY_MISMATCH');
  if (
    r.r2_stored_bytes >= STAGING_BUDGETS.resources.r2StoredBytes ||
    r.r2_object_count >= STAGING_BUDGETS.resources.r2ObjectCount ||
    r.d1_storage_bytes >= STAGING_BUDGETS.resources.d1StorageBytes ||
    !Number.isSafeInteger(readiness.providerD1Bytes) ||
    readiness.providerD1Bytes <= 0 ||
    readiness.providerD1Bytes >= STAGING_BUDGETS.resources.d1StorageBytes ||
    snapshot.vaults.filter((x) => x.status === 'active').length >=
      STAGING_BUDGETS.resources.activeVaults
  )
    result.push('STORAGE_HARD_LIMIT_OR_METADATA_INVALID');
  for (const v of snapshot.vaultResources) {
    const inventory = snapshot.inventory.filter((x) => x.vault_id === v.vault_id);
    if (
      inventory.length !== v.r2_object_count ||
      inventory.reduce((n, x) => n + x.ciphertext_bytes, 0) !== v.r2_stored_bytes
    )
      result.push('VAULT_INVENTORY_MISMATCH');
    if (
      v.r2_stored_bytes >= STAGING_BUDGETS.perVaultResources.r2StoredBytes ||
      v.r2_object_count >= STAGING_BUDGETS.perVaultResources.r2ObjectCount
    )
      result.push('STORAGE_HARD_LIMIT_OR_METADATA_INVALID');
  }
  if (
    snapshot.inventory.some((x) => !snapshot.vaultResources.some((v) => v.vault_id === x.vault_id))
  )
    result.push('VAULT_RESOURCE_ROW_MISSING');
  if (
    snapshot.pairingTotals.length !== 1 ||
    snapshot.pairingTotals[0].singleton_id !== 1 ||
    snapshot.pairingTotals[0].total_count !== snapshot.counts[0]?.pairing_requests
  )
    result.push('PAIRING_TOTALS_MISMATCH');
  return result;
}

// SQL-side derivation is rechecked inside the write batch, before touching any row.
const chargeSql = (cutoffDay) =>
  "SELECT scope_type,scope_id,date(created_at / 1000,'unixepoch') AS utc_day," +
  METRICS.map(
    (m) =>
      "SUM(CASE WHEN state='reserved' THEN reserved_" +
      m +
      ' ELSE committed_' +
      m +
      ' END) AS ' +
      m,
  ).join(',') +
  " FROM usage_reservations WHERE date(created_at / 1000,'unixepoch') >= " +
  quote(cutoffDay) +
  ' GROUP BY scope_type,scope_id,utc_day ORDER BY scope_type,scope_id,utc_day';
const chargeJson = (cutoffDay) =>
  '(SELECT json_group_array(json_array(scope_type,scope_id,utc_day,' +
  METRICS.join(',') +
  ')) FROM (' +
  chargeSql(cutoffDay) +
  '))';
function guard(snapshot, accounting, now) {
  const clauses = ["date('now') = " + quote(accounting.today)];
  for (const [name, [table, order]] of Object.entries(tables)) {
    if (name === 'reservations') continue;
    const fields = snapshot[name].length ? Object.keys(snapshot[name][0]) : columns[name];
    clauses.push(
      jsonRows(table, fields, order) +
        ' = ' +
        quote(
          JSON.stringify(
            [...snapshot[name]].sort(compareRows(order.split(',').map((s) => s.trim()))),
          ),
        ),
    );
  }
  const charges = reconstructAccounting({ ...snapshot, daily: [], rolling: [] }, now).daily.filter(
    (r) =>
      snapshot.reservations.some(
        (x) =>
          x.scope_type === r.scope_type &&
          x.scope_id === r.scope_id &&
          day(x.created_at) === r.utc_day,
      ),
  );
  clauses.push(
    chargeJson(accounting.cutoffDay) +
      ' = ' +
      quote(
        JSON.stringify(
          charges.map((r) => [r.scope_type, r.scope_id, r.utc_day, ...METRICS.map((m) => r[m])]),
        ),
      ) +
      ' AND (SELECT COUNT(*) FROM usage_reservations) = ' +
      snapshot.reservations.length,
  );
  const failed = snapshot.reservations.filter(unresolved).sort(compareRows(['reservation_id']));
  clauses.push(
    jsonRows(
      'usage_reservations',
      columns.reservations,
      'reservation_id',
      "state='reserved' OR (settlement_failure_code IS NOT NULL AND reconciled_at IS NULL)",
    ) +
      ' = ' +
      quote(
        JSON.stringify(
          failed.map((r) => Object.fromEntries(columns.reservations.map((c) => [c, r[c]]))),
        ),
      ),
  );
  clauses.push(
    'NOT EXISTS(SELECT 1 FROM usage_reservations WHERE created_at > ' +
      now +
      ' OR ' +
      "(state='reserved' AND (settled_at IS NOT NULL OR " +
      METRICS.map((m) => 'committed_' + m + ' != 0 OR released_' + m + ' != 0').join(' OR ') +
      ')) OR ' +
      "(state!='reserved' AND (settled_at IS NULL OR settled_at < created_at OR " +
      METRICS.map(
        (m) =>
          'released_' +
          m +
          ' != MAX(0,reserved_' +
          m +
          '-committed_' +
          m +
          ') OR ' +
          '(measurement_exact=1 AND measured_' +
          m +
          ' != committed_' +
          m +
          ") OR (state='released' AND committed_" +
          m +
          ' != 0)',
      ).join(' OR ') +
      ')))',
  );
  clauses.push(
    '(SELECT pairing_requests FROM (' + countSql + ')) = ' + snapshot.counts[0].pairing_requests,
  );
  return clauses.join(' AND ');
}
// An impossible singleton insert aborts the whole D1 batch. No guard schema is created.
const assertSql = (condition) =>
  'INSERT INTO resource_totals(singleton_id,updated_at) SELECT 2,0 WHERE NOT (' + condition + ')';
const cacheJson = (table) =>
  jsonRows(
    tables[table][0],
    columns[table].filter((c) => !['updated_at', 'refreshed_at'].includes(c)),
    tables[table][1],
  );

export function planReconciliation(snapshot, now, readiness) {
  const accounting = reconstructAccounting(snapshot, now),
    blockers = [...accounting.errors],
    repairs = [];
  const flags = snapshot.flags[0];
  if (
    snapshot.flags.length !== 1 ||
    flags?.singleton_id !== 1 ||
    ['accept_new_vaults', 'accept_pairings', 'accept_writes'].some((k) => flags[k] !== 1) ||
    flags.maintenance_mode !== 0
  )
    blockers.push('SERVICE_FLAGS_NOT_OPEN');
  if (!readiness.schema) blockers.push('ACCOUNTING_SCHEMA_NOT_READY');
  if (!readiness.registry) blockers.push('ROUTE_REGISTRY_NOT_READY');
  if (!readiness.storage) blockers.push('STORAGE_NOT_VERIFIED');
  blockers.push(...resourceBlockers(snapshot, readiness));
  if (
    accounting.headroom.some(
      (x) => x.rollingRemaining <= 0 || (x.dailyRemaining !== null && x.dailyRemaining <= 0),
    )
  )
    blockers.push('HARD_LIMIT_REACHED');
  for (const row of snapshot.reservations.filter(unresolved)) {
    const code = classifyRepair(row, snapshot, now);
    if (!code) blockers.push('UNSUPPORTED_UNRESOLVED_RESERVATION');
    else repairs.push({ reservationId: row.reservation_id, code });
  }
  if (flags?.accounting_fault === 1) {
    const origins = snapshot.reservations.filter(
      (r) =>
        unresolved(r) &&
        r.created_at <= flags.accounting_fault_at &&
        (!flags.state_request_id || r.reservation_id.startsWith(flags.state_request_id + ':')) &&
        r.settlement_failure_code === flags.state_reason,
    );
    if (!origins.length) blockers.push('ACCOUNTING_FAULT_WITHOUT_ORIGIN');
  }
  const statements = [],
    uniqueBlockers = [...new Set(blockers)];
  if (
    uniqueBlockers.length ||
    (!accounting.drift.length && !repairs.length && flags.accounting_fault === 0)
  )
    return { accounting, blockers: uniqueBlockers, repairs, statements };
  statements.push(assertSql(guard(snapshot, accounting, now)));
  for (const repair of repairs) {
    const assignments = repair.code.startsWith('STALE_')
      ? "state='committed',settled_at=" +
        now +
        ',' +
        METRICS.flatMap((m) => [
          'committed_' + m + '=reserved_' + m,
          'measured_' + m + '=reserved_' + m,
          'released_' + m + '=0',
        ]).join(',') +
        ','
      : '';
    statements.push(
      'UPDATE usage_reservations SET ' +
        assignments +
        ' reconciled_at=' +
        now +
        ',reconciliation_code=' +
        quote(repair.code) +
        ' WHERE reservation_id=' +
        quote(repair.reservationId) +
        ' AND reconciled_at IS NULL',
    );
  }
  for (const name of ['daily', 'rolling']) {
    const table = tables[name][0],
      fields = columns[name].filter((c) => !['updated_at', 'refreshed_at'].includes(c));
    const timeField = name === 'daily' ? 'updated_at' : 'refreshed_at';
    statements.push(
      'DELETE FROM ' +
        table +
        ' WHERE NOT (' +
        accounting[name]
          .map((r) =>
            fields
              .filter((c) => !METRICS.includes(c))
              .map((c) => c + '=' + quote(r[c]))
              .join(' AND '),
          )
          .map((s) => '(' + s + ')')
          .join(' OR ') +
        ')',
    );
    for (const row of accounting[name])
      statements.push(
        'INSERT INTO ' +
          table +
          '(' +
          fields.join(',') +
          ',' +
          timeField +
          ') VALUES(' +
          fields.map((c) => quote(row[c])).join(',') +
          ',' +
          now +
          ')' +
          ' ON CONFLICT(' +
          tables[name][1] +
          ') DO UPDATE SET ' +
          METRICS.map((m) => m + '=excluded.' + m).join(',') +
          ',' +
          timeField +
          '=excluded.' +
          timeField +
          ' WHERE ' +
          METRICS.map((m) => table + '.' + m + ' != excluded.' + m).join(' OR '),
      );
    statements.push(assertSql(cacheJson(name) + '=' + quote(JSON.stringify(accounting[name]))));
  }
  statements.push(
    assertSql(
      "date('now') = " +
        quote(accounting.today) +
        " AND NOT EXISTS(SELECT 1 FROM usage_reservations WHERE state='reserved' OR (settlement_failure_code IS NOT NULL AND reconciled_at IS NULL))",
    ),
  );
  if (flags.accounting_fault === 1)
    statements.push(
      "UPDATE service_flags SET accounting_fault=0,state_reason='NONE',state_request_id=NULL," +
        'accounting_fault_at=NULL,updated_at=' +
        now +
        ' WHERE singleton_id=1 AND accounting_fault=1 AND updated_at=' +
        flags.updated_at +
        ' AND state_reason=' +
        quote(flags.state_reason) +
        ' AND state_request_id IS ' +
        quote(flags.state_request_id) +
        ' AND accounting_fault_at IS ' +
        quote(flags.accounting_fault_at),
    );
  return { accounting, blockers: [], repairs, statements };
}

export function safeAccountingSummary(snapshot, accounting) {
  const flags = snapshot.flags[0],
    failures = snapshot.reservations.filter(unresolved);
  const reasons = [
    'NONE',
    'USAGE_RESERVATION_UNDERESTIMATED',
    'USAGE_SETTLEMENT_FAILED',
    'STALE_RESERVATION_REQUIRES_RECONCILIATION',
  ];
  return {
    reason: reasons.includes(flags?.state_reason) ? flags.state_reason : 'UNKNOWN',
    request: UUID.test(flags?.state_request_id ?? '') ? flags.state_request_id : null,
    routes: [
      ...new Set(
        failures.map((x) =>
          API_ROUTE_REGISTRY.some((r) => r.id === x.route_key) ||
          x.route_key === 'scheduled-cleanup'
            ? x.route_key
            : 'unknown',
        ),
      ),
    ],
    unresolvedReservations: failures.length,
    aggregateDrift: accounting.drift.length > 0,
    code: accounting.drift.length
      ? 'ACCOUNTING_AGGREGATE_DRIFT'
      : flags?.accounting_fault
        ? 'ACCOUNTING_FAULT_ACTIVE'
        : 'ACCOUNTING_OK',
  };
}
