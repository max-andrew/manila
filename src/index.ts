import { Hono } from 'hono';
import type { Env } from './env';
import { sealApp } from './routes/seal';
import { disburseApp } from './routes/disburse';
import { agentApp } from './routes/agent';
import { statusApp } from './routes/status';
import { treasuryApp } from './routes/treasury';
import { employeesApp } from './routes/employees';
import { policyApp } from './routes/policy';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json({ ok: true, service: 'manila' }));

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

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

export default app;
