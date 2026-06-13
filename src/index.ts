import { Hono } from 'hono';
import type { Env } from './env';
import { sealApp } from './routes/seal';
import { disburseApp } from './routes/disburse';
import { agentApp } from './routes/agent';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json({ ok: true, service: 'manila' }));

app.get('/api/employees', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, wallet, salary_micro, schedule FROM employees ORDER BY id'
  ).all();
  return c.json(results);
});

app.get('/api/policy', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT per_run_cap_micro, allowlist FROM policies WHERE id = 1'
  ).first();
  if (!row) return c.json({ error: 'no policy configured' }, 500);
  return c.json({
    per_run_cap_micro: row.per_run_cap_micro,
    allowlist: JSON.parse(row.allowlist as string),
  });
});

app.get('/api/audit', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM audit_log ORDER BY id DESC LIMIT 100'
  ).all();
  return c.json(results);
});

app.route('/api', sealApp);
app.route('/api', disburseApp);
app.route('/api', agentApp);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

export default app;
