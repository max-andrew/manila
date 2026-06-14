-- A run can target a subset of the roster ("pay just Ben", "pay everyone else").
-- JSON array of employee ids; NULL means the whole team.
ALTER TABLE payroll_runs ADD COLUMN employee_ids TEXT;
