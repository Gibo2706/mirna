-- Device authorization renewal and recovery-confirmed secure revocation.
-- Envelopes contain only a randomly generated VMK encrypted for one active
-- recipient. The Worker never receives a wrapping or decryption key.

CREATE TABLE device_key_envelopes (
  vault_id TEXT NOT NULL,
  key_epoch INTEGER NOT NULL CHECK (key_epoch >= 2),
  recipient_device_id TEXT NOT NULL CHECK (length(recipient_device_id) = 22),
  sender_device_id TEXT NOT NULL CHECK (length(sender_device_id) = 22),
  manifest_version INTEGER NOT NULL CHECK (manifest_version >= 2),
  canonical_envelope TEXT NOT NULL
    CHECK (length(canonical_envelope) BETWEEN 2 AND 131072),
  envelope_hash BLOB NOT NULL CHECK (length(envelope_hash) = 32),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  claimed_at INTEGER CHECK (claimed_at IS NULL OR claimed_at >= created_at),
  PRIMARY KEY (vault_id, key_epoch, recipient_device_id),
  FOREIGN KEY (vault_id) REFERENCES vaults (vault_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, recipient_device_id)
    REFERENCES devices (vault_id, device_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, sender_device_id)
    REFERENCES devices (vault_id, device_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_device_key_envelopes_recipient_epoch
  ON device_key_envelopes (vault_id, recipient_device_id, key_epoch DESC);

CREATE TABLE device_security_transitions (
  transition_id TEXT PRIMARY KEY NOT NULL CHECK (length(transition_id) = 22),
  vault_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('renew-device', 'secure-revoke-device')),
  affected_device_id TEXT NOT NULL CHECK (length(affected_device_id) = 22),
  request_hash BLOB NOT NULL UNIQUE CHECK (length(request_hash) = 32),
  canonical_response TEXT NOT NULL
    CHECK (length(canonical_response) BETWEEN 2 AND 4096),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (vault_id) REFERENCES vaults (vault_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_device_security_transitions_vault_created
  ON device_security_transitions (vault_id, created_at DESC);
