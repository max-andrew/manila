// Treasury controls — read and update the policy the agent operates under.
// The allowlist is managed via the team roster (employees), so it's read-only
// here; the numeric limits are editable.

import { Hono } from 'hono';
import { audit } from '../lib/audit';
import type { Env } from '../env';

export const policyApp = new Hono<{ Bindings: Env }>();

policyApp.get('/policy', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT per_run_cap_micro, hard_cap_micro, max_bonus_pct, min_pay_pct, allowlist FROM policies WHERE id = 1'
  ).first<{
    per_run_cap_micro: number;
    hard_cap_micro: number;
    max_bonus_pct: number;
    min_pay_pct: number;
    allowlist: string;
  }>();
  if (!row) return c.json({ error: 'no policy configured' }, 500);
  return c.json({
    per_run_cap_micro: Number(row.per_run_cap_micro),
    hard_cap_micro: Number(row.hard_cap_micro),
    max_bonus_pct: Number(row.max_bonus_pct),
    min_pay_pct: Number(row.min_pay_pct),
    allowlist: JSON.parse(row.allowlist) as string[],
  });
});

policyApp.patch('/policy', async (c) => {
  const env = c.env;
  const body = await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const binds: unknown[] = [];
  const num = (v: unknown) => (v == null ? null : Number(v));

  const cap = num(body.per_run_cap_usd);
  const hard = num(body.hard_cap_usd);
  // Caps are set in whole dollars.
  if (cap != null && cap >= 0) { sets.push('per_run_cap_micro = ?'); binds.push(Math.round(cap) * 1_000_000); }
  if (hard != null && hard >= 0) { sets.push('hard_cap_micro = ?'); binds.push(Math.round(hard) * 1_000_000); }
  const maxB = num(body.max_bonus_pct);
  const minP = num(body.min_pay_pct);
  if (maxB != null && maxB >= 0) { sets.push('max_bonus_pct = ?'); binds.push(Math.round(maxB)); }
  if (minP != null && minP >= 0 && minP <= 100) { sets.push('min_pay_pct = ?'); binds.push(Math.round(minP)); }

  if (!sets.length) return c.json({ error: 'nothing to update' }, 400);
  // The hard ceiling must sit at or above the soft cap, or "review" is unreachable.
  if (cap != null && hard != null && hard < cap) {
    return c.json({ error: 'hard ceiling must be ≥ the per-run cap' }, 400);
  }

  await env.DB.prepare(`UPDATE policies SET ${sets.join(', ')} WHERE id = 1`).bind(...binds).run();
  await audit(env.DB, { actor: 'employer', action: 'policy_updated', detail: body });
  return c.json({ updated: true });
});
