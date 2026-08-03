-- A unique accounting identity lets concurrent retries distinguish the one
-- insertion that owns the resource-total increment.

ALTER TABLE resource_inventory ADD COLUMN accounting_reservation_id TEXT
  CHECK (
    accounting_reservation_id IS NULL
    OR length(accounting_reservation_id) BETWEEN 16 AND 128
  );

CREATE UNIQUE INDEX idx_resource_inventory_accounting_reservation
  ON resource_inventory (accounting_reservation_id)
  WHERE accounting_reservation_id IS NOT NULL;
