-- Privacy-safe, short-lived beta observability. References are one-way hashes;
-- diagnostic payloads are allowlisted and never contain request bodies or IPs.

CREATE TABLE beta_diagnostic_events (
  event_id TEXT PRIMARY KEY
    CHECK (length(event_id) = 36),
  created_at INTEGER NOT NULL
    CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL
    CHECK (expires_at > created_at),
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'turnstile_client_phase',
      'turnstile_siteverify_result',
      'health_result',
      'request_error'
    )),
  severity TEXT NOT NULL
    CHECK (severity IN ('info', 'error')),
  support_ref BLOB NOT NULL
    CHECK (length(support_ref) = 32),
  request_id TEXT
    CHECK (request_id IS NULL OR length(request_id) = 36),
  vault_ref BLOB
    CHECK (vault_ref IS NULL OR length(vault_ref) = 32),
  device_ref BLOB
    CHECK (device_ref IS NULL OR length(device_ref) = 32),
  technical_code TEXT NOT NULL
    CHECK (length(technical_code) BETWEEN 1 AND 64),
  route_action TEXT
    CHECK (route_action IS NULL OR route_action IN (
      'mirna_vault_create',
      'mirna_pairing_create',
      'mirna_recovery_init'
    )),
  worker_build TEXT NOT NULL
    CHECK (length(worker_build) BETWEEN 1 AND 64),
  safe_details_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      length(CAST(safe_details_json AS BLOB)) <= 2048
      AND json_valid(safe_details_json)
      AND json_type(safe_details_json) = 'object'
    )
) STRICT;

CREATE TABLE beta_diagnostic_totals (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  updated_at INTEGER NOT NULL DEFAULT 0 CHECK (updated_at >= 0)
) STRICT;

INSERT INTO beta_diagnostic_totals (singleton_id, event_count, updated_at)
VALUES (1, 0, 0);

CREATE TRIGGER beta_diagnostic_count_after_insert
AFTER INSERT ON beta_diagnostic_events
BEGIN
  UPDATE beta_diagnostic_totals
     SET event_count = event_count + 1,
         updated_at = NEW.created_at
   WHERE singleton_id = 1;
END;

CREATE TRIGGER beta_diagnostic_count_after_delete
AFTER DELETE ON beta_diagnostic_events
BEGIN
  UPDATE beta_diagnostic_totals
     SET event_count = MAX(0, event_count - 1),
         updated_at = MAX(updated_at, OLD.created_at)
   WHERE singleton_id = 1;
END;

CREATE INDEX idx_beta_diagnostics_support_created
  ON beta_diagnostic_events(support_ref, created_at DESC);
CREATE INDEX idx_beta_diagnostics_request
  ON beta_diagnostic_events(request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX idx_beta_diagnostics_vault_created
  ON beta_diagnostic_events(vault_ref, created_at DESC)
  WHERE vault_ref IS NOT NULL;
CREATE INDEX idx_beta_diagnostics_expiry
  ON beta_diagnostic_events(expires_at, event_id);
