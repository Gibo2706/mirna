export const REQUIRED_ACCOUNTING_COLUMNS = Object.freeze({
  usage_reservations: Object.freeze([
    'reservation_id',
    'measurement_exact',
    'measured_worker_requests',
    'measured_d1_rows_read',
    'measured_d1_rows_written',
    'measured_r2_class_a',
    'measured_r2_class_b',
    'settlement_failure_code',
    'business_committed',
    'reconciled_at',
    'reconciliation_code',
  ]),
  service_flags: Object.freeze([
    'singleton_id',
    'accept_new_vaults',
    'accept_pairings',
    'accept_writes',
    'maintenance_mode',
    'accounting_fault',
    'state_reason',
    'state_request_id',
    'accounting_fault_at',
  ]),
  usage_daily_buckets: Object.freeze([
    'scope_type',
    'scope_id',
    'utc_day',
    'worker_requests',
    'd1_rows_read',
    'd1_rows_written',
    'r2_class_a',
    'r2_class_b',
  ]),
  usage_rolling_totals: Object.freeze([
    'scope_type',
    'scope_id',
    'worker_requests',
    'd1_rows_read',
    'd1_rows_written',
    'r2_class_a',
    'r2_class_b',
  ]),
  resource_totals: Object.freeze([
    'singleton_id',
    'r2_stored_bytes',
    'r2_object_count',
    'd1_storage_bytes',
  ]),
  pairing_request_totals: Object.freeze(['singleton_id', 'total_count', 'updated_at']),
});

export const STAGING_VERIFY_LIMITS = Object.freeze({
  rolling: Object.freeze({
    worker_requests: 1_500_000,
    d1_rows_read: 25_000_000,
    d1_rows_written: 500_000,
    r2_class_a: 400_000,
    r2_class_b: 4_000_000,
  }),
  daily: Object.freeze({
    worker_requests: 50_000,
    d1_rows_read: 2_000_000,
    d1_rows_written: 40_000,
    r2_class_a: 20_000,
    r2_class_b: 200_000,
  }),
  d1StorageBytes: 256 * 1_024 * 1_024,
  r2StoredBytes: 4 * 1_024 * 1_024 * 1_024,
  r2ObjectCount: 100_000,
});

const isNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

const verifyUsage = (errors, label, usage, limits) => {
  if (!usage) {
    errors.push(`${label}: required row missing`);
    return;
  }
  for (const [field, limit] of Object.entries(limits)) {
    if (!isNonNegativeInteger(usage[field])) errors.push(`${label}.${field}: invalid`);
    else if (usage[field] >= limit) errors.push(`${label}.${field}: hard limit reached`);
  }
};

