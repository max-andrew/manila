-- Seed data. Wallets are placeholders until M1 provisions real Arc testnet
-- accounts (they get UPDATEd then; nothing in app code depends on these values).
-- Demo-scale amounts: the Arc faucet grants 20 USDC per address per 2h and all
-- transactions are real, so salaries are dollars, not thousands.
-- Total per run: $13.10. Cap: $15.00 — a plain monthly run passes policy,
-- a 20% bonus run ($15.72) or an off-allowlist recipient goes to PENDING APPROVAL.

DELETE FROM employees;
DELETE FROM policies;

INSERT INTO employees (id, name, wallet, salary_micro, schedule) VALUES
  (1, 'Ada Okafor',   '0x1111111111111111111111111111111111111111', 4200000, 'monthly'),
  (2, 'Ben Strauss',  '0x2222222222222222222222222222222222222222', 3800000, 'monthly'),
  (3, 'Carmen Diaz',  '0x3333333333333333333333333333333333333333', 5100000, 'monthly');

INSERT INTO policies (id, per_run_cap_micro, allowlist) VALUES
  (1, 15000000, json_array(
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222',
    '0x3333333333333333333333333333333333333333'
  ));
