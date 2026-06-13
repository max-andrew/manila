-- A run can carry a uniform adjustment (e.g. an end-of-quarter bonus) the
-- agent drafts from plain English. Amounts stay real: every payment is
-- round(salary_micro * amount_multiplier), so draft → policy → settle agree.
ALTER TABLE payroll_runs ADD COLUMN amount_multiplier REAL NOT NULL DEFAULT 1.0;
ALTER TABLE payroll_runs ADD COLUMN note TEXT;
