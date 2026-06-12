-- Employees receive salary at their Unlink private (unlink1...) address.
-- The EVM wallet column remains for allowlist policy + any public-leg use.
ALTER TABLE employees ADD COLUMN unlink_address TEXT;
