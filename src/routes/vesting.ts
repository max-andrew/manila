// Vesting — the on-chain, publicly verifiable disbursement path. Reads the
// deployed PayrollVaultV3 for any employee with an RSU grant, and lets the agent
// release vested equity (settled in USDC, signed by the Dynamic releaser).

import { Hono } from 'hono';
import { readVaultSchedule, resetVestingClock, releaseVesting, readOraclePrice, vaultMeta, type VestingSchedule } from '../lib/vault';
import { explorerAddressUrl } from '../lib/arc';
import { audit } from '../lib/audit';
import type { Env } from '../env';

export const vestingApp = new Hono<{ Bindings: Env }>();

// Release vested equity for a beneficiary — the direct path the Release button
// uses (no LLM hop), signed by the Dynamic releaser. The chat command "release
// X's vested equity" still goes through the agent.
vestingApp.post('/vesting/release', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const beneficiary = String(body.beneficiary ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(beneficiary)) return c.json({ error: 'valid beneficiary required' }, 400);
  try {
    const result = await releaseVesting(c.env, beneficiary);
    await audit(c.env.DB, { actor: 'agent', action: result.released ? 'vesting_released' : 'vesting_release_failed', detail: { beneficiary, amount_micro: result.amount_micro, tx_hash: result.tx_hash, error: result.error } });
    return c.json(result, result.released ? 200 : 502);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

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

  const [schedulesRaw, oracle] = await Promise.all([
    Promise.all(
      results.map(async (e): Promise<EmployeeVesting | null> => {
        try {
          const s = await readVaultSchedule(env, e.wallet);
          if (!s) return null;
          return { employee_id: e.id, name: e.name, beneficiary_url: explorerAddressUrl(e.wallet), ...s };
        } catch {
          return null;
        }
      })
    ),
    readOraclePrice(env),
  ]);
  const schedules = schedulesRaw.filter(Boolean) as EmployeeVesting[];

  return c.json({ vault: vaultMeta, oracle, releaser: env.TREASURY_WALLET_ADDRESS ?? null, schedules });
});
