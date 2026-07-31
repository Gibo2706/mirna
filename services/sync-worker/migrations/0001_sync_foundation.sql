-- MIRNA encrypted sync protocol v1 operational schema.
--
-- Only opaque identifiers, public cryptographic material, ciphertext and minimal
-- operational metadata belong here. Plaintext Mirna finance data, recovery
-- secrets, pairing secrets and bearer tokens are forbidden by design.

PRAGMA foreign_keys = ON;

-- Shared vault lifecycle state (phases 1-3).
CREATE TABLE vaults (
  vault_id TEXT PRIMARY KEY NOT NULL CHECK (length(vault_id) = 22),
  protocol_version INTEGER NOT NULL DEFAULT 1
    CHECK (protocol_version = 1),
  crypto_suite TEXT NOT NULL
    CHECK (crypto_suite = 'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1'),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deleting')),
  current_key_epoch INTEGER NOT NULL DEFAULT 1
    CHECK (current_key_epoch >= 1),
  current_manifest_version INTEGER NOT NULL DEFAULT 0
    CHECK (current_manifest_version >= 0),
  current_snapshot_id TEXT
    CHECK (current_snapshot_id IS NULL OR length(current_snapshot_id) BETWEEN 16 AND 128),
  current_snapshot_revision INTEGER NOT NULL DEFAULT 0
    CHECK (current_snapshot_revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE INDEX idx_vaults_status_updated
  ON vaults (status, updated_at);

-- Phase 1: public device membership and signed authorization state.
CREATE TABLE devices (
  vault_id TEXT NOT NULL,
  device_id TEXT NOT NULL CHECK (length(device_id) = 22),
  signing_public_key_raw TEXT NOT NULL CHECK (length(signing_public_key_raw) = 87),
  agreement_public_key_raw TEXT NOT NULL CHECK (length(agreement_public_key_raw) = 87),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  added_in_manifest_version INTEGER NOT NULL
    CHECK (added_in_manifest_version >= 1),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  last_seen_at INTEGER CHECK (last_seen_at IS NULL OR last_seen_at >= created_at),
  PRIMARY KEY (vault_id, device_id),
  FOREIGN KEY (vault_id) REFERENCES vaults (vault_id) ON DELETE CASCADE,
  CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_devices_vault_status
  ON devices (vault_id, status, revoked_at);

CREATE TABLE vault_manifests (
  vault_id TEXT NOT NULL,
  manifest_version INTEGER NOT NULL CHECK (manifest_version >= 1),
  key_epoch INTEGER NOT NULL CHECK (key_epoch >= 1),
  authorization_kind TEXT NOT NULL CHECK (authorization_kind IN ('device', 'recovery')),
  signed_by_device_id TEXT,
  canonical_manifest TEXT NOT NULL
    CHECK (length(canonical_manifest) BETWEEN 2 AND 65536),
  manifest_hash BLOB NOT NULL CHECK (length(manifest_hash) = 32),
  previous_manifest_hash BLOB
    CHECK (previous_manifest_hash IS NULL OR length(previous_manifest_hash) = 32),
  signature BLOB NOT NULL CHECK (length(signature) BETWEEN 64 AND 256),
  accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0),
  PRIMARY KEY (vault_id, manifest_version),
  UNIQUE (vault_id, manifest_hash),
  FOREIGN KEY (vault_id) REFERENCES vaults (vault_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, signed_by_device_id)
    REFERENCES devices (vault_id, device_id) ON DELETE RESTRICT,
  CHECK (
    (authorization_kind = 'device' AND signed_by_device_id IS NOT NULL)
    OR (authorization_kind = 'recovery' AND signed_by_device_id IS NULL)
  )
) STRICT;

CREATE INDEX idx_vault_manifests_vault_epoch_version
  ON vault_manifests (vault_id, key_epoch, manifest_version DESC);

-- A non-genesis device row is valid only when that exact device and both of its
-- exact public keys occur in the signed manifest row for the claimed version.
-- This turns a losing concurrent manifest CAS inside a D1 batch into an abort,
-- even when another transition already inserted a different manifest at the
-- same version.
CREATE TRIGGER require_exact_device_manifest_before_insert
BEFORE INSERT ON devices
WHEN NEW.added_in_manifest_version > 1
  AND NOT EXISTS (
    SELECT 1
      FROM vault_manifests m,
           json_each(m.canonical_manifest, '$.devices') AS manifest_device
     WHERE m.vault_id = NEW.vault_id
       AND m.manifest_version = NEW.added_in_manifest_version
       AND json_extract(manifest_device.value, '$.deviceId') = NEW.device_id
       AND json_extract(manifest_device.value, '$.publicKeys.signing.value') =
           NEW.signing_public_key_raw
       AND json_extract(manifest_device.value, '$.publicKeys.agreement.value') =
           NEW.agreement_public_key_raw
  )
BEGIN
  SELECT RAISE(ABORT, 'exact device manifest membership missing');
END;

CREATE TABLE device_grants (
  grant_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(grant_id) BETWEEN 16 AND 128),
  vault_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK (grant_version >= 1),
  issued_by_device_id TEXT,
  authorization_transcript_hash BLOB NOT NULL
    CHECK (length(authorization_transcript_hash) = 32),
  authorization_signature BLOB NOT NULL
    CHECK (length(authorization_signature) BETWEEN 64 AND 256),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  UNIQUE (vault_id, device_id, grant_version),
  FOREIGN KEY (vault_id, device_id)
    REFERENCES devices (vault_id, device_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, issued_by_device_id)
    REFERENCES devices (vault_id, device_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_device_grants_authorization
  ON device_grants (vault_id, device_id, revoked_at, expires_at DESC);
CREATE INDEX idx_device_grants_expiry
  ON device_grants (expires_at, revoked_at);

CREATE TABLE auth_challenges (
  challenge_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(challenge_id) BETWEEN 16 AND 128),
  vault_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (
    audience IN (
      '/v1/auth/session',
      '/v1/pairings/approve',
      '/v1/pairings/cancel',
      '/v1/devices/renew',
      '/v1/devices/revoke',
      '/v1/recovery/rotate',
      '/v1/vault/delete'
    )
  ),
  origin TEXT NOT NULL CHECK (length(origin) BETWEEN 8 AND 512),
  challenge_hash BLOB NOT NULL UNIQUE CHECK (length(challenge_hash) = 32),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  FOREIGN KEY (vault_id, device_id)
    REFERENCES devices (vault_id, device_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_auth_challenges_device_audience_expiry
  ON auth_challenges (vault_id, device_id, audience, expires_at);
CREATE INDEX idx_auth_challenges_expiry
  ON auth_challenges (expires_at, consumed_at);

CREATE TABLE access_sessions (
  session_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(session_id) BETWEEN 16 AND 128),
  vault_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  last_used_at INTEGER CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  FOREIGN KEY (vault_id, device_id)
    REFERENCES devices (vault_id, device_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_access_sessions_device_expiry
  ON access_sessions (vault_id, device_id, revoked_at, expires_at);
CREATE INDEX idx_access_sessions_expiry
  ON access_sessions (expires_at, revoked_at);

CREATE TABLE pairing_requests (
  pairing_request_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(pairing_request_id) BETWEEN 16 AND 128),
  vault_id TEXT,
  new_device_id TEXT NOT NULL CHECK (length(new_device_id) = 22),
  new_signing_public_key_raw TEXT NOT NULL CHECK (length(new_signing_public_key_raw) = 87),
  new_agreement_public_key_raw TEXT NOT NULL CHECK (length(new_agreement_public_key_raw) = 87),
  pairing_salt BLOB NOT NULL CHECK (length(pairing_salt) = 32),
  pairing_claim_token_hash BLOB NOT NULL UNIQUE
    CHECK (length(pairing_claim_token_hash) = 32),
  polling_token_hash BLOB NOT NULL UNIQUE
    CHECK (length(polling_token_hash) = 32),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'finalized', 'cancelled')),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5
    CHECK (max_attempts BETWEEN 1 AND 20),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  finalized_at INTEGER CHECK (finalized_at IS NULL OR finalized_at >= created_at),
  cancelled_at INTEGER CHECK (cancelled_at IS NULL OR cancelled_at >= created_at),
  finalization_hash BLOB CHECK (finalization_hash IS NULL OR length(finalization_hash) = 32),
  UNIQUE (pairing_request_id, vault_id, new_device_id),
  FOREIGN KEY (vault_id) REFERENCES vaults (vault_id) ON DELETE CASCADE,
  CHECK (failed_attempts <= max_attempts),
  CHECK (
    (status IN ('pending', 'approved') AND finalized_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'finalized' AND finalized_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND finalized_at IS NULL AND cancelled_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_pairing_requests_vault_status_expiry
  ON pairing_requests (vault_id, status, expires_at);
CREATE INDEX idx_pairing_requests_expiry
  ON pairing_requests (expires_at, status);

CREATE TABLE pairing_envelopes (
  envelope_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(envelope_id) BETWEEN 16 AND 128),
  pairing_request_id TEXT NOT NULL UNIQUE,
  vault_id TEXT NOT NULL,
  new_device_id TEXT NOT NULL,
  authorizing_device_id TEXT NOT NULL,
  key_epoch INTEGER NOT NULL CHECK (key_epoch >= 1),
  crypto_suite TEXT NOT NULL
    CHECK (crypto_suite = 'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1'),
  canonical_envelope TEXT NOT NULL CHECK (length(canonical_envelope) BETWEEN 2 AND 131072),
  envelope_hash BLOB NOT NULL CHECK (length(envelope_hash) = 32),
  candidate_manifest TEXT NOT NULL CHECK (length(candidate_manifest) BETWEEN 2 AND 65536),
  candidate_manifest_hash BLOB NOT NULL CHECK (length(candidate_manifest_hash) = 32),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  retention_expires_at INTEGER NOT NULL CHECK (retention_expires_at >= expires_at),
  FOREIGN KEY (pairing_request_id, vault_id, new_device_id)
    REFERENCES pairing_requests (pairing_request_id, vault_id, new_device_id)
    ON DELETE CASCADE,
  FOREIGN KEY (vault_id) REFERENCES vaults (vault_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, authorizing_device_id)
    REFERENCES devices (vault_id, device_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_pairing_envelopes_vault_request
  ON pairing_envelopes (vault_id, pairing_request_id);
CREATE INDEX idx_pairing_envelopes_cleanup
  ON pairing_envelopes (retention_expires_at, consumed_at, expires_at);

CREATE TABLE recovery_records (
  recovery_lookup_id TEXT PRIMARY KEY NOT NULL CHECK (length(recovery_lookup_id) = 22),
  vault_id TEXT NOT NULL,
  recovery_version INTEGER NOT NULL CHECK (recovery_version >= 1),
  key_epoch INTEGER NOT NULL CHECK (key_epoch >= 1),
  recovery_gate_key_hash BLOB NOT NULL UNIQUE
    CHECK (length(recovery_gate_key_hash) = 32),
  recovery_signing_public_key_raw TEXT NOT NULL
    CHECK (length(recovery_signing_public_key_raw) = 87),
  manifest_version INTEGER NOT NULL CHECK (manifest_version >= 1),
  manifest_hash BLOB NOT NULL CHECK (length(manifest_hash) = 32),
  crypto_suite TEXT NOT NULL
    CHECK (crypto_suite = 'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1'),
  canonical_recovery_envelope TEXT NOT NULL
    CHECK (length(canonical_recovery_envelope) BETWEEN 2 AND 131072),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until INTEGER CHECK (locked_until IS NULL OR locked_until >= 0),
  signed_updated_at INTEGER NOT NULL CHECK (signed_updated_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  rotated_at INTEGER CHECK (rotated_at IS NULL OR rotated_at >= created_at),
  UNIQUE (vault_id, recovery_version),
  FOREIGN KEY (vault_id) REFERENCES vaults (vault_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_recovery_records_vault_active
  ON recovery_records (vault_id, rotated_at, recovery_version DESC);
CREATE INDEX idx_recovery_records_lock
  ON recovery_records (locked_until, rotated_at);

CREATE TABLE recovery_challenges (
  challenge_id TEXT PRIMARY KEY NOT NULL CHECK (length(challenge_id) = 22),
  recovery_lookup_id TEXT NOT NULL,
  new_device_id TEXT NOT NULL CHECK (length(new_device_id) = 22),
  new_signing_public_key_raw TEXT NOT NULL CHECK (length(new_signing_public_key_raw) = 87),
  new_agreement_public_key_raw TEXT NOT NULL CHECK (length(new_agreement_public_key_raw) = 87),
  origin TEXT NOT NULL CHECK (length(origin) BETWEEN 8 AND 512),
  challenge_hash BLOB NOT NULL UNIQUE CHECK (length(challenge_hash) = 32),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  idempotency_key_hash BLOB
    CHECK (idempotency_key_hash IS NULL OR length(idempotency_key_hash) = 32),
  complete_request_hash BLOB
    CHECK (complete_request_hash IS NULL OR length(complete_request_hash) = 32),
  canonical_complete_response TEXT
    CHECK (canonical_complete_response IS NULL OR length(canonical_complete_response) BETWEEN 2 AND 4096),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= created_at),
  retention_expires_at INTEGER NOT NULL CHECK (retention_expires_at > expires_at),
  FOREIGN KEY (recovery_lookup_id)
    REFERENCES recovery_records (recovery_lookup_id) ON DELETE CASCADE,
  CHECK (
    (completed_at IS NULL AND idempotency_key_hash IS NULL
      AND complete_request_hash IS NULL AND canonical_complete_response IS NULL)
    OR
    (completed_at IS NOT NULL AND consumed_at IS NOT NULL
      AND idempotency_key_hash IS NOT NULL AND complete_request_hash IS NOT NULL
      AND canonical_complete_response IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_recovery_challenges_lookup_expiry
  ON recovery_challenges (recovery_lookup_id, expires_at, consumed_at);
CREATE INDEX idx_recovery_challenges_retention
  ON recovery_challenges (completed_at, retention_expires_at);

-- Phase 2: R2 contains snapshot ciphertext; D1 keeps only its clear envelope.
CREATE TABLE snapshots (
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
  PRIMARY KEY (vault_id, snapshot_id),
  UNIQUE (vault_id, revision),
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

CREATE INDEX idx_snapshots_vault_state_revision
  ON snapshots (vault_id, state, revision DESC);
CREATE INDEX idx_snapshots_cleanup
  ON snapshots (state, cleanup_after);

-- Phase 3: ciphertext-only append log and acknowledgement frontier.
CREATE TABLE sync_changes (
  server_cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 16 AND 128),
  device_id TEXT NOT NULL,
  device_sequence INTEGER NOT NULL CHECK (device_sequence >= 1),
  key_epoch INTEGER NOT NULL CHECK (key_epoch >= 1),
  crypto_suite TEXT NOT NULL
    CHECK (crypto_suite = 'MIRNA-E2EE-P256-HKDF-SHA256-AES256GCM-V1'),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  aad BLOB NOT NULL CHECK (length(aad) BETWEEN 2 AND 4096),
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) BETWEEN 16 AND 65536),
  ciphertext_hash BLOB NOT NULL CHECK (length(ciphertext_hash) = 32),
  signature BLOB NOT NULL CHECK (length(signature) BETWEEN 64 AND 256),
  previous_operation_hash BLOB
    CHECK (previous_operation_hash IS NULL OR length(previous_operation_hash) = 32),
  accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0),
  compacted_at INTEGER CHECK (compacted_at IS NULL OR compacted_at >= accepted_at),
  cleanup_after INTEGER CHECK (
    cleanup_after IS NULL
    OR (compacted_at IS NOT NULL AND cleanup_after >= compacted_at)
  ),
  UNIQUE (vault_id, operation_id),
  UNIQUE (vault_id, device_id, device_sequence),
  FOREIGN KEY (vault_id) REFERENCES vaults (vault_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, device_id)
    REFERENCES devices (vault_id, device_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_sync_changes_vault_cursor
  ON sync_changes (vault_id, server_cursor);
CREATE INDEX idx_sync_changes_vault_device_sequence
  ON sync_changes (vault_id, device_id, device_sequence);
CREATE INDEX idx_sync_changes_cleanup
  ON sync_changes (cleanup_after, compacted_at);

CREATE TABLE device_acknowledgements (
  vault_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  acknowledged_server_cursor INTEGER NOT NULL
    CHECK (acknowledged_server_cursor >= 0),
  acknowledged_snapshot_id TEXT,
  acknowledged_snapshot_revision INTEGER NOT NULL DEFAULT 0
    CHECK (acknowledged_snapshot_revision >= 0),
  acknowledged_at INTEGER NOT NULL CHECK (acknowledged_at >= 0),
  PRIMARY KEY (vault_id, device_id),
  FOREIGN KEY (vault_id, device_id)
    REFERENCES devices (vault_id, device_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_device_acknowledgements_vault_cursor
  ON device_acknowledgements (vault_id, acknowledged_server_cursor);

-- Cross-phase resumable deletion state. Proofs remain hashed or signed.
CREATE TABLE deletion_requests (
  deletion_request_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(deletion_request_id) BETWEEN 16 AND 128),
  vault_id TEXT NOT NULL,
  requested_by_device_id TEXT NOT NULL,
  idempotency_key_hash BLOB NOT NULL CHECK (length(idempotency_key_hash) = 32),
  authorization_transcript_hash BLOB NOT NULL
    CHECK (length(authorization_transcript_hash) = 32),
  authorization_signature BLOB NOT NULL
    CHECK (length(authorization_signature) BETWEEN 64 AND 256),
  second_factor_proof_hash BLOB NOT NULL
    CHECK (length(second_factor_proof_hash) = 32),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'deleting_r2', 'deleting_d1', 'completed', 'failed')),
  resume_after_r2_key TEXT
    CHECK (resume_after_r2_key IS NULL OR length(resume_after_r2_key) <= 512),
  safe_error_code TEXT
    CHECK (safe_error_code IS NULL OR length(safe_error_code) <= 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  stale_after INTEGER NOT NULL CHECK (stale_after >= expires_at),
  retention_expires_at INTEGER NOT NULL CHECK (retention_expires_at > stale_after),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= created_at),
  UNIQUE (vault_id, idempotency_key_hash),
  CHECK (
    (state = 'completed' AND completed_at IS NOT NULL)
    OR (state != 'completed' AND completed_at IS NULL)
  )
) STRICT;

-- Deliberately no vault/device FK: this resumable tombstone must survive the
-- final vault-row deletion long enough to make a retried request idempotent.
CREATE INDEX idx_deletion_requests_vault_state
  ON deletion_requests (vault_id, state, updated_at);
CREATE INDEX idx_deletion_requests_expiry
  ON deletion_requests (state, stale_after, retention_expires_at);
