import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  assertPairingRepairPostconditions,
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
const SCHEDULED_CLEANUP_SUFFIX = ':scheduled-cleanup';
const SCHEDULED_CLEANUP_RECONCILIATION_CODE = 'SCHEDULED_CLEANUP_ESTIMATE_REPAIRED';
const USAGE_SUFFIXES = Object.freeze([
  'worker_requests',
  'd1_rows_read',
  'd1_rows_written',
  'r2_class_a',
  'r2_class_b',
]);

const BUDGETS = Object.freeze({
  worker_requests: 1_500_000,
  d1_rows_read: 25_000_000,
  d1_rows_written: 500_000,
  r2_class_a: 400_000,
  r2_class_b: 4_000_000,
  worker_requests_daily: 50_000,
  d1_rows_read_daily: 2_000_000,
  d1_rows_written_daily: 80_000,
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
  if (['--apply', '--business-committed', '--current'].includes(key)) {
    switches.add(key);
    continue;
  }
  const value = rawArguments[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Nedostaje vrednost za ${key}.`);
  }
  options.set(key, value);
  index += 1;
}

if ((options.get('--env') ?? 'staging') !== 'staging') {
  throw new Error('Ovaj alat odbija sva okruženja osim eksplicitnog staging okruženja.');
}

const operation = options.get('--operation');
const useCurrentIncident = switches.has('--current');
let requestId = options.get('--request') ?? null;

if (useCurrentIncident && requestId !== null) {
  throw new Error('Koristite ili --current ili --request, ne oba.');
}
if (useCurrentIncident && operation !== 'scheduled-cleanup') {
  throw new Error('--current je trenutno dozvoljen samo za scheduled-cleanup repair.');
}
if (requestId !== null && !REQUEST_ID.test(requestId)) {
  throw new Error('Request ID nije ispravan.');
}
if (mode === 'repair' && requestId === null && !useCurrentIncident) {
  throw new Error('Repair zahteva --request ili bezbedni --current režim.');
}
if (mode === 'repair' && !switches.has('--apply')) {
  throw new Error('Repair je odbijen bez eksplicitnog --apply parametra.');
}

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
const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`;
const numeric = (value, description) => {
  if (value === null || value === undefined || value === '') {
    throw new Error(`Repair je odbijen: ${description} nedostaje.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Repair je odbijen: ${description} nije nenegativan ceo broj.`);
  }
  return parsed;
};

const validateExactCleanupAccounting = (reservation) => {
  const exactFields = {};
  let hasUnderestimation = false;

  for (const suffix of USAGE_SUFFIXES) {
    const reservedField = `reserved_${suffix}`;
    const measuredField = `measured_${suffix}`;
    const committedField = `committed_${suffix}`;
    const releasedField = `released_${suffix}`;

    const reserved = numeric(
      reservation[reservedField],
      `${reservation.reservation_id}.${reservedField}`,
    );
    const measured = numeric(
      reservation[measuredField],
      `${reservation.reservation_id}.${measuredField}`,
    );
    const committed = numeric(
      reservation[committedField],
      `${reservation.reservation_id}.${committedField}`,
    );
    const released = numeric(
      reservation[releasedField],
      `${reservation.reservation_id}.${releasedField}`,
    );

    if (committed !== measured) {
      throw new Error(
        `Repair je odbijen: ${reservation.reservation_id}.${committedField} nije jednak exact measured rezultatu.`,
      );
    }

    const expectedReleased = Math.max(reserved - measured, 0);
    if (released !== expectedReleased) {
      throw new Error(
        `Repair je odbijen: ${reservation.reservation_id}.${releasedField} nije jednak neiskorišćenoj rezervaciji.`,
      );
    }

    if (measured > reserved) hasUnderestimation = true;

    exactFields[reservedField] = reserved;
    exactFields[measuredField] = measured;
    exactFields[committedField] = committed;
    exactFields[releasedField] = released;
  }

  if (!hasUnderestimation) {
    throw new Error(
      `Repair je odbijen: ${reservation.reservation_id} nema nijednu stvarno potcenjenu metriku.`,
    );
  }

  return exactFields;
};

const validateScheduledCleanupReservation = (reservation) => {
  const reservationId = String(reservation?.reservation_id ?? '');
  if (!reservationId.endsWith(SCHEDULED_CLEANUP_SUFFIX)) {
    throw new Error(
      `Repair je odbijen: ${reservationId || 'nepoznata rezervacija'} nema cleanup sufiks.`,
    );
  }

  const incidentRequestId = reservationId.slice(0, -SCHEDULED_CLEANUP_SUFFIX.length);
  if (!REQUEST_ID.test(incidentRequestId)) {
    throw new Error(`Repair je odbijen: ${reservationId} nema validan Request ID.`);
  }

  if (
    reservation.scope_type !== 'global' ||
    reservation.scope_id !== 'service' ||
    reservation.route_key !== 'scheduled-cleanup' ||
    reservation.state !== 'committed' ||
    Number(reservation.measurement_exact) !== 1 ||
    reservation.settlement_failure_code !== 'USAGE_RESERVATION_UNDERESTIMATED' ||
    Number(reservation.business_committed) !== 0
  ) {
    throw new Error(`Repair je odbijen: ${reservationId} nema očekivanu cleanup strukturu.`);
  }

  const createdAt = numeric(reservation.created_at, `${reservationId}.created_at`);
  const settledAt = numeric(reservation.settled_at, `${reservationId}.settled_at`);
  if (settledAt < createdAt) {
    throw new Error(`Repair je odbijen: ${reservationId}.settled_at prethodi created_at.`);
  }

  const exactFields = validateExactCleanupAccounting(reservation);
  const reconciledAt = reservation.reconciled_at;
  const reconciliationCode = reservation.reconciliation_code;
  const isReconciled = reconciledAt !== null && reconciledAt !== undefined;

  if (isReconciled && reconciliationCode !== SCHEDULED_CLEANUP_RECONCILIATION_CODE) {
    throw new Error(`Repair je odbijen: ${reservationId} ima nepoznat reconciliation kod.`);
  }
  if (!isReconciled && reconciliationCode !== null) {
    throw new Error(`Repair je odbijen: ${reservationId} ima kod bez reconciled_at vrednosti.`);
  }

  return {
    requestId: incidentRequestId,
    reservationId,
    settledAt,
    reservationNeedsUpdate: !isReconciled,
    exactFields,
  };
};

const now = Date.now();
let currentCleanupReservationIds = [];
let activeCleanupFault = null;

if (useCurrentIncident) {
  const flagRows = query(
    `SELECT accept_new_vaults, accept_pairings, accept_writes, maintenance_mode,
            accounting_fault, state_reason, state_request_id, accounting_fault_at, updated_at
       FROM service_flags
      WHERE singleton_id = 1`,
  );

  if (flagRows.length !== 1) {
    throw new Error(
      `Repair je odbijen: service_flags singleton nije jedinstven. rows=${flagRows.length}`,
    );
  }

  const unresolvedRows = query(
    `SELECT reservation_id, route_key, settlement_failure_code, business_committed,
            state, measurement_exact, reconciled_at
       FROM usage_reservations
      WHERE settlement_failure_code IS NOT NULL
        AND reconciled_at IS NULL
      ORDER BY created_at, reservation_id`,
  );

  if (unresolvedRows.length === 0) {
    throw new Error('Repair je odbijen: nema nerešenih accounting incidenata.');
  }

  const unsupportedRows = unresolvedRows.filter(
    (row) =>
      row.route_key !== 'scheduled-cleanup' ||
      row.settlement_failure_code !== 'USAGE_RESERVATION_UNDERESTIMATED' ||
      Number(row.business_committed) !== 0 ||
      row.state !== 'committed' ||
      Number(row.measurement_exact) !== 1 ||
      typeof row.reservation_id !== 'string' ||
      !row.reservation_id.endsWith(SCHEDULED_CLEANUP_SUFFIX),
  );

  if (unsupportedRows.length > 0) {
    throw new Error(
      `Repair je odbijen: postoje nerešeni incidenti koji nisu bezbedni scheduled-cleanup kandidati: ${JSON.stringify(
        unsupportedRows,
      )}`,
    );
  }

  currentCleanupReservationIds = unresolvedRows.map((row) => row.reservation_id);
  const currentRequestIds = currentCleanupReservationIds.map((reservationId) =>
    reservationId.slice(0, -SCHEDULED_CLEANUP_SUFFIX.length),
  );
  if (currentRequestIds.some((candidate) => !REQUEST_ID.test(candidate))) {
    throw new Error('Repair je odbijen: najmanje jedan cleanup incident nema validan Request ID.');
  }

  const flags = flagRows[0];
  const accountingFault = Number(flags.accounting_fault);
  const stateReason = String(flags.state_reason ?? '').trim();
  const stateRequestId = String(flags.state_request_id ?? '').trim();

  if (
    accountingFault !== 1 ||
    stateReason !== 'USAGE_RESERVATION_UNDERESTIMATED' ||
    !REQUEST_ID.test(stateRequestId) ||
    !currentRequestIds.includes(stateRequestId) ||
    Number(flags.accept_new_vaults) !== 1 ||
    Number(flags.accept_pairings) !== 1 ||
    Number(flags.accept_writes) !== 1 ||
    Number(flags.maintenance_mode) !== 0
  ) {
    throw new Error(
      `Repair je odbijen: service flags ne pripadaju skupu nerešenih cleanup incidenata. flags=${JSON.stringify(
        flags,
      )} requestIds=${JSON.stringify(currentRequestIds)}`,
    );
  }

  requestId = stateRequestId;
  activeCleanupFault = flags;
}

if (mode === 'repair' && requestId === null) {
  throw new Error('Repair nije uspeo da utvrdi tačan Request ID.');
}

const createdAfter = now - lookbackMs;
const requestPredicate =
  currentCleanupReservationIds.length > 0
    ? `reservation_id IN (${currentCleanupReservationIds.map(sqlText).join(', ')})`
    : requestId
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
    capturedAt: new Date().toISOString(),
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

if (mode === 'repair' && operation === 'scheduled-cleanup') {
  const targetRows = before.reservations.filter(
    (row) =>
      row.route_key === 'scheduled-cleanup' &&
      row.settlement_failure_code === 'USAGE_RESERVATION_UNDERESTIMATED',
  );

  if (targetRows.length === 0) {
    throw new Error('Repair je odbijen: scheduled-cleanup reservation nije pronađena.');
  }

  if (currentCleanupReservationIds.length > 0) {
    const foundIds = new Set(targetRows.map((row) => row.reservation_id));
    const missingIds = currentCleanupReservationIds.filter(
      (reservationId) => !foundIds.has(reservationId),
    );
    if (missingIds.length > 0 || targetRows.length !== currentCleanupReservationIds.length) {
      throw new Error(
        `Repair je odbijen: snapshot nerešenih cleanup incidenata se promenio. missing=${JSON.stringify(
          missingIds,
        )}`,
      );
    }
  }

  const repairs = targetRows.map(validateScheduledCleanupReservation);
  const repairRequestIds = repairs.map((repair) => repair.requestId);
  const beforeFlags = before.serviceFlags[0];
  if (!beforeFlags) throw new Error('Repair je odbijen: service flags nedostaju.');

  const activeRequestId = String(beforeFlags.state_request_id ?? '').trim();
  const activeRepair = repairs.find((repair) => repair.requestId === activeRequestId);
  if (
    Number(beforeFlags.accounting_fault) !== 1 ||
    beforeFlags.state_reason !== 'USAGE_RESERVATION_UNDERESTIMATED' ||
    !activeRepair ||
    Number(beforeFlags.accounting_fault_at) !== activeRepair.settledAt ||
    Number(beforeFlags.accept_new_vaults) !== 1 ||
    Number(beforeFlags.accept_pairings) !== 1 ||
    Number(beforeFlags.accept_writes) !== 1 ||
    Number(beforeFlags.maintenance_mode) !== 0
  ) {
    throw new Error(
      `Repair je odbijen: service flags ne pripadaju ciljnom cleanup skupu. flags=${JSON.stringify(
        beforeFlags,
      )} requestIds=${JSON.stringify(repairRequestIds)}`,
    );
  }

  if (!useCurrentIncident) {
    const outsideUnresolved = query(
      `SELECT reservation_id, route_key, settlement_failure_code
         FROM usage_reservations
        WHERE settlement_failure_code IS NOT NULL
          AND reconciled_at IS NULL
          AND reservation_id NOT IN (${repairs.map((repair) => sqlText(repair.reservationId)).join(', ')})`,
    );
    if (outsideUnresolved.length > 0) {
      throw new Error(
        `Repair je odbijen: postoje drugi nerešeni incidenti; koristite --current za bezbedan batch cleanup repair. incidents=${JSON.stringify(
          outsideUnresolved,
        )}`,
      );
    }
  }

  let changedReservationCount = 0;
  for (const repair of repairs) {
    if (!repair.reservationNeedsUpdate) continue;

    const exactAccountingPredicates = Object.entries(repair.exactFields)
      .map(([field, value]) => `AND ${field} = ${value}`)
      .join('\n          ');

    const reservationUpdate = wrangler(
      `UPDATE usage_reservations
          SET reconciled_at = ${now},
              reconciliation_code = ${sqlText(SCHEDULED_CLEANUP_RECONCILIATION_CODE)}
        WHERE reservation_id = ${sqlText(repair.reservationId)}
          AND scope_type = 'global'
          AND scope_id = 'service'
          AND route_key = 'scheduled-cleanup'
          AND state = 'committed'
          AND measurement_exact = 1
          AND settlement_failure_code = 'USAGE_RESERVATION_UNDERESTIMATED'
          AND business_committed = 0
          AND reconciled_at IS NULL
          AND reconciliation_code IS NULL
          AND created_at <= settled_at
          ${exactAccountingPredicates}`,
    );

    if (changedRows(reservationUpdate) !== 1) {
      throw new Error(
        `Repair je zaustavljen: cleanup CAS nije promenio tačno jedan red za ${repair.reservationId}. Bezbedno ponovite istu komandu.`,
      );
    }
    changedReservationCount += 1;
  }

  const afterReservations = snapshot();
  for (const repair of repairs) {
    const row = afterReservations.reservations.find(
      (candidate) => candidate.reservation_id === repair.reservationId,
    );
    if (
      !row ||
      row.reconciled_at === null ||
      row.reconciliation_code !== SCHEDULED_CLEANUP_RECONCILIATION_CODE ||
      Number(row.business_committed) !== 0
    ) {
      throw new Error(`Repair postcheck nije sačuvao exact dokaz za ${repair.reservationId}.`);
    }
  }

  const unresolvedAfterReservations = query(
    `SELECT reservation_id, route_key, settlement_failure_code
       FROM usage_reservations
      WHERE settlement_failure_code IS NOT NULL
        AND reconciled_at IS NULL
      ORDER BY created_at, reservation_id`,
  );
  const reservedAfterReservations = query(
    `SELECT reservation_id, route_key
       FROM usage_reservations
      WHERE state = 'reserved'
      ORDER BY created_at, reservation_id`,
  );

  if (unresolvedAfterReservations.length > 0 || reservedAfterReservations.length > 0) {
    const partialPath = writeEvidence('partial-repair', afterReservations);
    throw new Error(
      `Cleanup rezervacije su delimično reconciliovane, ali flags ostaju fail-closed jer postoje novi/drugi incidenti. evidence=${partialPath} unresolved=${JSON.stringify(
        unresolvedAfterReservations,
      )} reserved=${JSON.stringify(reservedAfterReservations)}`,
    );
  }

  const resources = afterReservations.resources[0];
  if (!resources) throw new Error('Repair je odbijen: resource totals nedostaju.');
  assertProjectedUsageBelowLimits({
    rolling: afterReservations.projectedGlobalRolling,
    daily: afterReservations.projectedGlobalDaily,
    resources,
    budgets: BUDGETS,
  });

  const flagUpdate = wrangler(
    `UPDATE service_flags
        SET accounting_fault = 0,
            state_reason = 'NONE',
            state_request_id = NULL,
            accounting_fault_at = NULL,
            updated_at = ${now}
      WHERE singleton_id = 1
        AND accounting_fault = 1
        AND state_reason = 'USAGE_RESERVATION_UNDERESTIMATED'
        AND state_request_id = ${sqlText(activeRequestId)}
        AND accounting_fault_at = ${activeRepair.settledAt}
        AND accept_new_vaults = 1
        AND accept_pairings = 1
        AND accept_writes = 1
        AND maintenance_mode = 0
        AND NOT EXISTS (SELECT 1 FROM usage_reservations WHERE state = 'reserved')
        AND NOT EXISTS (
          SELECT 1 FROM usage_reservations
           WHERE settlement_failure_code IS NOT NULL
             AND reconciled_at IS NULL
        )
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
        AND (SELECT d1_storage_bytes FROM resource_totals WHERE singleton_id = 1) < ${BUDGETS.d1_storage_bytes}`,
  );

  if (changedRows(flagUpdate) !== 1) {
    throw new Error(
      'Cleanup rezervacije su reconciliovane, ali service flags CAS nije promenio tačno jedan red. Servis ostaje fail-closed; bezbedno ponovite istu komandu.',
    );
  }

  const after = snapshot();
  const afterFlags = after.serviceFlags[0];
  const unresolvedFailures = query(
    `SELECT COUNT(*) AS count FROM usage_reservations
      WHERE settlement_failure_code IS NOT NULL AND reconciled_at IS NULL`,
  )[0]?.count;
  const reservedCount = query(
    `SELECT COUNT(*) AS count FROM usage_reservations WHERE state = 'reserved'`,
  )[0]?.count;

  if (
    !afterFlags ||
    Number(afterFlags.accounting_fault) !== 0 ||
    afterFlags.state_reason !== 'NONE' ||
    afterFlags.state_request_id !== null ||
    afterFlags.accounting_fault_at !== null ||
    Number(unresolvedFailures ?? -1) !== 0 ||
    Number(reservedCount ?? -1) !== 0
  ) {
    throw new Error('Repair batch nije bezbedno obnovio staging accounting stanje.');
  }

  const afterPath = writeEvidence('post-repair', after);
  process.stdout.write(
    `${JSON.stringify(
      {
        changed: changedReservationCount > 0,
        operation,
        activeRequestId,
        repairedRequestIds: repairRequestIds,
        beforeEvidence: backupPath,
        afterEvidence: afterPath,
        reconciledReservations: changedReservationCount,
        totalCleanupIncidents: repairs.length,
        unresolvedFailures: Number(unresolvedFailures ?? 0),
        serviceFlags: afterFlags,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

if (before.reservations.length === 0) {
  throw new Error('Za Request ID ne postoje accounting rezervacije.');
}
const isPairingCreateIncident = before.reservations.some(
  (row) => row.route_key === 'pairing-create',
);
if (!isPairingCreateIncident || operation !== 'pairing-create') {
  throw new Error(
    'Repair je ograničen na pairing-create ili scheduled-cleanup sa odgovarajućim --operation.',
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

const pairingRepair = validatePairingCreateRepair({
  requestId,
  pairingRequestId,
  reservations: before.reservations,
  serviceFlags: flags,
  pairingEvidence: before.pairingBusinessEvidence,
});

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
  after.unresolved.some(
    (row) =>
      Number(row.reserved_count ?? 0) !== 0 || Number(row.unreconciled_failure_count ?? 0) !== 0,
  )
) {
  throw new Error('Repair batch nije sačuvao exact pairing-create reconciliation dokaz.');
}
assertPairingRepairPostconditions({
  beforeRequest: requestBefore,
  afterRequest,
  beforeRoute: routeBefore,
  afterRoute: afterTarget,
  beforePairingEvidence: before.pairingBusinessEvidence,
  afterPairingEvidence: after.pairingBusinessEvidence,
  afterPairingTotals: after.pairingTotals,
  reconciliationCode: pairingRepair.reconciliationCode,
});
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
