import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SINCE = /^(\d{1,3})(m|h|d)$/u;
const DATABASE = 'mirna-sync-staging-eu';
const CONFIG = 'services/sync-worker/wrangler.jsonc';
const MAX_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1_000;
const ROLLING_WINDOW_MS = 29 * 24 * 60 * 60 * 1_000;
const BUDGETS = Object.freeze({
  worker_requests: 1_500_000,
  d1_rows_read: 25_000_000,
  d1_rows_written: 500_000,
  r2_class_a: 400_000,
  r2_class_b: 4_000_000,
  worker_requests_daily: 50_000,
  d1_rows_read_daily: 2_000_000,
  d1_rows_written_daily: 40_000,
  r2_class_a_daily: 20_000,
  r2_class_b_daily: 200_000,
  d1_storage_bytes: 256 * 1_024 * 1_024,
});

const [mode, ...rawArguments] = process.argv.slice(2);
if (!['diagnose', 'repair'].includes(mode)) {
  throw new Error('Upotreba: sync-budget-accounting.mjs <diagnose|repair> [opcije]');
}

const options = new Map();
const switches = new Set();
for (let index = 0; index < rawArguments.length; index += 1) {
  const key = rawArguments[index];
  if (!key?.startsWith('--')) throw new Error(`Nepoznata opcija: ${key ?? ''}`);
  if (['--apply', '--business-committed'].includes(key)) {
    switches.add(key);
    continue;
  }
  const value = rawArguments[index + 1];
  if (value === undefined || value.startsWith('--'))
    throw new Error(`Nedostaje vrednost za ${key}.`);
  options.set(key, value);
  index += 1;
}

if ((options.get('--env') ?? 'staging') !== 'staging') {
  throw new Error('Ovaj alat odbija sva okruženja osim eksplicitnog staging okruženja.');
}
const requestId = options.get('--request');
if (requestId && !REQUEST_ID.test(requestId)) throw new Error('Request ID nije ispravan.');
if (mode === 'repair' && !requestId) throw new Error('Repair zahteva tačan --request ID.');
if (mode === 'repair' && !switches.has('--apply')) {
  throw new Error('Repair je odbijen bez eksplicitnog --apply parametra.');
}

const since = options.get('--since') ?? '6h';
const parsedSince = SINCE.exec(since);
if (!parsedSince) throw new Error('--since mora biti, na primer, 30m, 6h ili 7d.');
const multiplier =
  parsedSince[2] === 'm' ? 60_000 : parsedSince[2] === 'h' ? 3_600_000 : 86_400_000;
const lookbackMs = Number(parsedSince[1]) * multiplier;
if (!Number.isSafeInteger(lookbackMs) || lookbackMs < 60_000 || lookbackMs > MAX_LOOKBACK_MS) {
  throw new Error('--since mora biti između 1 minuta i 14 dana.');
}

const wrangler = (command) => {
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      'wrangler',
      'd1',
      'execute',
      DATABASE,
      '--remote',
      '--env',
      'staging',
      '--config',
      CONFIG,
      '--command',
      command,
      '--json',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'Staging D1 komanda nije uspela.\n');
    process.exit(result.status ?? 1);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('Wrangler nije vratio očekivani JSON odgovor.');
  }
};

const resultSets = (payload) => {
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries.map((entry) =>
    Array.isArray(entry?.results)
      ? entry.results
      : Array.isArray(entry?.result?.results)
        ? entry.result.results
        : [],
  );
};

const query = (sql) => resultSets(wrangler(sql))[0] ?? [];
const sqlText = (value) => `'${value.replaceAll("'", "''")}'`;
const now = Date.now();
const createdAfter = now - lookbackMs;
const requestPredicate = requestId
  ? `reservation_id LIKE ${sqlText(`${requestId}:%`)}`
  : `created_at >= ${createdAfter}`;

