-- Recoverable staging accounting faults and durable evidence for settlement.
-- Values remain privacy-safe: no request bodies, financial data, keys or tokens.

ALTER TABLE usage_reservations ADD COLUMN measurement_exact INTEGER NOT NULL DEFAULT 0
  CHECK (measurement_exact IN (0, 1));
ALTER TABLE usage_reservations ADD COLUMN measured_worker_requests INTEGER NOT NULL DEFAULT 0
  CHECK (measured_worker_requests >= 0);
ALTER TABLE usage_reservations ADD COLUMN measured_d1_rows_read INTEGER NOT NULL DEFAULT 0
  CHECK (measured_d1_rows_read >= 0);
ALTER TABLE usage_reservations ADD COLUMN measured_d1_rows_written INTEGER NOT NULL DEFAULT 0
  CHECK (measured_d1_rows_written >= 0);
ALTER TABLE usage_reservations ADD COLUMN measured_r2_class_a INTEGER NOT NULL DEFAULT 0
  CHECK (measured_r2_class_a >= 0);
ALTER TABLE usage_reservations ADD COLUMN measured_r2_class_b INTEGER NOT NULL DEFAULT 0
  CHECK (measured_r2_class_b >= 0);
ALTER TABLE usage_reservations ADD COLUMN settlement_failure_code TEXT
  CHECK (
    settlement_failure_code IS NULL
    OR length(settlement_failure_code) BETWEEN 3 AND 64
  );
ALTER TABLE usage_reservations ADD COLUMN business_committed INTEGER NOT NULL DEFAULT 0
  CHECK (business_committed IN (0, 1));
ALTER TABLE usage_reservations ADD COLUMN reconciled_at INTEGER
  CHECK (reconciled_at IS NULL OR reconciled_at >= 0);
ALTER TABLE usage_reservations ADD COLUMN reconciliation_code TEXT
  CHECK (reconciliation_code IS NULL OR length(reconciliation_code) BETWEEN 3 AND 64);

ALTER TABLE service_flags ADD COLUMN accounting_fault INTEGER NOT NULL DEFAULT 0
  CHECK (accounting_fault IN (0, 1));
ALTER TABLE service_flags ADD COLUMN state_reason TEXT NOT NULL DEFAULT 'NONE'
  CHECK (length(state_reason) BETWEEN 3 AND 64);
ALTER TABLE service_flags ADD COLUMN state_request_id TEXT
  CHECK (state_request_id IS NULL OR length(state_request_id) = 36);
ALTER TABLE service_flags ADD COLUMN accounting_fault_at INTEGER
  CHECK (accounting_fault_at IS NULL OR accounting_fault_at >= 0);

CREATE INDEX idx_usage_reservations_failure
  ON usage_reservations (settlement_failure_code, created_at)
  WHERE settlement_failure_code IS NOT NULL;
