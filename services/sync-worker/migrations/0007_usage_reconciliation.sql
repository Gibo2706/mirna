-- Record the difference between conservative reservations and observed use.

ALTER TABLE usage_reservations ADD COLUMN released_worker_requests INTEGER NOT NULL DEFAULT 0
  CHECK (released_worker_requests >= 0);
ALTER TABLE usage_reservations ADD COLUMN released_d1_rows_read INTEGER NOT NULL DEFAULT 0
  CHECK (released_d1_rows_read >= 0);
ALTER TABLE usage_reservations ADD COLUMN released_d1_rows_written INTEGER NOT NULL DEFAULT 0
  CHECK (released_d1_rows_written >= 0);
ALTER TABLE usage_reservations ADD COLUMN released_r2_class_a INTEGER NOT NULL DEFAULT 0
  CHECK (released_r2_class_a >= 0);
ALTER TABLE usage_reservations ADD COLUMN released_r2_class_b INTEGER NOT NULL DEFAULT 0
  CHECK (released_r2_class_b >= 0);

ALTER TABLE vault_resource_totals ADD COLUMN release_reservation_id TEXT
  CHECK (
    release_reservation_id IS NULL
    OR length(release_reservation_id) BETWEEN 16 AND 128
  );

CREATE UNIQUE INDEX idx_vault_resource_totals_release_reservation
  ON vault_resource_totals (release_reservation_id)
  WHERE release_reservation_id IS NOT NULL;
