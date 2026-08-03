-- Idempotent accounting readiness seeds for a fresh or previously repaired DB.
-- Existing counters and operator state always win; no usage is reset.

INSERT INTO service_flags (
  singleton_id, accept_new_vaults, accept_pairings, accept_writes,
  maintenance_mode, updated_at
)
VALUES (1, 1, 1, 1, 0, 0)
ON CONFLICT (singleton_id) DO NOTHING;

INSERT INTO resource_totals (singleton_id, updated_at)
VALUES (1, 0)
ON CONFLICT (singleton_id) DO NOTHING;

INSERT INTO usage_rolling_totals (scope_type, scope_id, refreshed_at)
VALUES ('global', 'service', 0)
ON CONFLICT (scope_type, scope_id) DO NOTHING;

INSERT INTO usage_daily_buckets (scope_type, scope_id, utc_day, updated_at)
VALUES ('global', 'service', date('now'), CAST(unixepoch() AS INTEGER) * 1000)
ON CONFLICT (scope_type, scope_id, utc_day) DO NOTHING;
