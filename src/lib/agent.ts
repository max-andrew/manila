// The agent brain. A single tool-use loop over Workers AI (no agent
// framework, no external LLM key — the model runs on Cloudflare's `AI`
// binding). The model is the router: it reads a plain-English instruction and
// decides which tools to call. The tools do the real work against D1 and the
// money path; the policy gate and the pass/review/reject branch are
// deterministic, so the demo is correct — and a control can't be talked past —
// regardless of how a smaller free model phrases things.

import { evaluatePolicy, loadPolicy, type PolicyResult } from './policy';
import { audit } from './audit';
import { microToUsd } from './arc';
import { executeRun } from '../routes/disburse';
import { readVaultSchedule, releaseVesting, type ReleaseResult } from './vault';
import type { Env } from '../env';

export const DEFAULT_AGENT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const SYSTEM_PROMPT = `You are the payroll agent for Manila — confidential USDC payroll that pays the team DAILY, not monthly. Gas-free nanopayments make per-day payroll practical.
Operate payroll by calling tools. Never invent amounts, names, addresses, or results — the tools read the real roster and policy from the database.

To run payroll (e.g. "run today's payroll", optionally "with a 10% bonus"):
1. Call draft_payroll_run with the period (default today), any bonus percentage, and optionally who to pay:
   - everyone: omit the people fields.
   - specific people ("pay just Ben Strauss"): set "only" to their names, e.g. ["Ben Strauss"].
   - all but some ("pay everyone but Ada"): set "except" to their names.
   - "pay everyone else" / the rest who haven't been paid yet today: set "unpaid_only" true.
   Match the names the user says to the current team listed below.
2. Call check_policy with the run_id.
3. If verdict is "pass", call execute_run. If "review", call request_approval — a human adds a second signature. If "rejected", stop — the run is refused.

To pay specific team members BY NAME ("pay Ben Strauss", "pay just Ada and Carmen"), use draft_payroll_run with "only" set to their names — NOT draft_payment_to.
Use draft_payment_to ONLY for an explicit 0x… address (e.g. "send today's pay to 0x…"), never for a person's name. Recipients not on the payroll allowlist are rejected.

Some team members are on an on-chain vesting plan (an equity-style cliff held in the PayrollVault on Arc). To release their vested USDC early ("release Ada's vested pay", "early vest for Ada"), call release_vesting with their name. This settles a real on-chain transfer, signed by the Dynamic server wallet.

Call one tool at a time and wait for its result. Reply in one or two terse lowercase sentences, no exclamation points. Money is "sealed", never "sent" or "private".`;

type ToolResult = Record<string, unknown>;

