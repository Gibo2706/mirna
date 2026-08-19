-- Bounded cursor for application-managed R2 inventory verification.

ALTER TABLE resource_totals ADD COLUMN r2_reconcile_cursor TEXT
  CHECK (r2_reconcile_cursor IS NULL OR length(r2_reconcile_cursor) BETWEEN 1 AND 2048);
ALTER TABLE resource_totals ADD COLUMN r2_reconciled_at INTEGER NOT NULL DEFAULT 0
  CHECK (r2_reconciled_at >= 0);
