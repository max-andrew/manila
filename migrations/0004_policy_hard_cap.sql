-- Two-tier treasury controls.
--   per_run_cap_micro  — SOFT gate: over it, a run needs a second signature.
--   hard_cap_micro     — HARD ceiling: a run over it is refused outright and
--                        cannot be approved, so no instruction ("max bonus",
--                        "10000% raise", …) can drain the treasury.
--   max_bonus_pct      — upper bound on the pay adjustment (overpay guard).
--   min_pay_pct        — lower bound, as a % of scheduled pay (underpay guard).
-- Allowlist violations and out-of-band / over-ceiling runs are REJECTED (not
-- approvable); only a soft per-run-cap breach goes to a second signature.
ALTER TABLE policies ADD COLUMN hard_cap_micro INTEGER NOT NULL DEFAULT 30000000;
ALTER TABLE policies ADD COLUMN max_bonus_pct INTEGER NOT NULL DEFAULT 100;
ALTER TABLE policies ADD COLUMN min_pay_pct INTEGER NOT NULL DEFAULT 75;
