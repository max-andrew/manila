// Policy engine. Two rules, on purpose: a per-run cap and a recipient
// allowlist. A run that clears both executes; a run that trips either halts
// for a second signature (maker-checker). Resist adding rules — the restraint
// is the point.

import type { Env } from '../env';

export type PolicyResult = {
  pass: boolean;
  cap_ok: boolean;
  allowlist_ok: boolean;
  per_run_cap_micro: number;
  total_micro: number;
  off_allowlist: string[];
  reasons: string[];
};

export async function loadPolicy(
  env: Env
): Promise<{ per_run_cap_micro: number; allowlist: string[] }> {
  const row = await env.DB.prepare(
    'SELECT per_run_cap_micro, allowlist FROM policies WHERE id = 1'
  ).first<{ per_run_cap_micro: number; allowlist: string }>();
  if (!row) throw new Error('no policy configured');
  return {
    per_run_cap_micro: Number(row.per_run_cap_micro),
    allowlist: JSON.parse(row.allowlist) as string[],
  };
}

export function evaluatePolicy(
  total_micro: number,
  recipientWallets: string[],
  policy: { per_run_cap_micro: number; allowlist: string[] }
): PolicyResult {
  const allow = new Set(policy.allowlist.map((a) => a.toLowerCase()));
  const off_allowlist = recipientWallets.filter((w) => !allow.has(w.toLowerCase()));

  const cap_ok = total_micro <= policy.per_run_cap_micro;
  const allowlist_ok = off_allowlist.length === 0;
  const reasons: string[] = [];
  if (!cap_ok) {
    reasons.push(
      `run total ${usd(total_micro)} exceeds per-run cap ${usd(policy.per_run_cap_micro)}`
    );
  }
  if (!allowlist_ok) {
    reasons.push(`${off_allowlist.length} recipient(s) not on the allowlist`);
  }

  return {
    pass: cap_ok && allowlist_ok,
    cap_ok,
    allowlist_ok,
    per_run_cap_micro: policy.per_run_cap_micro,
    total_micro,
    off_allowlist,
    reasons,
  };
}

const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`;
