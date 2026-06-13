// Live treasury balances — read straight from chain/engine, never cached or
// seeded. The sealed payroll balance is the Unlink private balance; the fee
// balance is the treasury's Gateway balance for x402 nanopayments.

import { Hono } from 'hono';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { generatePrivateKey } from 'viem/accounts';
import { treasuryUnlinkClient } from '../lib/unlink';
import { ARC_USDC_ADDRESS } from '../lib/arc';
import type { Env } from '../env';

export const treasuryApp = new Hono<{ Bindings: Env }>();

treasuryApp.get('/treasury', async (c) => {
  const env = c.env;
  const token = (env.UNLINK_TOKEN_ADDRESS || ARC_USDC_ADDRESS).toLowerCase();
  const decimals = Number(env.UNLINK_TOKEN_DECIMALS || '6');

  const fmt = (raw: string | bigint, d: number) => {
    const n = Number(raw) / 10 ** d;
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Sealed payroll balance — the Unlink private pool.
  let sealed: Record<string, unknown> = { available: false };
  try {
    const client = treasuryUnlinkClient(env);
    await client.ensureRegistered();
    const { balances } = await client.getBalances();
    const entry = (balances as Array<{ token: string; amount: string }>).find(
      (b) => b.token.toLowerCase() === token
    );
    const raw = entry?.amount ?? '0';
    sealed = { available: true, raw, formatted: fmt(raw, decimals), symbol: 'USDC' };
  } catch (err) {
    sealed = { available: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Fee balance — the treasury's Gateway nanopayment balance (native USDC).
  let fees: Record<string, unknown> = { available: false };
  try {
    if (env.TREASURY_WALLET_ADDRESS) {
      const gw = new GatewayClient({ chain: 'arcTestnet', privateKey: generatePrivateKey() });
      const balances = await gw.getBalances(env.TREASURY_WALLET_ADDRESS as `0x${string}`);
      const raw = String((balances as any)?.gateway?.available ?? '0');
      fees = { available: true, raw, formatted: fmt(raw, 6), symbol: 'USDC' };
    }
  } catch (err) {
    fees = { available: false, error: err instanceof Error ? err.message : String(err) };
  }

  return c.json({ treasury_address: env.TREASURY_WALLET_ADDRESS ?? null, sealed, fees });
});