const snapshot = () => ({
  capturedAt: new Date(now).toISOString(),
  environment: 'staging',
  requestId: requestId ?? null,
  reservations: query(
    `SELECT reservation_id, scope_type, scope_id, route_key, state,
            reserved_worker_requests, reserved_d1_rows_read, reserved_d1_rows_written,
            reserved_r2_class_a, reserved_r2_class_b,
            committed_worker_requests, committed_d1_rows_read, committed_d1_rows_written,
            committed_r2_class_a, committed_r2_class_b,
            released_worker_requests, released_d1_rows_read, released_d1_rows_written,
            released_r2_class_a, released_r2_class_b,
            measurement_exact, measured_worker_requests, measured_d1_rows_read,
            measured_d1_rows_written, measured_r2_class_a, measured_r2_class_b,
            settlement_failure_code, business_committed, reconciled_at,
            reconciliation_code, created_at, settled_at
       FROM usage_reservations
      WHERE ${requestPredicate}
      ORDER BY created_at, reservation_id
      LIMIT 1000`,
  ),
  serviceFlags: query(
    `SELECT accept_new_vaults, accept_pairings, accept_writes, maintenance_mode,
            accounting_fault, state_reason, state_request_id, accounting_fault_at, updated_at
       FROM service_flags WHERE singleton_id = 1`,
  ),
  globalRolling: query(
    `SELECT worker_requests, d1_rows_read, d1_rows_written, r2_class_a, r2_class_b,
            refreshed_at
       FROM usage_rolling_totals
      WHERE scope_type = 'global' AND scope_id = 'service'`,
  ),
  recentGlobalDaily: query(
    `SELECT utc_day, worker_requests, d1_rows_read, d1_rows_written, r2_class_a, r2_class_b,
            updated_at
       FROM usage_daily_buckets
      WHERE scope_type = 'global' AND scope_id = 'service'
        AND updated_at >= ${createdAfter}
      ORDER BY utc_day DESC
      LIMIT 35`,
  ),
  resources: query(
    `SELECT r2_stored_bytes, r2_object_count, d1_storage_bytes, r2_reconciled_at, updated_at
       FROM resource_totals WHERE singleton_id = 1`,
  ),
  unresolved: query(
    `SELECT
       SUM(CASE WHEN state = 'reserved' THEN 1 ELSE 0 END) AS reserved_count,
       SUM(CASE WHEN settlement_failure_code IS NOT NULL AND reconciled_at IS NULL THEN 1 ELSE 0 END)
         AS unreconciled_failure_count
       FROM usage_reservations`,
  ),
});

const evidenceDirectory = path.resolve('.private/sync-budget-evidence');
const writeEvidence = (label, data) => {
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const file = path.join(evidenceDirectory, `${timestamp}-${label}.json`);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
};

const before = snapshot();
const backupPath = writeEvidence(mode === 'repair' ? 'pre-repair' : 'diagnose', before);

