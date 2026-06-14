// Vesting — the on-chain, publicly verifiable disbursement path. Reads the
// deployed PayrollVault for any employee on a vesting plan, and lets the agent
// release vested USDC (signed by the Dynamic releaser in the sidecar).

import { Hono } from 'hono';
import { readVaultSchedule, vaultMeta, type VestingSchedule } from '../lib/vault';
import { explorerAddressUrl } from '../lib/arc';
import type { Env } from '../env';

export const vestingApp = new Hono<{ Bindings: Env }>();

type EmployeeVesting = VestingSchedule & { employee_id: number; name: string; beneficiary_url: string };

// Deployed contract metadata + every employee who has an on-chain schedule.
vestingApp.get('/vesting', async (c) => {
  const env = c.env;
  const { results } = await env.DB.prepare(
    'SELECT id, name, wallet FROM employees ORDER BY id'
  ).all<{ id: number; name: string; wallet: string }>();

  const schedules = (
    await Promise.all(
      results.map(async (e): Promise<EmployeeVesting | null> => {
        try {
          const s = await readVaultSchedule(env, e.wallet);
          if (!s) return null;
          return { employee_id: e.id, name: e.name, beneficiary_url: explorerAddressUrl(e.wallet), ...s };
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean) as EmployeeVesting[];

  return c.json({ vault: vaultMeta, releaser: env.TREASURY_WALLET_ADDRESS ?? null, schedules });
});
