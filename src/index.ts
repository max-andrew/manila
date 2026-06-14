import { Hono } from 'hono';
import type { Env } from './env';
import { sealApp } from './routes/seal';
import { disburseApp } from './routes/disburse';
import { agentApp } from './routes/agent';
import { statusApp } from './routes/status';
import { treasuryApp } from './routes/treasury';
import { employeesApp } from './routes/employees';
import { policyApp } from './routes/policy';
import { vestingApp } from './routes/vesting';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json({ ok: true, service: 'manila' }));

// Reset the demo: clear the day's runs, payments, and audit (team + controls
// stay). After this, nobody is "paid today" — start a fresh walkthrough.
app.post('/api/reset', async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM payments'),
    c.env.DB.prepare('DELETE FROM payroll_runs'),
    c.env.DB.prepare('DELETE FROM audit_log'),
  ]);
  return c.json({ reset: true });
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
app.route('/api', statusApp);
app.route('/api', treasuryApp);
app.route('/api', employeesApp);
app.route('/api', policyApp);
app.route('/api', vestingApp);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

export default app;