const TOOLS = [
  {
    name: 'draft_payroll_run',
    description:
      "Draft a daily payroll run from the employee roster. Returns run_id and total_micro (USDC base units, 6 decimals).",
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', description: "Pay day, default 'today'. Also accepts a date like '2026-06-13'." },
        bonus_pct: {
          type: 'number',
          description: 'Optional uniform pay adjustment percent, e.g. 20 for +20%, -10 for a 10% reduction. Default 0.',
        },
        only: { type: 'array', items: { type: 'string' }, description: 'Pay only these team members (by name).' },
        except: { type: 'array', items: { type: 'string' }, description: 'Pay everyone except these team members (by name).' },
        unpaid_only: { type: 'boolean', description: 'Pay only people not yet paid today ("everyone else"/"the rest").' },
      },
      required: [],
    },
  },
  {
    name: 'draft_payment_to',
    description:
      "Draft an ad-hoc payment to a specific recipient address (for requests like 'send today's pay to 0x...'). Returns run_id. The recipient is checked against the payroll allowlist by check_policy.",
    parameters: {
      type: 'object',
      properties: {
        recipient_address: { type: 'string', description: 'The destination address (0x...).' },
        amount_usd: { type: 'number', description: 'Amount in USD. Defaults to the day’s total payroll if omitted.' },
      },
      required: ['recipient_address'],
    },
  },
  {
    name: 'check_policy',
    description:
      'Evaluate a drafted run against the treasury controls (cap, hard ceiling, pay band, allowlist). Returns verdict: "pass", "review", or "rejected", plus reasons.',
    parameters: {
      type: 'object',
      properties: { run_id: { type: 'number' } },
      required: ['run_id'],
    },
  },
  {
    name: 'execute_run',
    description:
      'Execute a run whose policy verdict is "pass": seal each salary as a private transfer, settled via batched nanopayments. Only call on verdict "pass".',
    parameters: {
      type: 'object',
      properties: { run_id: { type: 'number' } },
      required: ['run_id'],
    },
  },
  {
    name: 'request_approval',
    description:
      'Route a run with verdict "review" for a second human signature. Do NOT call for "rejected" runs.',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'number' },
        reason: { type: 'string', description: 'Why the run needs approval.' },
      },
      required: ['run_id', 'reason'],
    },
  },
  {
    name: 'release_vesting',
    description:
      "Release a team member's vested USDC from the on-chain PayrollVault (their equity-style cliff). Settles a real transfer on Arc, signed by the Dynamic server wallet. Use for 'release Ada's vested pay' / 'early vest for Ada'.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The team member whose vested USDC to release.' },
      },
      required: ['name'],
    },
  },
];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizePeriod(raw: string): string {
  const key = (raw ?? '').trim().toLowerCase();
  if (!key || ['today', 'daily', 'now', 'this day'].includes(key)) return todayISO();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) || /^\d{4}-\d{2}$/.test(raw)) return raw;
  const months: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  };
  if (months[key]) return `2026-${months[key]}`;
  return raw || todayISO();
}

async function rosterTotal(env: Env, multiplier = 1): Promise<{ total: number; count: number }> {
  const { results } = await env.DB.prepare('SELECT salary_micro FROM employees').all<{ salary_micro: number }>();
  const total = results.reduce((sum, e) => sum + Math.round(e.salary_micro * multiplier), 0);
  return { total, count: results.length };
}

type Emp = { id: number; name: string; salary_micro: number };

