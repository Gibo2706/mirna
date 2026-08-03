-- Phase 3 canonical operation storage and acknowledgement proof metadata.

ALTER TABLE sync_changes ADD COLUMN canonical_envelope TEXT
  CHECK (canonical_envelope IS NULL OR length(canonical_envelope) BETWEEN 2 AND 131072);

ALTER TABLE device_acknowledgements ADD COLUMN causal_frontier_hash BLOB
  CHECK (causal_frontier_hash IS NULL OR length(causal_frontier_hash) = 32);

CREATE INDEX idx_device_acknowledgements_vault_snapshot
  ON device_acknowledgements (
    vault_id,
    acknowledged_snapshot_id,
    acknowledged_snapshot_revision,
    acknowledged_server_cursor
  );
