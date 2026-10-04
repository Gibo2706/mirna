-- Keep bounded ledger retention independent of the amount of recent history.
-- Unresolved settlement evidence remains outside the pruning index.
CREATE INDEX idx_usage_reservations_prunable
  ON usage_reservations (settled_at, reservation_id)
  WHERE state IN ('committed', 'released')
    AND (settlement_failure_code IS NULL OR reconciled_at IS NOT NULL);
