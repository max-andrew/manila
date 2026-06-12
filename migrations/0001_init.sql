-- Manila schema. All money columns are INTEGER micro-USDC (6 decimals).

CREATE TABLE employees (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  wallet       TEXT NOT NULL UNIQUE,            -- public address; Unlink private account ref added in M1
  salary_micro INTEGER NOT NULL,                -- USDC base units, 6 decimals
  schedule     TEXT NOT NULL DEFAULT 'monthly',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payroll_runs (
  id            INTEGER PRIMARY KEY,
  period        TEXT NOT NULL,                  -- e.g. '2026-06'
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','pending_approval','executing','sealed','failed')),
  total_micro   INTEGER NOT NULL DEFAULT 0,
  policy_result TEXT,                           -- JSON: {pass, cap_ok, allowlist_ok, reasons[]}
  requested_by  TEXT NOT NULL DEFAULT 'agent',  -- 'agent' | 'employer'
  approved_by   TEXT,                           -- second signature (maker-checker)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);

CREATE TABLE payments (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES payroll_runs(id),
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  amount_micro INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','sealed','failed')),
  unlink_ref   TEXT,                            -- sealed-transfer reference
  gateway_ref  TEXT,                            -- Gateway batch/settlement reference
  tx_hash      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY,
  actor         TEXT NOT NULL,                  -- 'agent' | 'employer' | 'system'
  action        TEXT NOT NULL,
  run_id        INTEGER,
  detail        TEXT,                           -- JSON
  policy_result TEXT,                           -- 'pass' | 'blocked' | NULL
  tx_refs       TEXT,                           -- JSON array of hashes/refs
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE policies (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  per_run_cap_micro INTEGER NOT NULL,
  allowlist         TEXT NOT NULL               -- JSON array of wallet addresses
);

CREATE INDEX idx_payments_run ON payments(run_id);
CREATE INDEX idx_audit_run ON audit_log(run_id);
