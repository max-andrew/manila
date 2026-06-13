// The agent brain. A single tool-use loop over Workers AI (no agent
// framework, no external LLM key — the model runs on Cloudflare's `AI`
// binding). The model is the router: it reads a plain-English instruction and
// decides which tools to call, in order. The tools do the real work against
// D1 and the M1 money path; the route derives the user-facing outcome from
// what the tools actually did, so the demo is correct even if a smaller free
// model phrases its reply loosely.

import { evaluatePolicy, loadPolicy } from './policy';
import { audit } from './audit';
import { microToUsd } from './arc';
import { executeRun } from '../routes/disburse';
import type { Env } from '../env';

export const DEFAULT_AGENT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const SYSTEM_PROMPT = `You are the payroll agent for Manila, a confidential USDC payroll system.
You operate the company's payroll by calling tools. Never invent amounts, names, or results — the tools read the real employee roster and policy from the database.

For an instruction like "run June payroll" (optionally "with a 10% bonus"):
1. Call draft_payroll_run with the period and any bonus percentage.
2. Call check_policy with the returned run_id.
3. If the policy result pass is true, call execute_run with the run_id.
4. If pass is false, call request_approval with the run_id and a short reason — do NOT execute. A human adds the second signature.

Call one tool at a time and wait for its result. When finished, reply in one or two terse sentences, lowercase, no exclamation points. Money is sealed, never "sent" or "private".`;

type ToolResult = Record<string, unknown>;

const TOOLS = [
  {
    name: 'draft_payroll_run',
    description:
      'Draft a payroll run from the employee roster in the database. Returns run_id, employee_count and total_micro (USDC base units, 6 decimals).',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', description: "Pay period, e.g. '2026-06' or 'June'." },
        bonus_pct: {
          type: 'number',
          description: 'Optional uniform bonus percentage applied to every salary, e.g. 20 for +20%. Default 0.',
        },
      },
      required: ['period'],
    },
  },
  {
    name: 'check_policy',
    description:
      'Evaluate a drafted run against the per-run cap and recipient allowlist. Returns pass (boolean) and reasons.',
    parameters: {
      type: 'object',
      properties: { run_id: { type: 'number' } },
      required: ['run_id'],
    },
  },
  {
    name: 'execute_run',
    description:
      'Execute a run whose policy check passed: seal each salary as a private transfer, settled via batched nanopayments. Only call when check_policy returned pass true.',
    parameters: {
      type: 'object',
      properties: { run_id: { type: 'number' } },
      required: ['run_id'],
    },
  },
  {
    name: 'request_approval',
    description:
      'Halt a run that failed policy and route it for a second human signature. Call this instead of execute_run when check_policy returned pass false.',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'number' },
        reason: { type: 'string', description: 'Why the run needs approval.' },
      },
      required: ['run_id', 'reason'],
    },
  },
];

function normalizePeriod(raw: string): string {
  const months: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  };
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  const key = raw.trim().toLowerCase();
  if (months[key]) return `2026-${months[key]}`;
  return raw;
}

async function draftPayrollRun(env: Env, args: ToolResult): Promise<ToolResult> {
  const period = normalizePeriod(String(args.period ?? ''));
  const bonusPct = Number(args.bonus_pct ?? 0) || 0;
  const multiplier = 1 + bonusPct / 100;

  const { results: employees } = await env.DB.prepare(
    'SELECT salary_micro FROM employees'
  ).all<{ salary_micro: number }>();
  if (!employees.length) throw new Error('no employees on the roster');

  const total = employees.reduce((sum, e) => sum + Math.round(e.salary_micro * multiplier), 0);
  const note = bonusPct ? `${bonusPct}% bonus` : null;

  const run = await env.DB.prepare(
    "INSERT INTO payroll_runs (period, status, amount_multiplier, total_micro, requested_by, note) VALUES (?, 'draft', ?, ?, 'agent', ?) RETURNING id"
  )
    .bind(period, multiplier, total, note)
    .first<{ id: number }>();
  if (!run) throw new Error('failed to create run');

  await audit(env.DB, {
    actor: 'agent',
    action: 'run_drafted',
    run_id: run.id,
    detail: { period, bonus_pct: bonusPct, employee_count: employees.length, total_micro: total },
  });
  return {
    run_id: run.id,
    period,
    employee_count: employees.length,
    bonus_pct: bonusPct,
    total_micro: total,
    total_usd: microToUsd(total),
  };
}

async function checkPolicy(env: Env, args: ToolResult): Promise<ToolResult> {
  const runId = Number(args.run_id);
  const run = await env.DB.prepare('SELECT total_micro FROM payroll_runs WHERE id = ?')
    .bind(runId)
    .first<{ total_micro: number }>();
  if (!run) throw new Error(`run ${runId} not found`);

  const { results: employees } = await env.DB.prepare('SELECT wallet FROM employees').all<{ wallet: string }>();
  const policy = await loadPolicy(env);
  const result = evaluatePolicy(Number(run.total_micro), employees.map((e) => e.wallet), policy);

  await env.DB.prepare('UPDATE payroll_runs SET policy_result = ? WHERE id = ?')
    .bind(JSON.stringify(result), runId)
    .run();
  await audit(env.DB, {
    actor: 'agent',
    action: 'policy_check',
    run_id: runId,
    detail: result,
    policy_result: result.pass ? 'pass' : 'blocked',
  });
  return { run_id: runId, ...result };
}

export async function setExecutingAndRun(env: Env, runId: number) {
  await env.DB.prepare("UPDATE payroll_runs SET status = 'executing', updated_at = datetime('now') WHERE id = ?")
    .bind(runId)
    .run();
  return executeRun(env, runId);
}

