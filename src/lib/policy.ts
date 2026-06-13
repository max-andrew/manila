// Policy engine. Deterministic treasury controls — the LLM proposes, this
// decides. Three outcomes:
//   pass     — clears every rule → execute.
//   review   — only the soft per-run cap is exceeded → second signature.
//   rejected — an allowlist violation, the hard ceiling, or out-of-band pay →
//              refused outright; not even approval can release it, so no
//              instruction can drain the treasury or redirect funds.

import type { Env } from '../env';

export type PolicyVerdict = 'pass' | 'review' | 'rejected';

export type Policy = {
  per_run_cap_micro: number;
  hard_cap_micro: number;
  max_bonus_pct: number;
  min_pay_pct: number;
  allowlist: string[];
};

export type PolicyResult = {
  verdict: PolicyVerdict;
  pass: boolean; // back-compat: pass === verdict === 'pass'
  cap_ok: boolean;
  hard_cap_ok: boolean;
  allowlist_ok: boolean;
  bonus_ok: boolean;
  per_run_cap_micro: number;
  hard_cap_micro: number;
  max_bonus_pct: number;
  min_pay_pct: number;
  total_micro: number;
  bonus_pct: number;
  off_allowlist: string[];
  reasons: string[];
};

export async function loadPolicy(env: Env): Promise<Policy> {
  const row = await env.DB.prepare(
    'SELECT per_run_cap_micro, hard_cap_micro, max_bonus_pct, min_pay_pct, allowlist FROM policies WHERE id = 1'
  ).first<{
    per_run_cap_micro: number;
    hard_cap_micro: number;
    max_bonus_pct: number;
    min_pay_pct: number;
    allowlist: string;
  }>();
  if (!row) throw new Error('no policy configured');
  return {
    per_run_cap_micro: Number(row.per_run_cap_micro),
    hard_cap_micro: Number(row.hard_cap_micro),
    max_bonus_pct: Number(row.max_bonus_pct),
    min_pay_pct: Number(row.min_pay_pct),
    allowlist: JSON.parse(row.allowlist) as string[],
  };
}

export function evaluatePolicy(
  total_micro: number,
  bonus_pct: number,
  recipients: string[],
  policy: Policy
): PolicyResult {
  const allow = new Set(policy.allowlist.map((a) => a.toLowerCase()));
  const off_allowlist = recipients.filter((w) => !allow.has(w.toLowerCase()));
  const allowlist_ok = off_allowlist.length === 0;
  const cap_ok = total_micro <= policy.per_run_cap_micro;
  const hard_cap_ok = total_micro <= policy.hard_cap_micro;
  const bonus_floor = -(100 - policy.min_pay_pct); // min_pay_pct 75 → floor -25%
  const bonus_ok = bonus_pct <= policy.max_bonus_pct && bonus_pct >= bonus_floor;

  const reasons: string[] = [];
  if (!allowlist_ok) reasons.push(`recipient ${shortAddr(off_allowlist[0])} is not on the payroll allowlist`);
  if (!hard_cap_ok) reasons.push(`total ${usd(total_micro)} exceeds the hard ceiling ${usd(policy.hard_cap_micro)}`);
  if (!bonus_ok && bonus_pct > policy.max_bonus_pct) reasons.push(`+${bonus_pct}% exceeds the +${policy.max_bonus_pct}% pay limit`);
  if (!bonus_ok && bonus_pct < bonus_floor) reasons.push(`${bonus_pct}% underpays below the ${policy.min_pay_pct}% floor`);
  if (allowlist_ok && hard_cap_ok && bonus_ok && !cap_ok)
    reasons.push(`total ${usd(total_micro)} exceeds the per-run cap ${usd(policy.per_run_cap_micro)}`);

  let verdict: PolicyVerdict;
  if (!allowlist_ok || !hard_cap_ok || !bonus_ok) verdict = 'rejected';
  else if (!cap_ok) verdict = 'review';
  else verdict = 'pass';

  return {
    verdict,
    pass: verdict === 'pass',
    cap_ok,
    hard_cap_ok,
    allowlist_ok,
    bonus_ok,
    per_run_cap_micro: policy.per_run_cap_micro,
    hard_cap_micro: policy.hard_cap_micro,
    max_bonus_pct: policy.max_bonus_pct,
    min_pay_pct: policy.min_pay_pct,
    total_micro,
    bonus_pct,
    off_allowlist,
    reasons,
  };
}

const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`;
const shortAddr = (a: string) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
