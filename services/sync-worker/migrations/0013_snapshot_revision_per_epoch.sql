-- Recovery starts a new key epoch at snapshot revision 1. Retained ciphertext
-- from an older epoch must not occupy that revision in the new epoch.
CREATE TABLE snapshots_next (
  vault_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL CHECK (length(snapshot_id) BETWEEN 16 AND 128),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0 AND base_revision < revision),
  key_epoch INTEGER NOT NULL CHECK (key_epoch >= 1),
  creating_device_id TEXT NOT NULL,
  crypto_suite TEXT NOT NULL
    CHECK (crypto_suite = 'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1'),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  aad BLOB NOT NULL CHECK (length(aad) BETWEEN 2 AND 4096),
  ciphertext_hash BLOB NOT NULL CHECK (length(ciphertext_hash) = 32),
  ciphertext_size INTEGER NOT NULL
    CHECK (ciphertext_size BETWEEN 16 AND 8388608),
  envelope_signature BLOB NOT NULL
    CHECK (length(envelope_signature) BETWEEN 64 AND 256),
  previous_snapshot_hash BLOB
    CHECK (previous_snapshot_hash IS NULL OR length(previous_snapshot_hash) = 32),
  idempotency_key_hash BLOB NOT NULL CHECK (length(idempotency_key_hash) = 32),
  r2_object_key TEXT NOT NULL UNIQUE
    CHECK (length(r2_object_key) BETWEEN 16 AND 512),
  state TEXT NOT NULL
    CHECK (state IN ('temporary', 'committed', 'orphaned', 'superseded', 'deleting')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  committed_at INTEGER CHECK (committed_at IS NULL OR committed_at >= created_at),
  cleanup_after INTEGER CHECK (cleanup_after IS NULL OR cleanup_after >= created_at),
  canonical_envelope TEXT
    CHECK (canonical_envelope IS NULL OR length(canonical_envelope) BETWEEN 2 AND 16384),
  envelope_hash BLOB
    CHECK (envelope_hash IS NULL OR length(envelope_hash) = 32),
  canonical_commit_response TEXT
    CHECK (canonical_commit_response IS NULL OR length(canonical_commit_response) BETWEEN 2 AND 4096),
  r2_etag TEXT CHECK (r2_etag IS NULL OR length(r2_etag) BETWEEN 1 AND 256),
  PRIMARY KEY (vault_id, snapshot_id),
  UNIQUE (vault_id, key_epoch, revision),
  UNIQUE (vault_id, idempotency_key_hash),
  FOREIGN KEY (vault_id) REFERENCES vaults (vault_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, creating_device_id)
    REFERENCES devices (vault_id, device_id) ON DELETE CASCADE,
  CHECK (
    (state = 'committed' AND committed_at IS NOT NULL AND cleanup_after IS NULL)
    OR (state = 'temporary' AND committed_at IS NULL AND cleanup_after IS NOT NULL)
    OR (state = 'orphaned' AND cleanup_after IS NOT NULL)
    OR (state = 'superseded' AND committed_at IS NOT NULL AND cleanup_after IS NOT NULL)
    OR (state = 'deleting' AND cleanup_after IS NOT NULL)
  )
) STRICT;

INSERT INTO snapshots_next (
  vault_id, snapshot_id, revision, base_revision, key_epoch,
  creating_device_id, crypto_suite, nonce, aad, ciphertext_hash,
  ciphertext_size, envelope_signature, previous_snapshot_hash,
  idempotency_key_hash, r2_object_key, state, created_at, committed_at,
  cleanup_after, canonical_envelope, envelope_hash, canonical_commit_response, r2_etag
)
SELECT
  vault_id, snapshot_id, revision, base_revision, key_epoch,
  creating_device_id, crypto_suite, nonce, aad, ciphertext_hash,
  ciphertext_size, envelope_signature, previous_snapshot_hash,
  idempotency_key_hash, r2_object_key, state, created_at, committed_at,
  cleanup_after, canonical_envelope, envelope_hash, canonical_commit_response, r2_etag
FROM snapshots;

DROP TABLE snapshots;
ALTER TABLE snapshots_next RENAME TO snapshots;

CREATE INDEX idx_snapshots_vault_state_revision
  ON snapshots (vault_id, state, revision DESC);
CREATE INDEX idx_snapshots_cleanup
  ON snapshots (state, cleanup_after);

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
