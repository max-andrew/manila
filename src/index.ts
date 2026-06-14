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
import { signerApp } from './routes/signer';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json({ ok: true, service: 'manila' }));

// Reset the demo, time-aware: stamp reset_at = now. The agent's "paid today"
// guard only counts payments sealed AFTER this, so payroll can run again — no
// history is deleted, the audit trail and on-chain reality stay intact.
app.post('/api/reset', async (c) => {
  await c.env.DB.prepare("UPDATE app_state SET value = datetime('now') WHERE key = 'reset_at'").run();
  const row = await c.env.DB.prepare("SELECT value FROM app_state WHERE key = 'reset_at'").first<{ value: string }>();
  return c.json({ reset: true, reset_at: row?.value ?? null });
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
app.route('/api', signerApp);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

export default app;
