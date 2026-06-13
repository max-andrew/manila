-- An ad-hoc payment the agent is asked to send to a specific address (e.g.
-- "send today's pay to 0x…"). Stored so the policy engine can check it against
-- the allowlist; an off-allowlist recipient is refused and never executes.
ALTER TABLE payroll_runs ADD COLUMN custom_recipient TEXT;
