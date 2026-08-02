import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  assertPairingRequestId,
  assertProjectedUsageBelowLimits,
  validatePairingCreateRepair,
} from './sync-budget-repair-contract.mjs';

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
const operation = options.get('--operation');
const pairingRequestId = options.get('--pairing-request');
if (mode === 'repair' && operation === 'pairing-create') {
  assertPairingRequestId(pairingRequestId);
  if (switches.has('--business-committed')) {
    throw new Error(
      'Pairing repair odbija --business-committed: commit se izvodi samo iz D1 business dokaza.',
    );
  }
} else if (pairingRequestId !== undefined) {
  throw new Error('--pairing-request je dozvoljen samo uz --operation pairing-create.');
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

const changedRows = (payload) => {
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries.reduce(
    (total, entry) => total + Number(entry?.meta?.changes ?? entry?.result?.meta?.changes ?? 0),
    0,
  );
};

const query = (sql) => resultSets(wrangler(sql))[0] ?? [];
const sqlText = (value) => `'${value.replaceAll("'", "''")}'`;
const now = Date.now();
const createdAfter = now - lookbackMs;
const requestPredicate = requestId
  ? `reservation_id LIKE ${sqlText(`${requestId}:%`)}`
  : `created_at >= ${createdAfter}`;
const today = new Date(now).toISOString().slice(0, 10);
const cutoffDay = new Date(now - ROLLING_WINDOW_MS).toISOString().slice(0, 10);

const projectedUsage = () => ({
  rolling: query(
    `SELECT COALESCE(SUM(committed_worker_requests), 0) AS worker_requests,
            COALESCE(SUM(committed_d1_rows_read), 0) AS d1_rows_read,
            COALESCE(SUM(committed_d1_rows_written), 0) AS d1_rows_written,
            COALESCE(SUM(committed_r2_class_a), 0) AS r2_class_a,
            COALESCE(SUM(committed_r2_class_b), 0) AS r2_class_b
       FROM usage_reservations
      WHERE scope_type = 'global' AND scope_id = 'service'
        AND strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') >= ${sqlText(cutoffDay)}`,
  )[0],
  daily: query(
    `SELECT COALESCE(SUM(committed_worker_requests), 0) AS worker_requests,
            COALESCE(SUM(committed_d1_rows_read), 0) AS d1_rows_read,
            COALESCE(SUM(committed_d1_rows_written), 0) AS d1_rows_written,
            COALESCE(SUM(committed_r2_class_a), 0) AS r2_class_a,
            COALESCE(SUM(committed_r2_class_b), 0) AS r2_class_b
       FROM usage_reservations
      WHERE scope_type = 'global' AND scope_id = 'service'
        AND strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') = ${sqlText(today)}`,
  )[0],
});

const pairingBusinessEvidence = () => {
  if (operation !== 'pairing-create' || !pairingRequestId) return null;
  return (
    query(
      `SELECT p.pairing_request_id, p.status,
              CASE WHEN p.vault_id IS NULL THEN 0 ELSE 1 END AS vault_assigned,
              p.created_at, p.expires_at, p.finalized_at, p.cancelled_at,
              CASE WHEN p.finalization_hash IS NULL THEN 0 ELSE 1 END AS has_finalization_hash,
              (SELECT COUNT(*) FROM pairing_envelopes e
                WHERE e.pairing_request_id = p.pairing_request_id) AS envelope_count,
              (SELECT COUNT(*) FROM devices d
                WHERE d.device_id = p.new_device_id) AS device_count,
              (SELECT COUNT(*) FROM device_grants g
                WHERE g.device_id = p.new_device_id) AS grant_count,
              (SELECT COUNT(*) FROM pairing_requests candidate
                WHERE candidate.created_at BETWEEN
                  (SELECT created_at FROM usage_reservations
                    WHERE reservation_id = ${sqlText(`${requestId}:route`)})
                  AND
                  (SELECT settled_at FROM usage_reservations
                    WHERE reservation_id = ${sqlText(`${requestId}:route`)}))
                AS interval_candidate_count
         FROM pairing_requests p
        WHERE p.pairing_request_id = ${sqlText(pairingRequestId)}
        LIMIT 1`,
    )[0] ?? null
  );
};

const snapshot = () => {
  const projected = projectedUsage();
  return {
    capturedAt: new Date(now).toISOString(),
    environment: 'staging',
    requestId: requestId ?? null,
    operation: operation ?? null,
    pairingRequestId: pairingRequestId ?? null,
    pairingBusinessEvidence: pairingBusinessEvidence(),
    pairingTotals:
      mode === 'repair'
        ? (query(
            `SELECT total_count,
                    (SELECT COUNT(*) FROM pairing_requests) AS actual_count,
                    updated_at
               FROM pairing_request_totals WHERE singleton_id = 1`,
          )[0] ?? null)
        : null,
    projectedGlobalRolling: projected.rolling ?? null,
    projectedGlobalDaily: projected.daily ?? null,
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
  };
};

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
const isPairingCreateIncident = before.reservations.some(
  (row) => row.route_key === 'pairing-create',
);
if (!isPairingCreateIncident || operation !== 'pairing-create') {
  throw new Error(
    'Repair je ograničen na pairing-create i zahteva --operation pairing-create i --pairing-request.',
  );
}
if (before.reservations.some((row) => row.state === 'reserved' && row.measurement_exact !== 1)) {
  throw new Error('Repair je odbijen: rezervisana potrošnja nema exact metadata dokaz.');
}
const flags = before.serviceFlags[0];
const resources = before.resources[0];
if (!flags || !resources) throw new Error('Accounting stanje nije potpuno.');

assertProjectedUsageBelowLimits({
  rolling: before.projectedGlobalRolling,
  daily: before.projectedGlobalDaily,
  resources,
  budgets: BUDGETS,
});

const outsideUnresolved = query(
  `SELECT COUNT(*) AS count FROM usage_reservations
    WHERE (state = 'reserved' OR (settlement_failure_code IS NOT NULL AND reconciled_at IS NULL))
      AND reservation_id NOT LIKE ${sqlText(`${requestId}:%`)}`,
)[0]?.count;
if (Number(outsideUnresolved ?? 0) !== 0) {
  throw new Error('Repair je odbijen: postoji drugi nerešen accounting incident.');
}

const incidentReservations = before.reservations.filter(
  (row) => row.state === 'reserved' || row.settlement_failure_code !== null,
);
const alreadyReconciled =
  incidentReservations.length > 0 &&
  incidentReservations.every((row) => row.reconciled_at !== null) &&
  flags.accept_new_vaults === 1 &&
  flags.accept_pairings === 1 &&
  flags.accept_writes === 1 &&
  flags.maintenance_mode === 0 &&
  flags.accounting_fault === 0;
if (alreadyReconciled) {
  process.stdout.write(`${JSON.stringify({ changed: false, evidence: backupPath }, null, 2)}\n`);
  process.exit(0);
}

const pairingRepair = isPairingCreateIncident
  ? validatePairingCreateRepair({
      requestId,
      pairingRequestId,
      reservations: before.reservations,
      serviceFlags: flags,
      pairingEvidence: before.pairingBusinessEvidence,
    })
  : null;

const routeBefore = before.reservations.find(
  (row) => row.reservation_id === pairingRepair.reservationId,
);
const requestBefore = before.reservations.find(
  (row) => row.reservation_id === `${requestId}:request`,
);
if (!routeBefore || !requestBefore || !before.pairingTotals) {
  throw new Error('Repair je odbijen: incident ili pairing counter stanje nije potpuno.');
}
if (before.pairingTotals.total_count !== before.pairingTotals.actual_count) {
  throw new Error('Repair je odbijen: pairing request counter nije usklađen.');
}

if (pairingRepair.reservationNeedsUpdate) {
  const reservationUpdate = wrangler(
    `UPDATE usage_reservations
        SET business_committed = 1,
            reconciled_at = ${now},
            reconciliation_code = ${sqlText(pairingRepair.reconciliationCode)}
      WHERE reservation_id = ${sqlText(pairingRepair.reservationId)}
        AND scope_type = 'global' AND scope_id = 'service'
        AND route_key = 'pairing-create' AND state = 'committed'
        AND measurement_exact = 1
        AND settlement_failure_code = 'USAGE_RESERVATION_UNDERESTIMATED'
        AND reserved_worker_requests = 0
        AND reserved_d1_rows_read = 512 AND reserved_d1_rows_written = 16
        AND reserved_r2_class_a = 0 AND reserved_r2_class_b = 0
        AND measured_worker_requests = 0
        AND measured_d1_rows_read = 55 AND measured_d1_rows_written = 19
        AND measured_r2_class_a = 0 AND measured_r2_class_b = 0
        AND committed_worker_requests = 0
        AND committed_d1_rows_read = 55 AND committed_d1_rows_written = 19
        AND committed_r2_class_a = 0 AND committed_r2_class_b = 0
        AND released_worker_requests = 0
        AND released_d1_rows_read = 457 AND released_d1_rows_written = 0
        AND released_r2_class_a = 0 AND released_r2_class_b = 0
        AND business_committed = 0 AND reconciled_at IS NULL AND reconciliation_code IS NULL
        AND created_at = ${Number(routeBefore.created_at)}
        AND settled_at = ${pairingRepair.faultTimestamp}
        AND EXISTS (
          SELECT 1 FROM pairing_requests p
           WHERE p.pairing_request_id = ${sqlText(pairingRequestId)}
             AND p.created_at BETWEEN ${Number(routeBefore.created_at)} AND ${pairingRepair.faultTimestamp}
             AND p.status = 'pending' AND p.vault_id IS NULL
             AND p.finalized_at IS NULL AND p.cancelled_at IS NULL
             AND p.finalization_hash IS NULL
             AND NOT EXISTS (SELECT 1 FROM pairing_envelopes e WHERE e.pairing_request_id = p.pairing_request_id)
             AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.device_id = p.new_device_id)
             AND NOT EXISTS (SELECT 1 FROM device_grants g WHERE g.device_id = p.new_device_id)
        )
        AND 1 = (
          SELECT COUNT(*) FROM pairing_requests
           WHERE created_at BETWEEN ${Number(routeBefore.created_at)} AND ${pairingRepair.faultTimestamp}
        )`,
  );
  if (changedRows(reservationUpdate) !== 1) {
    throw new Error('Repair je zaustavljen: target reservation CAS nije promenio tačno jedan red.');
  }
}

const mid = snapshot();
const midRepair = validatePairingCreateRepair({
  requestId,
  pairingRequestId,
  reservations: mid.reservations,
  serviceFlags: mid.serviceFlags[0],
  pairingEvidence: mid.pairingBusinessEvidence,
});
if (midRepair.reservationNeedsUpdate) {
  throw new Error('Repair je zaustavljen: pairing reservation nije trajno reconciled.');
}
assertProjectedUsageBelowLimits({
  rolling: mid.projectedGlobalRolling,
  daily: mid.projectedGlobalDaily,
  resources: mid.resources[0],
  budgets: BUDGETS,
});

const flagUpdate = wrangler(
  `UPDATE service_flags
      SET accounting_fault = 0, state_reason = 'NONE', state_request_id = NULL,
          accounting_fault_at = NULL, updated_at = ${now}
    WHERE singleton_id = 1
      AND accept_new_vaults = 1 AND accept_pairings = 1 AND accept_writes = 1
      AND maintenance_mode = 0 AND accounting_fault = 1
      AND state_reason = 'USAGE_RESERVATION_UNDERESTIMATED'
      AND state_request_id = ${sqlText(requestId)}
      AND accounting_fault_at = ${pairingRepair.faultTimestamp}
      AND updated_at = ${pairingRepair.faultTimestamp}
      AND EXISTS (
        SELECT 1 FROM usage_reservations
         WHERE reservation_id = ${sqlText(pairingRepair.reservationId)}
           AND business_committed = 1 AND reconciled_at IS NOT NULL
           AND reconciliation_code = ${sqlText(pairingRepair.reconciliationCode)}
      )
      AND EXISTS (
        SELECT 1 FROM pairing_requests
         WHERE pairing_request_id = ${sqlText(pairingRequestId)}
           AND created_at BETWEEN ${Number(routeBefore.created_at)} AND ${pairingRepair.faultTimestamp}
           AND status = 'pending' AND vault_id IS NULL
           AND finalized_at IS NULL AND cancelled_at IS NULL AND finalization_hash IS NULL
      )
      AND 1 = (SELECT COUNT(*) FROM pairing_requests
                WHERE created_at BETWEEN ${Number(routeBefore.created_at)} AND ${pairingRepair.faultTimestamp})
      AND NOT EXISTS (SELECT 1 FROM usage_reservations WHERE state = 'reserved')
      AND NOT EXISTS (SELECT 1 FROM usage_reservations
                       WHERE settlement_failure_code IS NOT NULL AND reconciled_at IS NULL)
      AND (SELECT worker_requests FROM usage_rolling_totals
            WHERE scope_type = 'global' AND scope_id = 'service') < ${BUDGETS.worker_requests}
      AND (SELECT d1_rows_read FROM usage_rolling_totals
            WHERE scope_type = 'global' AND scope_id = 'service') < ${BUDGETS.d1_rows_read}
      AND (SELECT d1_rows_written FROM usage_rolling_totals
            WHERE scope_type = 'global' AND scope_id = 'service') < ${BUDGETS.d1_rows_written}
      AND (SELECT r2_class_a FROM usage_rolling_totals
            WHERE scope_type = 'global' AND scope_id = 'service') < ${BUDGETS.r2_class_a}
      AND (SELECT r2_class_b FROM usage_rolling_totals
            WHERE scope_type = 'global' AND scope_id = 'service') < ${BUDGETS.r2_class_b}
      AND (SELECT worker_requests FROM usage_daily_buckets
            WHERE scope_type = 'global' AND scope_id = 'service' AND utc_day = ${sqlText(today)}) < ${BUDGETS.worker_requests_daily}
      AND (SELECT d1_rows_read FROM usage_daily_buckets
            WHERE scope_type = 'global' AND scope_id = 'service' AND utc_day = ${sqlText(today)}) < ${BUDGETS.d1_rows_read_daily}
      AND (SELECT d1_rows_written FROM usage_daily_buckets
            WHERE scope_type = 'global' AND scope_id = 'service' AND utc_day = ${sqlText(today)}) < ${BUDGETS.d1_rows_written_daily}
      AND (SELECT r2_class_a FROM usage_daily_buckets
            WHERE scope_type = 'global' AND scope_id = 'service' AND utc_day = ${sqlText(today)}) < ${BUDGETS.r2_class_a_daily}
      AND (SELECT r2_class_b FROM usage_daily_buckets
            WHERE scope_type = 'global' AND scope_id = 'service' AND utc_day = ${sqlText(today)}) < ${BUDGETS.r2_class_b_daily}
      AND (SELECT d1_storage_bytes FROM resource_totals WHERE singleton_id = 1) < ${BUDGETS.d1_storage_bytes}
      AND (SELECT total_count FROM pairing_request_totals WHERE singleton_id = 1) =
          (SELECT COUNT(*) FROM pairing_requests)`,
);
if (changedRows(flagUpdate) !== 1) {
  throw new Error(
    'Repair je ostao fail-closed: service flags CAS nije promenio tačno jedan red; bezbedno ponovite isti zahtev.',
  );
}
const after = snapshot();
const afterFlags = after.serviceFlags[0];
const afterTarget = after.reservations.find(
  (row) => row.reservation_id === pairingRepair.reservationId,
);
const afterRequest = after.reservations.find(
  (row) => row.reservation_id === `${requestId}:request`,
);
if (
  !afterFlags ||
  afterFlags.accept_new_vaults !== 1 ||
  afterFlags.accept_pairings !== 1 ||
  afterFlags.accept_writes !== 1 ||
  afterFlags.maintenance_mode !== 0 ||
  afterFlags.accounting_fault !== 0 ||
  afterFlags.state_reason !== 'NONE' ||
  afterFlags.state_request_id !== null ||
  afterFlags.accounting_fault_at !== null
) {
  throw new Error('Repair batch nije bezbedno obnovio staging service flagove.');
}
if (
  !afterTarget ||
  afterTarget.reconciled_at === null ||
  afterTarget.reconciliation_code !== pairingRepair.reconciliationCode ||
  afterTarget.business_committed !== 1 ||
  afterTarget.committed_d1_rows_read !== afterTarget.measured_d1_rows_read ||
  afterTarget.committed_d1_rows_written !== afterTarget.measured_d1_rows_written ||
  after.unresolved.some(
    (row) =>
      Number(row.reserved_count ?? 0) !== 0 || Number(row.unreconciled_failure_count ?? 0) !== 0,
  )
) {
  throw new Error('Repair batch nije sačuvao exact pairing-create reconciliation dokaz.');
}
const immutableRoute = ({ business_committed, reconciled_at, reconciliation_code, ...row }) => {
  void business_committed;
  void reconciled_at;
  void reconciliation_code;
  return row;
};
if (
  JSON.stringify(afterRequest) !== JSON.stringify(requestBefore) ||
  JSON.stringify(immutableRoute(afterTarget)) !== JSON.stringify(immutableRoute(routeBefore)) ||
  JSON.stringify(after.pairingBusinessEvidence) !==
    JSON.stringify(before.pairingBusinessEvidence) ||
  JSON.stringify(after.globalRolling) !== JSON.stringify(before.globalRolling) ||
  JSON.stringify(after.recentGlobalDaily) !== JSON.stringify(before.recentGlobalDaily) ||
  JSON.stringify(after.pairingTotals) !== JSON.stringify(before.pairingTotals)
) {
  throw new Error('Repair postcheck je otkrio promenu izvan tri dozvoljena reconciliation polja.');
}
if (!after.pairingTotals || after.pairingTotals.total_count !== after.pairingTotals.actual_count) {
  throw new Error('Repair postcheck je otkrio neusklađen pairing request counter.');
}
assertProjectedUsageBelowLimits({
  rolling: after.projectedGlobalRolling,
  daily: after.projectedGlobalDaily,
  resources: after.resources[0],
  budgets: BUDGETS,
});
const afterPath = writeEvidence('post-repair', after);
process.stdout.write(
  `${JSON.stringify(
    {
      changed: true,
      requestId,
      beforeEvidence: backupPath,
      afterEvidence: afterPath,
      reconciledReservations: 1,
      serviceFlags: afterFlags,
      globalRolling: after.globalRolling[0] ?? null,
    },
    null,
    2,
  )}\n`,
);