if (mode === 'diagnose') {
  process.stdout.write(
    `${JSON.stringify(
      {
        evidence: backupPath,
        reservationCount: before.reservations.length,
        serviceFlags: before.serviceFlags[0] ?? null,
        globalRolling: before.globalRolling[0] ?? null,
        resources: before.resources[0] ?? null,
        unresolved: before.unresolved[0] ?? null,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

if (before.reservations.length === 0)
  throw new Error('Za Request ID ne postoje accounting rezervacije.');
const isVaultCreateIncident = before.reservations.some((row) => row.route_key === 'vault-create');
const isScheduledCleanupIncident = before.reservations.some(
  (row) => row.route_key === 'scheduled-cleanup',
);
if (!isVaultCreateIncident && !isScheduledCleanupIncident) {
  throw new Error('Repair je odbijen: zahtev nema podržanu accounting incident rezervaciju.');
}
if (
  isScheduledCleanupIncident &&
  (before.reservations.some(
    (row) =>
      row.scope_type !== 'global' || row.scope_id !== 'service' || row.business_committed !== 0,
  ) ||
    !before.reservations.some(
      (row) =>
        row.route_key === 'scheduled-cleanup' &&
        row.measurement_exact === 1 &&
        row.settlement_failure_code === 'USAGE_RESERVATION_UNDERESTIMATED' &&
        row.measured_d1_rows_read > row.reserved_d1_rows_read,
    ))
) {
  throw new Error('Repair je odbijen: scheduled-cleanup dokaz nije tačan i potpun.');
}
if (before.reservations.some((row) => row.state === 'reserved' && row.measurement_exact !== 1)) {
  throw new Error('Repair je odbijen: rezervisana potrošnja nema exact metadata dokaz.');
}
const flags = before.serviceFlags[0];
const rolling = before.globalRolling[0];
const resources = before.resources[0];
const today = new Date(now).toISOString().slice(0, 10);
const daily = before.recentGlobalDaily.find((row) => row.utc_day === today) ?? {};
if (!flags || !rolling || !resources) throw new Error('Accounting stanje nije potpuno.');

const below = (row, field, limit) => Number(row[field] ?? 0) < limit;
const withinHardLimits =
  below(rolling, 'worker_requests', BUDGETS.worker_requests) &&
  below(rolling, 'd1_rows_read', BUDGETS.d1_rows_read) &&
  below(rolling, 'd1_rows_written', BUDGETS.d1_rows_written) &&
  below(rolling, 'r2_class_a', BUDGETS.r2_class_a) &&
  below(rolling, 'r2_class_b', BUDGETS.r2_class_b) &&
  below(daily, 'worker_requests', BUDGETS.worker_requests_daily) &&
  below(daily, 'd1_rows_read', BUDGETS.d1_rows_read_daily) &&
  below(daily, 'd1_rows_written', BUDGETS.d1_rows_written_daily) &&
  below(daily, 'r2_class_a', BUDGETS.r2_class_a_daily) &&
  below(daily, 'r2_class_b', BUDGETS.r2_class_b_daily) &&
  below(resources, 'd1_storage_bytes', BUDGETS.d1_storage_bytes);
if (!withinHardLimits)
  throw new Error('Repair je odbijen: najmanje jedan stvarni hard limit nije bezbedan.');

const outsideUnresolved = query(
  `SELECT COUNT(*) AS count FROM usage_reservations
    WHERE (state = 'reserved' OR (settlement_failure_code IS NOT NULL AND reconciled_at IS NULL))
      AND reservation_id NOT LIKE ${sqlText(`${requestId}:%`)}`,
)[0]?.count;
if (Number(outsideUnresolved ?? 0) !== 0) {
  throw new Error('Repair je odbijen: postoji drugi nerešen accounting incident.');
}

const alreadyReconciled =
  before.reservations.every((row) => row.reconciled_at !== null) &&
  flags.accept_new_vaults === 1 &&
  flags.accept_pairings === 1 &&
  flags.accept_writes === 1 &&
  flags.maintenance_mode === 0 &&
  flags.accounting_fault === 0;
if (alreadyReconciled) {
  process.stdout.write(`${JSON.stringify({ changed: false, evidence: backupPath }, null, 2)}\n`);
  process.exit(0);
}

const createdTimes = before.reservations.map((row) => Number(row.created_at));
const settledTimes = before.reservations.map((row) => Number(row.settled_at ?? row.created_at));
if (
  Number(flags.updated_at) < Math.min(...createdTimes) - 5 * 60 * 1_000 ||
  Number(flags.updated_at) > Math.max(...settledTimes) + 60 * 60 * 1_000
) {
  throw new Error('Repair je odbijen: promena service flagova nije vremenski vezana za zahtev.');
}

const requestPattern = sqlText(`${requestId}:%`);
const cutoffDay = new Date(now - ROLLING_WINDOW_MS).toISOString().slice(0, 10);
if (isScheduledCleanupIncident && switches.has('--business-committed')) {
  throw new Error('Repair je odbijen: scheduled-cleanup ne može imati business commit.');
}
const businessCommitted = switches.has('--business-committed') ? 1 : 0;
const statements = [
  `UPDATE usage_reservations
      SET state = CASE
            WHEN state = 'reserved' AND measured_worker_requests + measured_d1_rows_read +
                 measured_d1_rows_written + measured_r2_class_a + measured_r2_class_b = 0
              THEN 'released'
            WHEN state = 'reserved' THEN 'committed'
            ELSE state
          END,
          committed_worker_requests = CASE WHEN state = 'reserved' THEN measured_worker_requests ELSE committed_worker_requests END,
          committed_d1_rows_read = CASE WHEN state = 'reserved' THEN measured_d1_rows_read ELSE committed_d1_rows_read END,
          committed_d1_rows_written = CASE WHEN state = 'reserved' THEN measured_d1_rows_written ELSE committed_d1_rows_written END,
          committed_r2_class_a = CASE WHEN state = 'reserved' THEN measured_r2_class_a ELSE committed_r2_class_a END,
          committed_r2_class_b = CASE WHEN state = 'reserved' THEN measured_r2_class_b ELSE committed_r2_class_b END,
          released_worker_requests = CASE WHEN state = 'reserved' THEN MAX(0, reserved_worker_requests - measured_worker_requests) ELSE released_worker_requests END,
          released_d1_rows_read = CASE WHEN state = 'reserved' THEN MAX(0, reserved_d1_rows_read - measured_d1_rows_read) ELSE released_d1_rows_read END,
          released_d1_rows_written = CASE WHEN state = 'reserved' THEN MAX(0, reserved_d1_rows_written - measured_d1_rows_written) ELSE released_d1_rows_written END,
          released_r2_class_a = CASE WHEN state = 'reserved' THEN MAX(0, reserved_r2_class_a - measured_r2_class_a) ELSE released_r2_class_a END,
          released_r2_class_b = CASE WHEN state = 'reserved' THEN MAX(0, reserved_r2_class_b - measured_r2_class_b) ELSE released_r2_class_b END,
          business_committed = CASE WHEN route_key = 'vault-create' THEN MAX(business_committed, ${businessCommitted}) ELSE business_committed END,
          reconciled_at = COALESCE(reconciled_at, ${now}),
          reconciliation_code = COALESCE(reconciliation_code, 'OPERATOR_REQUEST_RECONCILIATION'),
          settled_at = COALESCE(settled_at, ${now})
    WHERE reservation_id LIKE ${requestPattern}`,
  `UPDATE usage_daily_buckets
      SET worker_requests = COALESCE((SELECT SUM(r.committed_worker_requests) FROM usage_reservations r WHERE r.scope_type = usage_daily_buckets.scope_type AND r.scope_id = usage_daily_buckets.scope_id AND strftime('%Y-%m-%d', r.created_at / 1000, 'unixepoch') = usage_daily_buckets.utc_day), 0),
          d1_rows_read = COALESCE((SELECT SUM(r.committed_d1_rows_read) FROM usage_reservations r WHERE r.scope_type = usage_daily_buckets.scope_type AND r.scope_id = usage_daily_buckets.scope_id AND strftime('%Y-%m-%d', r.created_at / 1000, 'unixepoch') = usage_daily_buckets.utc_day), 0),
          d1_rows_written = COALESCE((SELECT SUM(r.committed_d1_rows_written) FROM usage_reservations r WHERE r.scope_type = usage_daily_buckets.scope_type AND r.scope_id = usage_daily_buckets.scope_id AND strftime('%Y-%m-%d', r.created_at / 1000, 'unixepoch') = usage_daily_buckets.utc_day), 0),
          r2_class_a = COALESCE((SELECT SUM(r.committed_r2_class_a) FROM usage_reservations r WHERE r.scope_type = usage_daily_buckets.scope_type AND r.scope_id = usage_daily_buckets.scope_id AND strftime('%Y-%m-%d', r.created_at / 1000, 'unixepoch') = usage_daily_buckets.utc_day), 0),
          r2_class_b = COALESCE((SELECT SUM(r.committed_r2_class_b) FROM usage_reservations r WHERE r.scope_type = usage_daily_buckets.scope_type AND r.scope_id = usage_daily_buckets.scope_id AND strftime('%Y-%m-%d', r.created_at / 1000, 'unixepoch') = usage_daily_buckets.utc_day), 0),
          updated_at = ${now}`,
  `UPDATE usage_rolling_totals
      SET worker_requests = COALESCE((SELECT SUM(d.worker_requests) FROM usage_daily_buckets d WHERE d.scope_type = usage_rolling_totals.scope_type AND d.scope_id = usage_rolling_totals.scope_id AND d.utc_day >= ${sqlText(cutoffDay)}), 0),
          d1_rows_read = COALESCE((SELECT SUM(d.d1_rows_read) FROM usage_daily_buckets d WHERE d.scope_type = usage_rolling_totals.scope_type AND d.scope_id = usage_rolling_totals.scope_id AND d.utc_day >= ${sqlText(cutoffDay)}), 0),
          d1_rows_written = COALESCE((SELECT SUM(d.d1_rows_written) FROM usage_daily_buckets d WHERE d.scope_type = usage_rolling_totals.scope_type AND d.scope_id = usage_rolling_totals.scope_id AND d.utc_day >= ${sqlText(cutoffDay)}), 0),
          r2_class_a = COALESCE((SELECT SUM(d.r2_class_a) FROM usage_daily_buckets d WHERE d.scope_type = usage_rolling_totals.scope_type AND d.scope_id = usage_rolling_totals.scope_id AND d.utc_day >= ${sqlText(cutoffDay)}), 0),
          r2_class_b = COALESCE((SELECT SUM(d.r2_class_b) FROM usage_daily_buckets d WHERE d.scope_type = usage_rolling_totals.scope_type AND d.scope_id = usage_rolling_totals.scope_id AND d.utc_day >= ${sqlText(cutoffDay)}), 0),
          refreshed_at = ${now}`,
  `UPDATE service_flags
      SET accept_new_vaults = 1, accept_pairings = 1, accept_writes = 1,
          maintenance_mode = 0, accounting_fault = 0, state_reason = 'NONE',
          state_request_id = NULL, accounting_fault_at = NULL, updated_at = ${now}
    WHERE singleton_id = 1
      AND NOT EXISTS (SELECT 1 FROM usage_reservations WHERE state = 'reserved')
      AND NOT EXISTS (SELECT 1 FROM usage_reservations WHERE settlement_failure_code IS NOT NULL AND reconciled_at IS NULL)
      AND (SELECT worker_requests FROM usage_rolling_totals WHERE scope_type = 'global' AND scope_id = 'service') < ${BUDGETS.worker_requests}
      AND (SELECT d1_rows_read FROM usage_rolling_totals WHERE scope_type = 'global' AND scope_id = 'service') < ${BUDGETS.d1_rows_read}
      AND (SELECT d1_rows_written FROM usage_rolling_totals WHERE scope_type = 'global' AND scope_id = 'service') < ${BUDGETS.d1_rows_written}
      AND (SELECT d1_storage_bytes FROM resource_totals WHERE singleton_id = 1) < ${BUDGETS.d1_storage_bytes}`,
].join(';\n');

wrangler(statements);
const after = snapshot();
const afterFlags = after.serviceFlags[0];
if (
  !afterFlags ||
  afterFlags.accept_new_vaults !== 1 ||
  afterFlags.accept_pairings !== 1 ||
  afterFlags.accept_writes !== 1 ||
  afterFlags.maintenance_mode !== 0 ||
  afterFlags.accounting_fault !== 0
) {
  throw new Error('Repair batch nije bezbedno obnovio staging service flagove.');
}
const afterPath = writeEvidence('post-repair', after);
process.stdout.write(
  `${JSON.stringify(
    {
      changed: true,
      requestId,
      beforeEvidence: backupPath,
      afterEvidence: afterPath,
      reconciledReservations: after.reservations.length,
      serviceFlags: afterFlags,
      globalRolling: after.globalRolling[0] ?? null,
    },
    null,
    2,
  )}\n`,
);
