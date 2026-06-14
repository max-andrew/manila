// Vesting — the on-chain, publicly verifiable disbursement path. Reads the
// deployed PayrollVault for any employee on a vesting plan, and lets the agent
// release vested USDC (signed by the Dynamic releaser in the sidecar).

import { Hono } from 'hono';
import { readVaultSchedule, resetVestingClock, vaultMeta, type VestingSchedule } from '../lib/vault';
import { explorerAddressUrl } from '../lib/arc';
import { audit } from '../lib/audit';
import type { Env } from '../env';

export const vestingApp = new Hono<{ Bindings: Env }>();

// Re-arm a schedule's clock so a slice is immediately releasable — the agent
// (Dynamic releaser) signs it. Keeps the release flow reliably demoable.
vestingApp.post('/vesting/reset', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const beneficiary = String(body.beneficiary ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(beneficiary)) return c.json({ error: 'valid beneficiary required' }, 400);
  try {
    const result = await resetVestingClock(c.env, beneficiary);
    await audit(c.env.DB, { actor: 'agent', action: result.reset ? 'vesting_clock_reset' : 'vesting_reset_failed', detail: { beneficiary, tx_hash: result.tx_hash, error: result.error } });
    return c.json(result, result.reset ? 200 : 502);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

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
