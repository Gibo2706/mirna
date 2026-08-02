import { describe, expect, it } from 'vitest';
import {
  assertPairingRepairPostconditions,
  assertProjectedUsageBelowLimits,
  validatePairingCreateRepair,
} from './sync-budget-repair-contract.mjs';

const requestId = 'b3cf7d0d-4e88-47d2-b85b-45a45de02a0a';
const pairingRequestId = 'A'.repeat(22);
const requestReservation = {
  reservation_id: `${requestId}:request`,
  scope_type: 'global',
  scope_id: 'service',
  route_key: 'request-ledger-overhead',
  state: 'committed',
  settlement_failure_code: null,
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
};
const routeReservation = {
  reservation_id: `${requestId}:route`,
  scope_type: 'global',
  scope_id: 'service',
  route_key: 'pairing-create',
  state: 'committed',
  measurement_exact: 1,
  settlement_failure_code: 'USAGE_RESERVATION_UNDERESTIMATED',
  reserved_worker_requests: 0,
  measured_worker_requests: 0,
  reserved_d1_rows_read: 512,
  measured_d1_rows_read: 55,
  reserved_d1_rows_written: 16,
  measured_d1_rows_written: 19,
  reserved_r2_class_a: 0,
  measured_r2_class_a: 0,
  reserved_r2_class_b: 0,
  measured_r2_class_b: 0,
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
  business_committed: 0,
  reconciled_at: null,
  reconciliation_code: null,
  created_at: 1_000,
  settled_at: 2_000,
};
const serviceFlags = {
  accounting_fault: 1,
  state_reason: 'USAGE_RESERVATION_UNDERESTIMATED',
  state_request_id: requestId,
  accept_new_vaults: 1,
  accept_pairings: 1,
  accept_writes: 1,
  maintenance_mode: 0,
  accounting_fault_at: 2_000,
  updated_at: 2_000,
};
const pairingEvidence = {
  pairing_request_id: pairingRequestId,
  status: 'pending',
  vault_assigned: 0,
  finalized_at: null,
  cancelled_at: null,
  has_finalization_hash: 0,
  envelope_count: 0,
  device_count: 0,
  grant_count: 0,
  interval_candidate_count: 1,
  created_at: 1_500,
};

