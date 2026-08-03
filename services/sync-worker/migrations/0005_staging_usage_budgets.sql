-- Hard staging usage ledger and application-managed R2 inventory.
-- No financial plaintext, credentials, IP addresses or request bodies belong here.

CREATE TABLE usage_daily_buckets (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'vault')),
  scope_id TEXT NOT NULL,
  utc_day TEXT NOT NULL CHECK (length(utc_day) = 10),
  worker_requests INTEGER NOT NULL DEFAULT 0 CHECK (worker_requests >= 0),
  d1_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (d1_rows_read >= 0),
  d1_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (d1_rows_written >= 0),
  r2_class_a INTEGER NOT NULL DEFAULT 0 CHECK (r2_class_a >= 0),
  r2_class_b INTEGER NOT NULL DEFAULT 0 CHECK (r2_class_b >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (scope_type, scope_id, utc_day),
  CHECK (
    (scope_type = 'global' AND scope_id = 'service')
    OR (scope_type = 'vault' AND length(scope_id) = 22)
  )
) STRICT;

CREATE INDEX idx_usage_daily_window
  ON usage_daily_buckets (utc_day, scope_type, scope_id);

CREATE TABLE usage_rolling_totals (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'vault')),
  scope_id TEXT NOT NULL,
  worker_requests INTEGER NOT NULL DEFAULT 0 CHECK (worker_requests >= 0),
  d1_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (d1_rows_read >= 0),
  d1_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (d1_rows_written >= 0),
  r2_class_a INTEGER NOT NULL DEFAULT 0 CHECK (r2_class_a >= 0),
  r2_class_b INTEGER NOT NULL DEFAULT 0 CHECK (r2_class_b >= 0),
  refreshed_at INTEGER NOT NULL CHECK (refreshed_at >= 0),
  PRIMARY KEY (scope_type, scope_id),
  CHECK (
    (scope_type = 'global' AND scope_id = 'service')
    OR (scope_type = 'vault' AND length(scope_id) = 22)
  )
) STRICT;

CREATE TABLE usage_reservations (
  reservation_id TEXT PRIMARY KEY NOT NULL CHECK (length(reservation_id) BETWEEN 16 AND 128),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'vault')),
  scope_id TEXT NOT NULL,
  route_key TEXT NOT NULL CHECK (length(route_key) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'released')),
  reserved_worker_requests INTEGER NOT NULL CHECK (reserved_worker_requests >= 0),
  reserved_d1_rows_read INTEGER NOT NULL CHECK (reserved_d1_rows_read >= 0),
  reserved_d1_rows_written INTEGER NOT NULL CHECK (reserved_d1_rows_written >= 0),
  reserved_r2_class_a INTEGER NOT NULL CHECK (reserved_r2_class_a >= 0),
  reserved_r2_class_b INTEGER NOT NULL CHECK (reserved_r2_class_b >= 0),
  committed_worker_requests INTEGER NOT NULL DEFAULT 0 CHECK (committed_worker_requests >= 0),
  committed_d1_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (committed_d1_rows_read >= 0),
  committed_d1_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (committed_d1_rows_written >= 0),
  committed_r2_class_a INTEGER NOT NULL DEFAULT 0 CHECK (committed_r2_class_a >= 0),
  committed_r2_class_b INTEGER NOT NULL DEFAULT 0 CHECK (committed_r2_class_b >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  settled_at INTEGER CHECK (settled_at IS NULL OR settled_at >= created_at),
  CHECK (
    (scope_type = 'global' AND scope_id = 'service')
    OR (scope_type = 'vault' AND length(scope_id) = 22)
  )
) STRICT;

CREATE INDEX idx_usage_reservations_state_created
  ON usage_reservations (state, created_at);

CREATE TABLE service_flags (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  accept_new_vaults INTEGER NOT NULL CHECK (accept_new_vaults IN (0, 1)),
  accept_pairings INTEGER NOT NULL CHECK (accept_pairings IN (0, 1)),
  accept_writes INTEGER NOT NULL CHECK (accept_writes IN (0, 1)),
  maintenance_mode INTEGER NOT NULL CHECK (maintenance_mode IN (0, 1)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO service_flags (
  singleton_id, accept_new_vaults, accept_pairings, accept_writes,
  maintenance_mode, updated_at
) VALUES (1, 1, 1, 1, 0, 0);

CREATE TABLE resource_totals (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  r2_stored_bytes INTEGER NOT NULL DEFAULT 0 CHECK (r2_stored_bytes >= 0),
  r2_object_count INTEGER NOT NULL DEFAULT 0 CHECK (r2_object_count >= 0),
  d1_storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK (d1_storage_bytes >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO resource_totals (singleton_id, updated_at) VALUES (1, 0);

CREATE TABLE vault_resource_totals (
  vault_id TEXT PRIMARY KEY NOT NULL CHECK (length(vault_id) = 22),
  r2_stored_bytes INTEGER NOT NULL DEFAULT 0 CHECK (r2_stored_bytes >= 0),
  r2_object_count INTEGER NOT NULL DEFAULT 0 CHECK (r2_object_count >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (vault_id) REFERENCES vaults (vault_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE resource_inventory (
  object_key TEXT PRIMARY KEY NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
  vault_id TEXT NOT NULL CHECK (length(vault_id) = 22),
  object_type TEXT NOT NULL CHECK (object_type IN ('snapshot')),
  state TEXT NOT NULL CHECK (state IN ('temporary', 'committed', 'deletable')),
  ciphertext_bytes INTEGER NOT NULL CHECK (ciphertext_bytes > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (vault_id) REFERENCES vaults (vault_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_resource_inventory_vault_state
  ON resource_inventory (vault_id, state, created_at);
