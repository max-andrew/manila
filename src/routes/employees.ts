// Employee management — add, update, remove the roster, keeping the policy
// allowlist in sync. Adding a hire provisions a private (unlink) account so
// they can receive sealed pay; removing one drops them from the allowlist.

import { Hono } from 'hono';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { provisionRecipient, unlinkAdmin } from '../lib/unlink';
import { ARC_USDC_ADDRESS } from '../lib/arc';
import { audit } from '../lib/audit';
import type { Env } from '../env';

export const employeesApp = new Hono<{ Bindings: Env }>();

// Each employee's private (sealed) balance — readable by the employer via the
// Unlink admin handle, but NOT on the public explorer. This is the auditable
// side of the privacy split: proof the money landed, visible only to the
// employer. Returns { [employeeId]: formattedUSD | null }.
employeesApp.get('/team-balances', async (c) => {
  const env = c.env;
  const { results } = await env.DB.prepare(
    'SELECT id, unlink_address FROM employees WHERE unlink_address IS NOT NULL'
  ).all<{ id: number; unlink_address: string }>();
  const token = (env.UNLINK_TOKEN_ADDRESS || ARC_USDC_ADDRESS).toLowerCase();
  const decimals = Number(env.UNLINK_TOKEN_DECIMALS || '6');
  const admin = unlinkAdmin(env);

  const out: Record<number, string | null> = {};
  await Promise.all(
    results.map(async (e) => {
      try {
        const data: any = await admin.users.getBalances({ address: e.unlink_address });
        const entry = (data?.balances as Array<{ token: string; amount: string }> | undefined)?.find(
          (b) => b.token.toLowerCase() === token
        );
        out[e.id] = entry ? (Number(entry.amount) / 10 ** decimals).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
      } catch {
        out[e.id] = null;
      }
    })
  );
  return c.json(out);
});

async function setAllowlist(env: Env, mutate: (list: string[]) => string[]) {
  const row = await env.DB.prepare('SELECT allowlist FROM policies WHERE id = 1').first<{ allowlist: string }>();
  const list: string[] = row ? JSON.parse(row.allowlist) : [];
  await env.DB.prepare('UPDATE policies SET allowlist = ? WHERE id = 1')
    .bind(JSON.stringify(mutate(list)))
    .run();
}

// Roster with each employee's latest sealed payment (for the "got paid" view).
employeesApp.get('/employees', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.name, e.wallet, e.salary_micro, e.schedule, e.unlink_address,
       (SELECT p.unlink_ref FROM payments p WHERE p.employee_id = e.id AND p.status = 'sealed' ORDER BY p.id DESC LIMIT 1) AS last_seal_ref,
       (SELECT p.created_at FROM payments p WHERE p.employee_id = e.id AND p.status = 'sealed' ORDER BY p.id DESC LIMIT 1) AS last_paid_at
     FROM employees e ORDER BY e.id`
  ).all();
  return c.json(results);
});

employeesApp.post('/employees', async (c) => {
  const env = c.env;
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name ?? '').trim();
  const daily = Number(body.daily_usd);
  if (!name || !(daily > 0)) return c.json({ error: 'name and a positive daily_usd are required' }, 400);

  const wallet =
    typeof body.wallet === 'string' && /^0x[0-9a-fA-F]{40}$/.test(body.wallet)
      ? body.wallet
      : privateKeyToAccount(generatePrivateKey()).address;
  const salaryMicro = Math.round(daily * 1e6);

  // Where sealed pay goes. The employee can bring their own private (unlink1)
  // receiving address; if they don't, we provision and register one for them.
  const provided =
    typeof body.unlink_address === 'string' && body.unlink_address.trim().startsWith('unlink1')
      ? body.unlink_address.trim()
      : null;
  let unlinkAddress: string | null = provided;
  let provisioned = false;
  if (!unlinkAddress) {
    try {
      unlinkAddress = await provisionRecipient(env);
      provisioned = true;
    } catch (err) {
      console.error('unlink provisioning failed (employee still added):', err);
    }
  }

  const row = await env.DB.prepare(
    "INSERT INTO employees (name, wallet, salary_micro, schedule, unlink_address) VALUES (?, ?, ?, 'daily', ?) RETURNING id"
  )
    .bind(name, wallet, salaryMicro, unlinkAddress)
    .first<{ id: number }>();
  await setAllowlist(env, (list) =>
    list.some((a) => a.toLowerCase() === wallet.toLowerCase()) ? list : [...list, wallet]
  );
  await audit(env.DB, { actor: 'employer', action: 'employee_added', detail: { id: row?.id, name, daily_usd: daily, payable: !!unlinkAddress, provisioned } });
  return c.json({ id: row?.id, name, wallet, salary_micro: salaryMicro, unlink_address: unlinkAddress, payable: !!unlinkAddress, provisioned });
});

employeesApp.patch('/employees/:id', async (c) => {
  const env = c.env;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const existing = await env.DB.prepare('SELECT id FROM employees WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'employee not found' }, 404);

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (typeof body.name === 'string' && body.name.trim()) { sets.push('name = ?'); binds.push(body.name.trim()); }
  if (body.daily_usd != null && Number(body.daily_usd) > 0) { sets.push('salary_micro = ?'); binds.push(Math.round(Number(body.daily_usd) * 1e6)); }
  if (!sets.length) return c.json({ error: 'nothing to update' }, 400);

  binds.push(id);
  await env.DB.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  await audit(env.DB, { actor: 'employer', action: 'employee_updated', detail: { id, changes: body } });
  return c.json({ id, updated: true });
});

employeesApp.delete('/employees/:id', async (c) => {
  const env = c.env;
  const id = Number(c.req.param('id'));
  const emp = await env.DB.prepare('SELECT id, name, wallet FROM employees WHERE id = ?')
    .bind(id)
    .first<{ id: number; name: string; wallet: string }>();
  if (!emp) return c.json({ error: 'employee not found' }, 404);

  await env.DB.prepare('DELETE FROM employees WHERE id = ?').bind(id).run();
  await setAllowlist(env, (list) => list.filter((a) => a.toLowerCase() !== emp.wallet.toLowerCase()));
  await audit(env.DB, { actor: 'employer', action: 'employee_removed', detail: { id, name: emp.name } });
  return c.json({ id, removed: true });
});