describe('pairing-create accounting repair contract', () => {
  it('derives the business commit from exact isolated durable evidence', () => {
    expect(
      validatePairingCreateRepair({
        requestId,
        pairingRequestId,
        reservations: [requestReservation, routeReservation],
        serviceFlags,
        pairingEvidence,
      }),
    ).toEqual({
      reservationId: `${requestId}:route`,
      reconciliationCode: 'PAIRING_CREATE_EXACT_RECONCILIATION',
      businessCommitted: 1,
      reservationNeedsUpdate: true,
      faultTimestamp: 2_000,
    });
  });

  it.each([
    [
      'a different fault origin',
      { serviceFlags: { ...serviceFlags, state_request_id: crypto.randomUUID() } },
    ],
    ['a missing committed row', { pairingEvidence: undefined }],
    ['a finalized side effect', { pairingEvidence: { ...pairingEvidence, status: 'finalized' } }],
    [
      'a non-exact measurement',
      { routeReservation: { ...routeReservation, measurement_exact: 0 } },
    ],
    [
      'a committed/measured mismatch',
      { routeReservation: { ...routeReservation, committed_d1_rows_written: 18 } },
    ],
    [
      'a released-usage mismatch',
      { routeReservation: { ...routeReservation, released_d1_rows_read: 456 } },
    ],
    ['a different fault timestamp', { serviceFlags: { ...serviceFlags, updated_at: 2_001 } }],
    [
      'multiple business rows in the interval',
      { pairingEvidence: { ...pairingEvidence, interval_candidate_count: 2 } },
    ],
    [
      'a row outside the request interval',
      { pairingEvidence: { ...pairingEvidence, created_at: 2_001 } },
    ],
  ])('rejects %s', (_description, override) => {
    expect(() =>
      validatePairingCreateRepair({
        requestId,
        pairingRequestId,
        reservations: [requestReservation, override.routeReservation ?? routeReservation],
        serviceFlags: override.serviceFlags ?? serviceFlags,
        pairingEvidence: 'pairingEvidence' in override ? override.pairingEvidence : pairingEvidence,
      }),
    ).toThrow(/Repair je odbijen/u);
  });

  it('accepts the fail-closed partial state so a retry can finish the flags CAS', () => {
    expect(
      validatePairingCreateRepair({
        requestId,
        pairingRequestId,
        reservations: [
          requestReservation,
          {
            ...routeReservation,
            business_committed: 1,
            reconciled_at: 3_000,
            reconciliation_code: 'PAIRING_CREATE_EXACT_RECONCILIATION',
          },
        ],
        serviceFlags,
        pairingEvidence,
      }).reservationNeedsUpdate,
    ).toBe(false);
  });

  it('checks projected rebuilt totals, not just the current counters', () => {
    const budgets = {
      worker_requests: 10,
      d1_rows_read: 10,
      d1_rows_written: 10,
      r2_class_a: 10,
      r2_class_b: 10,
      worker_requests_daily: 10,
      d1_rows_read_daily: 10,
      d1_rows_written_daily: 10,
      r2_class_a_daily: 10,
      r2_class_b_daily: 10,
      d1_storage_bytes: 10,
    };
    const safe = {
      worker_requests: 1,
      d1_rows_read: 1,
      d1_rows_written: 1,
      r2_class_a: 1,
      r2_class_b: 1,
    };
    expect(() =>
      assertProjectedUsageBelowLimits({
        rolling: safe,
        daily: safe,
        resources: { d1_storage_bytes: 1 },
        budgets,
      }),
    ).not.toThrow();
    expect(() =>
      assertProjectedUsageBelowLimits({
        rolling: { ...safe, d1_rows_written: 10 },
        daily: safe,
        resources: { d1_storage_bytes: 1 },
        budgets,
      }),
    ).toThrow(/projektovani hard limit/u);
  });

  it('keeps the incident immutable while allowing unrelated live aggregate advancement', () => {
    const reconciledRoute = {
      ...routeReservation,
      business_committed: 1,
      reconciled_at: 3_000,
      reconciliation_code: 'PAIRING_CREATE_EXACT_RECONCILIATION',
    };
    expect(() =>
      assertPairingRepairPostconditions({
        beforeRequest: requestReservation,
        afterRequest: { ...requestReservation },
        beforeRoute: routeReservation,
        afterRoute: reconciledRoute,
        beforePairingEvidence: pairingEvidence,
        afterPairingEvidence: { ...pairingEvidence },
        afterPairingTotals: { total_count: 2, actual_count: 2, updated_at: 4_000 },
        reconciliationCode: 'PAIRING_CREATE_EXACT_RECONCILIATION',
      }),
    ).not.toThrow();
  });

  it('rejects any target change outside the exact reconciliation fields', () => {
    expect(() =>
      assertPairingRepairPostconditions({
        beforeRequest: requestReservation,
        afterRequest: { ...requestReservation, committed_d1_rows_read: 129 },
        beforeRoute: routeReservation,
        afterRoute: {
          ...routeReservation,
          business_committed: 1,
          reconciled_at: 3_000,
          reconciliation_code: 'PAIRING_CREATE_EXACT_RECONCILIATION',
        },
        beforePairingEvidence: pairingEvidence,
        afterPairingEvidence: pairingEvidence,
        afterPairingTotals: { total_count: 1, actual_count: 1 },
        reconciliationCode: 'PAIRING_CREATE_EXACT_RECONCILIATION',
      }),
    ).toThrow(/ciljnog incidenta/u);
  });
});