async function executeRunTool(env: Env, args: ToolResult): Promise<ToolResult> {
  const runId = Number(args.run_id);
  const run = await env.DB.prepare('SELECT status, policy_result FROM payroll_runs WHERE id = ?')
    .bind(runId)
    .first<{ status: string; policy_result: string | null }>();
  if (!run) throw new Error(`run ${runId} not found`);
  const policy = run.policy_result ? JSON.parse(run.policy_result) : null;
  if (!policy?.pass) {
    return { run_id: runId, executed: false, error: 'policy did not pass; call request_approval instead' };
  }
  const result = await setExecutingAndRun(env, runId);
  return { run_id: runId, executed: true, ...result };
}

async function requestApproval(env: Env, args: ToolResult): Promise<ToolResult> {
  const runId = Number(args.run_id);
  const reason = String(args.reason ?? 'over policy');
  await env.DB.prepare(
    "UPDATE payroll_runs SET status = 'pending_approval', updated_at = datetime('now') WHERE id = ?"
  )
    .bind(runId)
    .run();
  await audit(env.DB, {
    actor: 'agent',
    action: 'approval_requested',
    run_id: runId,
    detail: { reason },
    policy_result: 'blocked',
  });
  return { run_id: runId, status: 'pending_approval', message: `Held for a second signature: ${reason}` };
}

async function dispatch(env: Env, name: string, args: ToolResult): Promise<ToolResult> {
  switch (name) {
    case 'draft_payroll_run': return draftPayrollRun(env, args);
    case 'check_policy': return checkPolicy(env, args);
    case 'execute_run': return executeRunTool(env, args);
    case 'request_approval': return requestApproval(env, args);
    default: return { error: `unknown tool ${name}` };
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
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: instruction },
  ];
  const toolsCalled: string[] = [];
  const completed = new Set<string>();
  let lastRunId: number | null = null;
  let reply = '';
  let repeated = false;

  for (let i = 0; i < 5 && !repeated; i++) {
    const resp: any = await (env.AI as any).run(model, { messages, tools: TOOLS });
    const toolCalls: any[] = resp?.tool_calls ?? [];

    if (!toolCalls.length) {
      reply = (resp?.response ?? '').toString().trim();
      break;
    }

    messages.push({ role: 'assistant', content: resp?.response ?? '', tool_calls: toolCalls });
    for (const call of toolCalls) {
      const name = call.name ?? call.function?.name;
      // A capable model walks draft → check_policy → execute/approve, each step
      // once. A weaker one re-emits a step it already did; that's our signal to
      // stop looping and let the deterministic engine finish the run.
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
      messages.push({ role: 'tool', name, content: JSON.stringify(result) });
    }
    if (lastRunId != null && (await isTerminal(env, lastRunId))) break;
  }

  // Safety net + correct-by-construction policy gate: if the model drafted a
  // run but didn't carry it through the policy check and the execute/approve
  // branch, finish it deterministically. The branch is a hard business rule
  // (cap + allowlist), never a model judgment call — this is the secure design,
  // not only a robustness fallback.
  let run: Record<string, unknown> | undefined;
  if (lastRunId != null) {
    run = await finalizeRun(env, lastRunId);
    if (run) reply = deterministicReply(run);
  }
  if (!reply) reply = 'No payroll action taken.';
  return { reply, run_id: lastRunId, tools_called: toolsCalled, run };
}

async function isTerminal(env: Env, runId: number): Promise<boolean> {
  const row = await env.DB.prepare('SELECT status FROM payroll_runs WHERE id = ?')
    .bind(runId)
    .first<{ status: string }>();
  return !!row && ['sealed', 'failed', 'pending_approval'].includes(row.status);
}

// Drive a run to a correct terminal state no matter how far the model got.
async function finalizeRun(env: Env, runId: number): Promise<Record<string, unknown> | undefined> {
  let row = await env.DB.prepare('SELECT id, status, policy_result FROM payroll_runs WHERE id = ?')
    .bind(runId)
    .first<{ id: number; status: string; policy_result: string | null }>();
  if (!row) return undefined;

  if (row.status === 'draft') {
    if (!row.policy_result) await checkPolicy(env, { run_id: runId });
    const after = await env.DB.prepare('SELECT policy_result FROM payroll_runs WHERE id = ?')
      .bind(runId)
      .first<{ policy_result: string | null }>();
    const policy = after?.policy_result ? JSON.parse(after.policy_result) : null;
    if (policy?.pass) {
      await setExecutingAndRun(env, runId);
    } else {
      await requestApproval(env, { run_id: runId, reason: policy?.reasons?.[0] ?? 'over policy' });
    }
  }

  return (
    (await env.DB.prepare(
      'SELECT id, period, status, total_micro, amount_multiplier, note, policy_result FROM payroll_runs WHERE id = ?'
    )
      .bind(runId)
      .first<Record<string, unknown>>()) ?? undefined
  );
}

function deterministicReply(run: Record<string, unknown>): string {
  const status = String(run.status);
  const total = Number(run.total_micro);
  if (status === 'sealed') return `Sealed. Run ${run.id}, ${microToUsd(total)} across the roster.`;
  if (status === 'pending_approval') return `Held for a second signature. Run ${run.id} is over policy at ${microToUsd(total)}.`;
  if (status === 'failed') return `Run ${run.id} did not complete — see the audit log.`;
  return `Run ${run.id} drafted at ${microToUsd(total)}.`;
}