function toNames(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(/,|\band\b/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function nameMatches(employeeName: string, query: string): boolean {
  const e = employeeName.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return false;
  return e === q || e.includes(q) || q.includes(e) || e.split(/\s+/).includes(q);
}

// Employees already sealed for this period (so "everyone else" can skip them,
// and a repeat run is held for confirmation). Time-aware: only payments sealed
// since the last demo reset count, so "Reset demo" un-gates a fresh run.
async function paidTodayIds(env: Env, period: string): Promise<Set<number>> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT p.employee_id AS id FROM payments p
       JOIN payroll_runs r ON p.run_id = r.id
      WHERE r.period = ? AND p.status = 'sealed'
        AND p.created_at > COALESCE((SELECT value FROM app_state WHERE key = 'reset_at'), '1970-01-01 00:00:00')`
  )
    .bind(period)
    .all<{ id: number }>();
  return new Set(results.map((r) => r.id));
}

async function draftPayrollRun(env: Env, args: ToolResult): Promise<ToolResult> {
  const period = normalizePeriod(String(args.period ?? 'today'));
  const bonusPct = Number(args.bonus_pct ?? 0) || 0;
  const multiplier = 1 + bonusPct / 100;

  const { results: roster } = await env.DB.prepare('SELECT id, name, salary_micro FROM employees ORDER BY id').all<Emp>();
  if (!roster.length) throw new Error('no employees on the roster');

  const only = toNames(args.only);
  const except = toNames(args.except);
  let selected = roster;
  if (only.length) selected = roster.filter((e) => only.some((n) => nameMatches(e.name, n)));
  else if (except.length) selected = roster.filter((e) => !except.some((n) => nameMatches(e.name, n)));
  if (args.unpaid_only) {
    const paid = await paidTodayIds(env, period);
    selected = selected.filter((e) => !paid.has(e.id));
  }
  if (!selected.length) throw new Error('no matching team members to pay');

  const total = selected.reduce((sum, e) => sum + Math.round(e.salary_micro * multiplier), 0);
  const subset = selected.length < roster.length;
  const employeeIds = subset ? JSON.stringify(selected.map((e) => e.id)) : null;
  const names = selected.map((e) => e.name);
  const note =
    [bonusPct ? `${bonusPct > 0 ? '+' : ''}${bonusPct}%` : '', subset ? names.join(', ') : ''].filter(Boolean).join(' · ') || null;

  const run = await env.DB.prepare(
    "INSERT INTO payroll_runs (period, status, amount_multiplier, total_micro, requested_by, note, employee_ids) VALUES (?, 'draft', ?, ?, 'agent', ?, ?) RETURNING id"
  )
    .bind(period, multiplier, total, note, employeeIds)
    .first<{ id: number }>();
  if (!run) throw new Error('failed to create run');

  await audit(env.DB, {
    actor: 'agent',
    action: 'run_drafted',
    run_id: run.id,
    detail: { period, bonus_pct: bonusPct, employees: names, total_micro: total },
  });
  return { run_id: run.id, period, employee_count: selected.length, employee_names: names, bonus_pct: bonusPct, total_micro: total, total_usd: microToUsd(total) };
}

async function draftPaymentTo(env: Env, args: ToolResult): Promise<ToolResult> {
  const recipient = String(args.recipient_address ?? '').trim();
  if (!recipient) throw new Error('recipient_address required');

  // "Pay Ben Strauss" is a team member, not an ad-hoc address. The model
  // sometimes routes a name here — redirect it to a subset payroll run so it
  // pays their salary instead of refusing an un-allowlisted "address".
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    const { results: roster } = await env.DB.prepare(
      'SELECT id, name, salary_micro FROM employees ORDER BY id'
    ).all<Emp>();
    const matched = roster.filter((e) => nameMatches(e.name, recipient));
    if (matched.length) return draftPayrollRun(env, { period: 'today', only: matched.map((e) => e.name) });
    throw new Error(`"${recipient}" is not a 0x address or a team member`);
  }

  const amountMicro =
    args.amount_usd != null ? Math.round(Number(args.amount_usd) * 1e6) : (await rosterTotal(env)).total;

  const run = await env.DB.prepare(
    "INSERT INTO payroll_runs (period, status, amount_multiplier, total_micro, requested_by, note, custom_recipient) VALUES (?, 'draft', 1.0, ?, 'agent', ?, ?) RETURNING id"
  )
    .bind(normalizePeriod('today'), amountMicro, `ad-hoc payment to ${recipient}`, recipient)
    .first<{ id: number }>();
  if (!run) throw new Error('failed to create run');

  await audit(env.DB, {
    actor: 'agent',
    action: 'payment_drafted',
    run_id: run.id,
    detail: { recipient, total_micro: amountMicro },
  });
  return { run_id: run.id, recipient, total_micro: amountMicro, total_usd: microToUsd(amountMicro) };
}

async function checkPolicy(env: Env, args: ToolResult): Promise<ToolResult> {
  const runId = Number(args.run_id);
  const run = await env.DB.prepare(
    'SELECT total_micro, amount_multiplier, custom_recipient FROM payroll_runs WHERE id = ?'
  )
    .bind(runId)
    .first<{ total_micro: number; amount_multiplier: number; custom_recipient: string | null }>();
  if (!run) throw new Error(`run ${runId} not found`);

  let recipients: string[];
  let bonusPct: number;
  if (run.custom_recipient) {
    recipients = [run.custom_recipient];
    bonusPct = 0;
  } else {
    const { results } = await env.DB.prepare('SELECT wallet FROM employees').all<{ wallet: string }>();
    recipients = results.map((e) => e.wallet);
    bonusPct = Math.round((Number(run.amount_multiplier) - 1) * 100);
  }

  const policy = await loadPolicy(env);
  const result = evaluatePolicy(Number(run.total_micro), bonusPct, recipients, policy);

  await env.DB.prepare('UPDATE payroll_runs SET policy_result = ? WHERE id = ?')
    .bind(JSON.stringify(result), runId)
    .run();
  await audit(env.DB, {
    actor: 'agent',
    action: 'policy_check',
    run_id: runId,
    detail: result,
    policy_result: result.verdict === 'pass' ? 'pass' : 'blocked',
  });
  return { run_id: runId, ...result };
}

export async function setExecutingAndRun(env: Env, runId: number) {
  await env.DB.prepare("UPDATE payroll_runs SET status = 'executing', updated_at = datetime('now') WHERE id = ?")
    .bind(runId)
    .run();
  return executeRun(env, runId);
}

// Already-paid guard: a run is a duplicate only if everyone it targets has
// already been sealed today. (So "pay just Ben" then "pay everyone else" both
// go through; running the same set twice is held for confirmation.)
async function runEmployeeIds(env: Env, runId: number): Promise<number[]> {
  const run = await env.DB.prepare('SELECT employee_ids FROM payroll_runs WHERE id = ?')
    .bind(runId)
    .first<{ employee_ids: string | null }>();
  if (run?.employee_ids) return JSON.parse(run.employee_ids) as number[];
  const { results } = await env.DB.prepare('SELECT id FROM employees').all<{ id: number }>();
  return results.map((r) => r.id);
}

async function alreadyPaid(env: Env, runId: number, period: string): Promise<boolean> {
  const ids = await runEmployeeIds(env, runId);
  if (!ids.length) return false;
  const paid = await paidTodayIds(env, period);
  return ids.every((id) => paid.has(id));
}

async function executeRunTool(env: Env, args: ToolResult): Promise<ToolResult> {
  const runId = Number(args.run_id);
  const run = await env.DB.prepare('SELECT period, policy_result, custom_recipient FROM payroll_runs WHERE id = ?')
    .bind(runId)
    .first<{ period: string; policy_result: string | null; custom_recipient: string | null }>();
  if (!run) throw new Error(`run ${runId} not found`);
  const policy = run.policy_result ? (JSON.parse(run.policy_result) as PolicyResult) : null;
  if (policy?.verdict !== 'pass') {
    return { run_id: runId, executed: false, error: `verdict is ${policy?.verdict ?? 'unknown'}; do not execute` };
  }
  if (run.custom_recipient) {
    return { run_id: runId, executed: false, error: 'ad-hoc payments are not auto-executed' };
  }
  if (await alreadyPaid(env, runId, run.period)) {
    await requestApproval(env, { run_id: runId, reason: `this group was already sealed today — confirm to pay again` });
    return { run_id: runId, executed: false, status: 'pending_approval', reason: 'already paid; held for confirmation' };
  }
  const result = await setExecutingAndRun(env, runId);
  return { run_id: runId, executed: true, ...result };
}

async function requestApproval(env: Env, args: ToolResult): Promise<ToolResult> {
  const runId = Number(args.run_id);
  const reason = String(args.reason ?? 'over the per-run cap');
  await env.DB.prepare(
    "UPDATE payroll_runs SET status = 'pending_approval', updated_at = datetime('now') WHERE id = ?"
  )
    .bind(runId)
    .run();
  await audit(env.DB, { actor: 'agent', action: 'approval_requested', run_id: runId, detail: { reason }, policy_result: 'blocked' });
  return { run_id: runId, status: 'pending_approval', message: `Held for a second signature: ${reason}` };
}

async function rejectRun(env: Env, runId: number, reason: string): Promise<void> {
  await env.DB.prepare("UPDATE payroll_runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?")
    .bind(runId)
    .run();
  await audit(env.DB, { actor: 'agent', action: 'policy_rejected', run_id: runId, detail: { reason }, policy_result: 'blocked' });
}

// Release vested USDC from the on-chain vault for a named team member. This is
// a terminal action (no draft/policy branch) — it settles immediately on Arc.
async function releaseVestingTool(env: Env, args: ToolResult): Promise<ToolResult> {
  const query = String(args.name ?? args.beneficiary ?? '').trim();
  if (!query) throw new Error('which team member?');
  const { results: roster } = await env.DB.prepare('SELECT id, name, wallet FROM employees ORDER BY id')
    .all<{ id: number; name: string; wallet: string }>();
  const emp = roster.find((e) => nameMatches(e.name, query));
  if (!emp) throw new Error(`no team member matches "${query}"`);

  const schedule = await readVaultSchedule(env, emp.wallet);
  if (!schedule) {
    return { released: false, name: emp.name, error: `${emp.name} has no on-chain vesting schedule` };
  }

  let result: ReleaseResult;
  try {
    result = await releaseVesting(env, emp.wallet);
  } catch (err) {
    result = { released: false, beneficiary: emp.wallet, error: err instanceof Error ? err.message : String(err) };
  }
  await audit(env.DB, {
    actor: 'agent',
    action: result.released ? 'vesting_released' : 'vesting_release_failed',
    detail: { employee_id: emp.id, name: emp.name, amount_micro: result.amount_micro, tx_hash: result.tx_hash, error: result.error },
  });
  return { ...result, name: emp.name, employee_id: emp.id };
}

async function dispatch(env: Env, name: string, args: ToolResult): Promise<ToolResult> {
  switch (name) {
    case 'draft_payroll_run': return draftPayrollRun(env, args);
    case 'draft_payment_to': return draftPaymentTo(env, args);
    case 'check_policy': return checkPolicy(env, args);
    case 'execute_run': return executeRunTool(env, args);
    case 'request_approval': return requestApproval(env, args);
    case 'release_vesting': return releaseVestingTool(env, args);
    default: return { error: `unknown tool ${name}` };
  }
}

// Workers AI occasionally returns a transient 504; retry once before failing.
async function aiRun(env: Env, model: string, body: unknown): Promise<any> {
  try {
    return await (env.AI as any).run(model, body);
  } catch {
    return await (env.AI as any).run(model, body);
  }
}

function parseArgs(raw: unknown): ToolResult {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return (raw as ToolResult) ?? {};
}

export type AgentOutcome = {
  reply: string;
  run_id: number | null;
  tools_called: string[];
  run?: Record<string, unknown>;
};

export async function runAgent(env: Env, instruction: string): Promise<AgentOutcome> {
  const model = env.AGENT_MODEL || DEFAULT_AGENT_MODEL;
  const { results: roster } = await env.DB.prepare('SELECT name FROM employees ORDER BY id').all<{ name: string }>();
  const rosterNames = roster.map((r) => r.name);
  // Give the model the live control band so it can reason about requests like
  // "the maximally acceptable bonus" (= the policy's max) without guessing.
  const policy = await loadPolicy(env);
  const controls =
    `Controls — pay band ${policy.min_pay_pct}% to +${policy.max_bonus_pct}% (a request outside this is refused); ` +
    `per-run cap $${Math.round(policy.per_run_cap_micro / 1e6)} (over needs a second signature); ` +
    `hard ceiling $${Math.round(policy.hard_cap_micro / 1e6)}. ` +
    `The "maximally acceptable bonus" is +${policy.max_bonus_pct}%.`;
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\nCurrent team: ${rosterNames.join(', ') || '(none)'}.\n${controls}` },
    { role: 'user', content: instruction },
  ];
  const toolsCalled: string[] = [];
  const completed = new Set<string>();
  let lastRunId: number | null = null;
  let vesting: ToolResult | null = null; // a release_vesting result (terminal)
  let reply = '';
  let repeated = false;

  for (let i = 0; i < 5 && !repeated; i++) {
    const resp: any = await aiRun(env, model, { messages, tools: TOOLS });
    const toolCalls: any[] = resp?.tool_calls ?? [];

    if (!toolCalls.length) break; // model produced no action — fall through to the deterministic parse

    messages.push({ role: 'assistant', content: resp?.response ?? '', tool_calls: toolCalls });
    for (const call of toolCalls) {
      const name = call.name ?? call.function?.name;
      if (completed.has(name)) { repeated = true; break; }
      completed.add(name);

      const args = parseArgs(call.arguments ?? call.function?.arguments);
      let result: ToolResult;
      try {
        result = await dispatch(env, name, args);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      toolsCalled.push(name);
      if (typeof result.run_id === 'number') lastRunId = result.run_id;
      if (name === 'release_vesting') { vesting = result; repeated = true; break; }
      messages.push({ role: 'tool', name, content: JSON.stringify(result) });
    }
    // Once a run is drafted, the deterministic engine finishes it (policy +
    // execute/approve/reject). No need for more model round-trips — break here
    // so the agent answers after a single inference instead of looping.
    if (lastRunId != null) break;
  }

  // Deterministic fallback: the free model can occasionally return degenerate
  // output with no usable tool call. The command set is small, so parse the
  // instruction ourselves — the agent always acts correctly and never echoes
  // model garbage back to the user.
  if (lastRunId == null && vesting == null) {
    const intent = parseIntent(instruction, rosterNames, policy.max_bonus_pct);
    if (intent) {
      try {
        const result = await dispatch(env, intent.tool, intent.args);
        if (intent.tool === 'release_vesting') {
          vesting = result;
          toolsCalled.push(`${intent.tool} (fallback)`);
        } else if (typeof result.run_id === 'number') {
          lastRunId = result.run_id;
          toolsCalled.push(`${intent.tool} (fallback)`);
        }
      } catch { /* fall through to the help message */ }
    }
  }

  // A vesting release is terminal — reply from its on-chain outcome.
  if (vesting) {
    return { reply: vestingReply(vesting), run_id: null, tools_called: toolsCalled, run: vesting };
  }

  // Deterministic gate: finish whatever was drafted along the correct branch.
  let run: Record<string, unknown> | undefined;
  if (lastRunId != null) {
    run = await finalizeRun(env, lastRunId);
    if (run) reply = deterministicReply(run);
  }
  if (!reply) reply = 'I can run payroll or pay a specific address. Try “run today’s payroll”, “…with a 25% bonus”, or “send today’s pay to 0x…”.';
  return { reply, run_id: lastRunId, tools_called: toolsCalled, run };
}

