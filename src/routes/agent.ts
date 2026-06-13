import { Hono } from 'hono';
import { runAgent, setExecutingAndRun } from '../lib/agent';
import { audit } from '../lib/audit';
import type { Env } from '../env';

export const agentApp = new Hono<{ Bindings: Env }>();

// Plain-English payroll command → tool-use loop on Workers AI.
agentApp.post('/agent', async (c) => {
  const env = c.env;
  const body = await c.req.json().catch(() => ({}));
  const instruction = typeof body.message === 'string' ? body.message.trim() : '';
  if (!instruction) return c.json({ error: 'message required' }, 400);

  await audit(env.DB, { actor: 'employer', action: 'agent_instruction', detail: { instruction } });
  try {
    const outcome = await runAgent(env, instruction);
    return c.json(outcome);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit(env.DB, { actor: 'system', action: 'agent_error', detail: { message } });
    // Fail gracefully — the UI shows this, never a blank screen.
    return c.json({ reply: `Agent error: ${message}`, run_id: null, tools_called: [], error: message }, 200);
  }
});

// The second signature on the envelope: release a pending run.
agentApp.post('/approve/:id', async (c) => {
  const env = c.env;
  const runId = Number(c.req.param('id'));
  const run = await env.DB.prepare('SELECT id, status FROM payroll_runs WHERE id = ?')
    .bind(runId)
    .first<{ id: number; status: string }>();
  if (!run) return c.json({ error: 'run not found' }, 404);
  if (run.status !== 'pending_approval') {
    return c.json({ error: `run is ${run.status}, not pending_approval` }, 409);
  }

  await env.DB.prepare("UPDATE payroll_runs SET approved_by = 'employer' WHERE id = ?")
    .bind(runId)
    .run();
  await audit(env.DB, {
    actor: 'employer',
    action: 'approved',
    run_id: runId,
    detail: { note: 'second signature added' },
  });
  const result = await setExecutingAndRun(env, runId);
  return c.json({ run_id: runId, approved: true, ...result });
});

// Open the envelope — employer-only audit export.
agentApp.get('/audit.csv', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, created_at, actor, action, run_id, policy_result, detail, tx_refs FROM audit_log ORDER BY id'
  ).all<Record<string, unknown>>();

  const cols = ['id', 'created_at', 'actor', 'action', 'run_id', 'policy_result', 'detail', 'tx_refs'];
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const row of results) lines.push(cols.map((k) => escape(row[k])).join(','));

  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="manila-audit.csv"',
    },
  });
});