export const verifyStagingSnapshot = (
  snapshot,
  expectedMigrations,
  expectedBuild,
  expectedRegistryVersion,
) => {
  const errors = [];
  const applied = new Set(snapshot.migrations ?? []);
  const expected = new Set(expectedMigrations);
  for (const migration of expected) {
    if (!applied.has(migration)) errors.push(`migration missing: ${migration}`);
  }
  for (const migration of applied) {
    if (!expected.has(migration)) errors.push(`unexpected migration: ${migration}`);
  }

  for (const [table, requiredColumns] of Object.entries(REQUIRED_ACCOUNTING_COLUMNS)) {
    const actual = new Set(snapshot.columns?.[table] ?? []);
    for (const column of requiredColumns) {
      if (!actual.has(column)) errors.push(`${table}.${column}: missing`);
    }
  }
  if (!(snapshot.indexes ?? []).includes('idx_usage_reservations_failure')) {
    errors.push('idx_usage_reservations_failure: missing');
  }
  if (
    JSON.stringify(snapshot.failureIndexColumns ?? []) !==
    JSON.stringify(['settlement_failure_code', 'created_at'])
  ) {
    errors.push('idx_usage_reservations_failure: invalid columns');
  }

  const flags = snapshot.flags;
  if (!flags || flags.row_count !== 1) errors.push('service_flags: singleton missing');
  else if (
    flags.accept_new_vaults !== 1 ||
    flags.accept_pairings !== 1 ||
    flags.accept_writes !== 1 ||
    flags.maintenance_mode !== 0 ||
    flags.accounting_fault !== 0 ||
    flags.state_reason !== 'NONE'
  ) {
    errors.push('service_flags: accounting state not ready');
  }

  const resources = snapshot.resources;
  if (!resources || resources.row_count !== 1) errors.push('resource_totals: singleton missing');
  else {
    for (const field of ['r2_stored_bytes', 'r2_object_count', 'd1_storage_bytes']) {
      if (!isNonNegativeInteger(resources[field])) errors.push(`resource_totals.${field}: invalid`);
    }
    if (resources.d1_storage_bytes >= STAGING_VERIFY_LIMITS.d1StorageBytes) {
      errors.push('resource_totals.d1_storage_bytes: hard limit reached');
    }
  }

  const pairingTotals = snapshot.pairingTotals;
  if (!pairingTotals || pairingTotals.row_count !== 1) {
    errors.push('pairing_request_totals: singleton missing');
  } else if (
    !isNonNegativeInteger(pairingTotals.total_count) ||
    !isNonNegativeInteger(pairingTotals.actual_count) ||
    pairingTotals.total_count !== pairingTotals.actual_count
  ) {
    errors.push('pairing_request_totals: counter mismatch');
  }

  verifyUsage(errors, 'global rolling', snapshot.rolling, STAGING_VERIFY_LIMITS.rolling);
  verifyUsage(errors, 'current daily', snapshot.daily, STAGING_VERIFY_LIMITS.daily);

  if (
    !snapshot.unresolved ||
    snapshot.unresolved.reserved_count !== 0 ||
    snapshot.unresolved.unreconciled_failure_count !== 0
  ) {
    errors.push('usage_reservations: unresolved accounting evidence');
  }

  if (!snapshot.r2?.readable) errors.push('R2: inventory unreadable');
  else {
    if (!isNonNegativeInteger(snapshot.r2.objectCount)) errors.push('R2: invalid object count');
    if (!isNonNegativeInteger(snapshot.r2.bytes)) errors.push('R2: invalid storage size');
    if (snapshot.r2.objectCount >= STAGING_VERIFY_LIMITS.r2ObjectCount) {
      errors.push('R2: object hard limit reached');
    }
    if (snapshot.r2.bytes >= STAGING_VERIFY_LIMITS.r2StoredBytes) {
      errors.push('R2: storage hard limit reached');
    }
    if (
      resources &&
      snapshot.r2.exactBytes !== false &&
      (snapshot.r2.objectCount !== resources.r2_object_count ||
        snapshot.r2.bytes !== resources.r2_stored_bytes)
    ) {
      errors.push('R2: inventory does not match accounting totals');
    }
  }

  const health = snapshot.health;
  if (!health || health.buildCommit !== expectedBuild) errors.push('Worker: build mismatch');
  if (snapshot.healthHttpStatus !== undefined && snapshot.healthHttpStatus !== 200) {
    errors.push('Worker: health HTTP status is not ready');
  }
  if (health?.status !== 'ok') errors.push('Worker: health status is not ready');
  if (!health || health.services?.d1 !== 'ok' || health.services?.r2 !== 'ok') {
    errors.push('Worker: storage reachability failed');
  }
  if (!health?.readiness) {
    errors.push('Worker: accounting readiness missing');
  } else if (
    health.readiness.storage !== 'ok' ||
    health.readiness.accountingSchema !== 'ok' ||
    health.readiness.accountingState !== 'ok' ||
    health.readiness.routeBudgetConformance !== 'ok' ||
    (expectedRegistryVersion !== undefined &&
      health.readiness.routeBudgetRegistryVersion !== expectedRegistryVersion) ||
    health.readiness.writes !== 'enabled'
  ) {
    errors.push('Worker: accounting readiness failed');
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
};
