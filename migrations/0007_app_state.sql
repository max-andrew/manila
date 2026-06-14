-- Small key/value table for demo/runtime state. `reset_at` is the time-aware
-- demo reset: the agent's "paid today" guard only counts payments sealed AFTER
-- this timestamp, so clicking "Reset demo" lets payroll run again without
-- deleting any history (the audit trail and on-chain reality stay intact).
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO app_state (key, value) VALUES ('reset_at', '1970-01-01 00:00:00');