// Last-resort intent parser for when the model fails to emit a tool call.
function parseIntent(instruction: string, rosterNames: string[] = [], maxBonusPct = 0): { tool: string; args: ToolResult } | null {
  const text = instruction.toLowerCase();
  const addr = instruction.match(/0x[0-9a-fA-F]{40}/);
  if (addr && /\b(send|pay|transfer|to|wallet|address)\b/.test(text)) {
    return { tool: 'draft_payment_to', args: { recipient_address: addr[0] } };
  }
  // Vesting release ("release Ada's vested pay", "early vest for Ada") — checked
  // before payroll so the word "pay" in the phrasing doesn't misroute it.
  if (/\b(vest|vested|vesting|cliff)\b/.test(text) || /\brelease\b/.test(text)) {
    const who = rosterNames.find((n) =>
      n.toLowerCase().split(/\s+/).some((part) => new RegExp(`\\b${part}\\b`).test(text)) || text.includes(n.toLowerCase())
    );
    if (who) return { tool: 'release_vesting', args: { name: who } };
  }
  if (/payroll|salar|\bpay\b|\brun\b/.test(text)) {
    const m = text.match(/(-?\d+(?:\.\d+)?)\s*%/);
    let bonus = m ? Number(m[1]) : 0;
    // "the maximally acceptable bonus" / "max allowed bonus" → the policy ceiling.
    if (!m && /\bmax(?:imal|imum|imally)?\b/.test(text) && /bonus/.test(text)) bonus = maxBonusPct;
    if (bonus > 0 && /\b(reduce|cut|lower|less|decrease|dock|drop)\b/.test(text)) bonus = -bonus;
    const args: ToolResult = { period: 'today', bonus_pct: bonus };
    if (/everyone else|everybody else|the rest|remaining|the others/.test(text)) {
      args.unpaid_only = true;
    } else {
      const mentioned = rosterNames.filter((n) =>
        n.toLowerCase().split(/\s+/).some((part) => new RegExp(`\\b${part}\\b`).test(text)) || text.includes(n.toLowerCase())
      );
      if (mentioned.length && mentioned.length < rosterNames.length) {
        if (/\b(except|but|besides|other than|aside from)\b/.test(text)) args.except = mentioned;
        else args.only = mentioned;
      }
    }
    return { tool: 'draft_payroll_run', args };
  }
  return null;
}

