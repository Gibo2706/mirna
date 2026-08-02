-- Make pairing admission cost depend on configured live caps instead of a
-- full-table scan. The singleton is application state (not a quota override):
-- triggers keep it exact across inserts, cleanup and vault cascades.

CREATE TABLE pairing_request_totals (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  total_count INTEGER NOT NULL CHECK (total_count >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO pairing_request_totals (singleton_id, total_count, updated_at)
SELECT 1, COUNT(*), COALESCE(MAX(created_at), 0)
  FROM pairing_requests;

CREATE TRIGGER pairing_request_total_after_insert
AFTER INSERT ON pairing_requests
BEGIN
  UPDATE pairing_request_totals
     SET total_count = total_count + 1,
         updated_at = MAX(updated_at, NEW.created_at)
   WHERE singleton_id = 1;
END;

CREATE TRIGGER pairing_request_total_after_delete
AFTER DELETE ON pairing_requests
BEGIN
  UPDATE pairing_request_totals
     SET total_count = MAX(0, total_count - 1),
         updated_at = MAX(updated_at, OLD.created_at)
   WHERE singleton_id = 1;
END;

CREATE INDEX idx_pairing_requests_device_status_expiry
  ON pairing_requests (new_device_id, status, expires_at);
