import { Hono } from 'hono';
import type { Env } from './env';

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

// Implemented in M1/M2 — explicit 501s so the UI can wire against real routes now.
app.post('/api/disburse', (c) => c.json({ error: 'not implemented yet (M1)' }, 501));
app.post('/api/agent', (c) => c.json({ error: 'not implemented yet (M2)' }, 501));
app.post('/api/approve/:id', (c) => c.json({ error: 'not implemented yet (M2)' }, 501));
app.get('/api/audit.csv', (c) => c.json({ error: 'not implemented yet (M2)' }, 501));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

export default app;
