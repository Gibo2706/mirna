-- Phase 2 snapshot commit metadata. Ciphertext remains exclusively in private R2.

ALTER TABLE snapshots ADD COLUMN canonical_envelope TEXT
  CHECK (canonical_envelope IS NULL OR length(canonical_envelope) BETWEEN 2 AND 16384);

ALTER TABLE snapshots ADD COLUMN envelope_hash BLOB
  CHECK (envelope_hash IS NULL OR length(envelope_hash) = 32);

ALTER TABLE snapshots ADD COLUMN canonical_commit_response TEXT
  CHECK (
    canonical_commit_response IS NULL
    OR length(canonical_commit_response) BETWEEN 2 AND 4096
  );

ALTER TABLE snapshots ADD COLUMN r2_etag TEXT
  CHECK (r2_etag IS NULL OR length(r2_etag) BETWEEN 1 AND 256);

-- A snapshot can become committed only after the vault CAS points at that exact
-- revision and object. This makes a zero-change/losing CAS unable to publish a
-- temporary R2 object as current metadata inside the same D1 batch.
CREATE TRIGGER require_current_vault_pointer_before_snapshot_commit
BEFORE UPDATE OF state, committed_at ON snapshots
WHEN NEW.state = 'committed'
  AND NOT EXISTS (
    SELECT 1
      FROM vaults v
     WHERE v.vault_id = NEW.vault_id
       AND v.current_snapshot_id = NEW.snapshot_id
       AND v.current_snapshot_revision = NEW.revision
       AND v.current_key_epoch = NEW.key_epoch
  )
BEGIN
  SELECT RAISE(ABORT, 'current vault snapshot pointer missing');
END;