async function finalizeRun(env: Env, runId: number): Promise<Record<string, unknown> | undefined> {
  const row = await env.DB.prepare('SELECT period, status, policy_result, custom_recipient FROM payroll_runs WHERE id = ?')
    .bind(runId)
    .first<{ period: string; status: string; policy_result: string | null; custom_recipient: string | null }>();
  if (!row) return undefined;

  if (row.status === 'draft') {
    if (!row.policy_result) await checkPolicy(env, { run_id: runId });
    const after = await env.DB.prepare('SELECT policy_result FROM payroll_runs WHERE id = ?')
      .bind(runId)
      .first<{ policy_result: string | null }>();
    const policy: PolicyResult | null = after?.policy_result ? JSON.parse(after.policy_result) : null;
    const reason = policy?.reasons?.[0] ?? 'policy';
    if (policy?.verdict === 'pass' && !row.custom_recipient) {
      if (await alreadyPaid(env, runId, row.period)) {
        await requestApproval(env, { run_id: runId, reason: `this group was already sealed today — confirm to pay again` });
      } else {
        await setExecutingAndRun(env, runId);
      }
    } else if (policy?.verdict === 'pass') {
      // ad-hoc payment to an allowed address — not on the auto-seal path.
      await rejectRun(env, runId, 'ad-hoc payments are not auto-executed');
    } else if (policy?.verdict === 'review') {
      await requestApproval(env, { run_id: runId, reason });
    } else {
      await rejectRun(env, runId, reason);
    }
  }

  const run =
    (await env.DB.prepare(
      'SELECT id, period, status, total_micro, amount_multiplier, note, policy_result, custom_recipient, employee_ids FROM payroll_runs WHERE id = ?'
    )
      .bind(runId)
      .first<Record<string, unknown>>()) ?? undefined;
  // Resolve the names of a subset run, for a name-aware reply.
  if (run && run.employee_ids) {
    const ids = JSON.parse(String(run.employee_ids)) as number[];
    const { results } = await env.DB.prepare(
      `SELECT name FROM employees WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`
    )
      .bind(...ids)
      .all<{ name: string }>();
    run.employee_names = results.map((r) => r.name);
  }
  return run;
}

