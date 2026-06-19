// M1 readiness preflight. Live checks, no secrets leaked — hit this URL as you
// add each credential and watch it go green. It is also the demo's system view.

import { Hono } from 'hono';
import { arcKind, usdcAddressOf } from './seal';
import { sidecarHealth } from '../lib/signer';
import { readBalances } from './treasury';
import type { Env } from '../env';

export const statusApp = new Hono<{ Bindings: Env }>();

statusApp.get('/status', async (c) => {
  const env = c.env;

  // Is Arc live at the Circle Gateway facilitator right now?
  let arc: Record<string, unknown> = { supported: false };
  try {
    const kind = await arcKind();
    if (kind) {
      arc = {
        supported: true,
        network: kind.network,
        usdc: usdcAddressOf(kind),
        verifying_contract: kind.extra?.verifyingContract,
      };
    }
  } catch (err) {
    arc = { supported: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Config presence — booleans only, never the values.
  const config = {
    treasury_address: !!env.TREASURY_WALLET_ADDRESS,
    seal_fee_address: !!env.SEAL_FEE_ADDRESS,
    dynamic_key: !!env.DYNAMIC_API_KEY,
    unlink_key: !!env.UNLINK_API_KEY,
    treasury_unlink_mnemonic: !!env.TREASURY_UNLINK_MNEMONIC,
    signer_secret: !!env.SIGNER_SIDECAR_SECRET,
  };

  // Is the Dynamic signing container reachable? This wakes it if it's asleep.
  let sidecar: Record<string, unknown> = { configured: false };
  if (env.SIGNER_SIDECAR_SECRET) {
    try {
      const health = await sidecarHealth(env);
      sidecar = { configured: true, reachable: true, address: health.address };
    } catch (err) {
      sidecar = { configured: true, reachable: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Do employees have private (unlink) accounts to receive into?
  const counts = await env.DB.prepare(
    "SELECT COUNT(*) AS total, COUNT(unlink_address) AS with_unlink FROM employees"
  ).first<{ total: number; with_unlink: number }>();
  const employees = {
    total: counts?.total ?? 0,
    with_unlink_address: counts?.with_unlink ?? 0,
  };

  // Funding — real balances, so "ready" means money can actually move.
  const balances = await readBalances(env);
  const funding = {
    sealed_funded: balances.sealed.available === true && Number(balances.sealed.raw ?? 0) > 0,
    fees_funded: balances.fees.available === true && Number(balances.fees.raw ?? 0) > 0,
    sealed: balances.sealed.formatted ?? null,
    fees: balances.fees.formatted ?? null,
  };

  const m1_ready =
    arc.supported === true &&
    Object.values(config).every(Boolean) &&
    sidecar.reachable === true &&
    employees.total > 0 &&
    employees.with_unlink_address === employees.total &&
    funding.sealed_funded &&
    funding.fees_funded;

  return c.json({ m1_ready, arc, config, sidecar, employees, funding });
});
