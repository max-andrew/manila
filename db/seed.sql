-- Seed data. Wallets are placeholders until setup provisions real Arc accounts
-- (employees.unlink_address is set later by scripts/setup-unlink.mjs).
--
-- Manila pays DAILY, not monthly — gas-free nanopayments make per-day payroll
-- economical (a daily run costs $0.003 in fees), which is impractical on ACH/
-- wire. salary_micro is the DAILY rate. Amounts are demo-scaled (the Arc faucet
-- grants 20 USDC per address per 2h; every transaction is real).
--
-- A normal day totals $13.10. Treasury controls:
--   per_run_cap $15  → over it, a run needs a second signature (e.g. a +25% day)
--   hard_cap   $30   → over it, refused outright — no instruction can drain it
--   pay band   75%..+100% → gross over/underpay refused
--   allowlist        → paying any non-roster address refused

DELETE FROM employees;
DELETE FROM policies;

INSERT INTO employees (id, name, wallet, salary_micro, schedule) VALUES
  (1, 'Ada Okafor',   '0x1111111111111111111111111111111111111111', 4200000, 'daily'),
  (2, 'Ben Strauss',  '0x2222222222222222222222222222222222222222', 3800000, 'daily'),
  (3, 'Carmen Diaz',  '0x3333333333333333333333333333333333333333', 5100000, 'daily');

INSERT INTO policies (id, per_run_cap_micro, hard_cap_micro, max_bonus_pct, min_pay_pct, allowlist) VALUES
  (1, 15000000, 30000000, 100, 75, json_array(
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222',
    '0x3333333333333333333333333333333333333333'
  ));