function vestingReply(v: ToolResult): string {
  const name = String(v.name ?? 'the beneficiary');
  if (v.released) return `released ${v.amount_usd} of vested USDC to ${name} on-chain, signed by the dynamic wallet.`;
  return `couldn't release for ${name} — ${v.error ?? 'no vested amount available'}.`;
}

function deterministicReply(run: Record<string, unknown>): string {
  const status = String(run.status);
  const total = Number(run.total_micro);
  const policy: PolicyResult | null = run.policy_result ? JSON.parse(String(run.policy_result)) : null;
  const names = run.employee_names as string[] | undefined;
  const who = Array.isArray(names) && names.length ? ` to ${names.join(' and ')}` : ' across the roster';

  if (status === 'sealed') return `Sealed. ${microToUsd(total)}${who}.`;
  if (status === 'pending_approval') {
    // A passing run held for approval = already paid today (double-pay guard);
    // otherwise it's an over-cap run awaiting a second signature.
    if (policy?.verdict === 'pass') return `Today's payroll was already sealed — held for confirmation. Approve to pay again.`;
    return `Held for a second signature — ${policy?.reasons?.[0] ?? `run ${run.id} is over the cap`}.`;
  }
  if (status === 'failed') {
    if (policy && policy.verdict === 'rejected') return `Refused. ${policy.reasons[0] ?? 'blocked by policy'}.`;
    return `Run ${run.id} did not complete — see the audit log.`;
  }
  return `Run ${run.id} drafted at ${microToUsd(total)}.`;
}
