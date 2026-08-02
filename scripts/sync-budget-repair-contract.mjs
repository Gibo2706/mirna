const PAIRING_REQUEST_ID = /^[A-Za-z0-9_-]{22}$/u;

const numeric = (value, description) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Repair je odbijen: ${description} nije nenegativan ceo broj.`);
  }
  return parsed;
};

const exactReservation = (reservations, reservationId) => {
  const matches = reservations.filter((row) => row.reservation_id === reservationId);
  if (matches.length !== 1) {
    throw new Error(`Repair je odbijen: očekivana rezervacija ${reservationId} nije jedinstvena.`);
  }
  return matches[0];
};

const assertExactFields = (row, expected, description) => {
  for (const [field, value] of Object.entries(expected)) {
    if (row[field] !== value) {
      throw new Error(`Repair je odbijen: ${description}.${field} ne odgovara incident dokazu.`);
    }
  }
};

export const assertPairingRequestId = (value) => {
  if (!PAIRING_REQUEST_ID.test(value ?? '')) {
    throw new Error('Pairing Request ID nije tačan 22-karakterni opaque ID.');
  }
  return value;
};

export const validatePairingCreateRepair = ({
  requestId,
  pairingRequestId,
  reservations,
  serviceFlags,
  pairingEvidence,
}) => {
  assertPairingRequestId(pairingRequestId);
  if (reservations.length !== 2) {
    throw new Error(
      'Repair je odbijen: pairing-create mora imati tačno request i route rezervaciju.',
    );
  }
  const requestReservation = exactReservation(reservations, `${requestId}:request`);
  const routeReservation = exactReservation(reservations, `${requestId}:route`);
  if (
    requestReservation.scope_type !== 'global' ||
    requestReservation.scope_id !== 'service' ||
    requestReservation.route_key !== 'request-ledger-overhead' ||
    requestReservation.state !== 'committed' ||
    requestReservation.settlement_failure_code !== null
  ) {
    throw new Error('Repair je odbijen: request-ledger rezervacija nije uspešno završena.');
  }
  assertExactFields(
    requestReservation,
    {
      reserved_worker_requests: 1,
      reserved_d1_rows_read: 128,
      reserved_d1_rows_written: 32,
      reserved_r2_class_a: 0,
      reserved_r2_class_b: 0,
      committed_worker_requests: 1,
      committed_d1_rows_read: 128,
      committed_d1_rows_written: 32,
      committed_r2_class_a: 0,
      committed_r2_class_b: 0,
      released_worker_requests: 0,
      released_d1_rows_read: 0,
      released_d1_rows_written: 0,
      released_r2_class_a: 0,
      released_r2_class_b: 0,
      measurement_exact: 0,
      measured_worker_requests: 1,
      measured_d1_rows_read: 128,
      measured_d1_rows_written: 32,
      measured_r2_class_a: 0,
      measured_r2_class_b: 0,
      business_committed: 0,
      reconciled_at: null,
      reconciliation_code: null,
    },
    'request reservation',
  );
  if (
    routeReservation.scope_type !== 'global' ||
    routeReservation.scope_id !== 'service' ||
    routeReservation.route_key !== 'pairing-create' ||
    routeReservation.state !== 'committed' ||
    routeReservation.measurement_exact !== 1 ||
    routeReservation.settlement_failure_code !== 'USAGE_RESERVATION_UNDERESTIMATED'
  ) {
    throw new Error(
      'Repair je odbijen: route rezervacija nije exact pairing-create underestimation.',
    );
  }
  assertExactFields(
    routeReservation,
    {
      reserved_worker_requests: 0,
      reserved_d1_rows_read: 512,
      reserved_d1_rows_written: 16,
      reserved_r2_class_a: 0,
      reserved_r2_class_b: 0,
      committed_worker_requests: 0,
      committed_d1_rows_read: 55,
      committed_d1_rows_written: 19,
      committed_r2_class_a: 0,
      committed_r2_class_b: 0,
      released_worker_requests: 0,
      released_d1_rows_read: 457,
      released_d1_rows_written: 0,
      released_r2_class_a: 0,
      released_r2_class_b: 0,
      measured_worker_requests: 0,
      measured_d1_rows_read: 55,
      measured_d1_rows_written: 19,
      measured_r2_class_a: 0,
      measured_r2_class_b: 0,
    },
    'pairing-create reservation',
  );
  const unreconciledState =
    routeReservation.business_committed === 0 &&
    routeReservation.reconciled_at === null &&
    routeReservation.reconciliation_code === null;
  const partialRepairState =
    routeReservation.business_committed === 1 &&
    routeReservation.reconciled_at !== null &&
    routeReservation.reconciliation_code === 'PAIRING_CREATE_EXACT_RECONCILIATION';
  if (!unreconciledState && !partialRepairState) {
    throw new Error('Repair je odbijen: pairing-create reconciliation stanje nije dozvoljeno.');
  }
  if (
    !serviceFlags ||
    serviceFlags.accounting_fault !== 1 ||
    serviceFlags.state_reason !== 'USAGE_RESERVATION_UNDERESTIMATED' ||
    serviceFlags.state_request_id !== requestId ||
    serviceFlags.accept_new_vaults !== 1 ||
    serviceFlags.accept_pairings !== 1 ||
    serviceFlags.accept_writes !== 1 ||
    serviceFlags.maintenance_mode !== 0
  ) {
    throw new Error('Repair je odbijen: service flags ne pripadaju tačno ovom incidentu.');
  }
  if (!pairingEvidence || pairingEvidence.pairing_request_id !== pairingRequestId) {
    throw new Error('Repair je odbijen: tačan pairing business red nije pronađen.');
  }
  if (
    pairingEvidence.status !== 'pending' ||
    pairingEvidence.vault_assigned !== 0 ||
    pairingEvidence.finalized_at !== null ||
    pairingEvidence.cancelled_at !== null ||
    pairingEvidence.has_finalization_hash !== 0 ||
    numeric(pairingEvidence.envelope_count, 'pairing envelope count') !== 0 ||
    numeric(pairingEvidence.device_count, 'new device count') !== 0 ||
    numeric(pairingEvidence.grant_count, 'new device grant count') !== 0
  ) {
    throw new Error(
      'Repair je odbijen: business stanje nije izolovani pending pairing-create commit.',
    );
  }
  const businessCreatedAt = numeric(pairingEvidence.created_at, 'pairing created_at');
  const routeCreatedAt = numeric(routeReservation.created_at, 'route reservation created_at');
  const routeSettledAt = numeric(routeReservation.settled_at, 'route reservation settled_at');
  if (businessCreatedAt < routeCreatedAt || businessCreatedAt > routeSettledAt) {
    throw new Error('Repair je odbijen: pairing red nije nastao unutar tačnog route intervala.');
  }
  if (
    numeric(serviceFlags.accounting_fault_at, 'accounting fault timestamp') !== routeSettledAt ||
    numeric(serviceFlags.updated_at, 'service flags updated_at') !== routeSettledAt ||
    numeric(pairingEvidence.interval_candidate_count, 'pairing interval candidate count') !== 1
  ) {
    throw new Error('Repair je odbijen: origin timestamp ili business interval nije jedinstven.');
  }

  return {
    reservationId: routeReservation.reservation_id,
    reconciliationCode: 'PAIRING_CREATE_EXACT_RECONCILIATION',
    businessCommitted: 1,
    reservationNeedsUpdate: unreconciledState,
    faultTimestamp: routeSettledAt,
  };
};

export const assertProjectedUsageBelowLimits = ({ rolling, daily, resources, budgets }) => {
  if (!rolling || !daily || !resources) {
    throw new Error('Repair je odbijen: projektovano accounting stanje nije potpuno.');
  }
  const checks = [
    [rolling, 'worker_requests', budgets.worker_requests],
    [rolling, 'd1_rows_read', budgets.d1_rows_read],
    [rolling, 'd1_rows_written', budgets.d1_rows_written],
    [rolling, 'r2_class_a', budgets.r2_class_a],
    [rolling, 'r2_class_b', budgets.r2_class_b],
    [daily, 'worker_requests', budgets.worker_requests_daily],
    [daily, 'd1_rows_read', budgets.d1_rows_read_daily],
    [daily, 'd1_rows_written', budgets.d1_rows_written_daily],
    [daily, 'r2_class_a', budgets.r2_class_a_daily],
    [daily, 'r2_class_b', budgets.r2_class_b_daily],
    [resources, 'd1_storage_bytes', budgets.d1_storage_bytes],
  ];
  if (checks.some(([row, field, limit]) => numeric(row[field], field) >= limit)) {
    throw new Error('Repair je odbijen: najmanje jedan projektovani hard limit nije bezbedan.');
  }
};

const withoutReconciliationFields = ({
  business_committed,
  reconciled_at,
  reconciliation_code,
  ...row
}) => {
  void business_committed;
  void reconciled_at;
  void reconciliation_code;
  return row;
};

export const assertPairingRepairPostconditions = ({
  beforeRequest,
  afterRequest,
  beforeRoute,
  afterRoute,
  beforePairingEvidence,
  afterPairingEvidence,
  afterPairingTotals,
  reconciliationCode,
}) => {
  if (
    !afterRoute ||
    afterRoute.reconciled_at === null ||
    afterRoute.reconciliation_code !== reconciliationCode ||
    afterRoute.business_committed !== 1 ||
    afterRoute.committed_d1_rows_read !== afterRoute.measured_d1_rows_read ||
    afterRoute.committed_d1_rows_written !== afterRoute.measured_d1_rows_written
  ) {
    throw new Error('Repair postcheck nije sačuvao exact pairing-create reconciliation dokaz.');
  }
  if (
    JSON.stringify(afterRequest) !== JSON.stringify(beforeRequest) ||
    JSON.stringify(withoutReconciliationFields(afterRoute)) !==
      JSON.stringify(withoutReconciliationFields(beforeRoute)) ||
    JSON.stringify(afterPairingEvidence) !== JSON.stringify(beforePairingEvidence)
  ) {
    throw new Error(
      'Repair postcheck je otkrio promenu ciljnog incidenta izvan dozvoljenog CAS-a.',
    );
  }
  if (!afterPairingTotals || afterPairingTotals.total_count !== afterPairingTotals.actual_count) {
    throw new Error('Repair postcheck je otkrio neusklađen pairing request counter.');
  }
};
