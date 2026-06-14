// Disburse — the x402 buyer driving a payroll run.
//
// For each employee the Worker buys a "seal" from its own 402-protected seal
// service: first request returns the quote, the payment authorization is
// signed by the Dynamic server wallet (via the sidecar — the agent holds no
// keys), and the paid retry executes the sealed Unlink transfer. Gateway nets
// all the run's authorizations into one batched settlement on Arc.
// The seal route is dispatched in-process (sealApp.request) — same protocol,
// no recursive self-fetch.

import { Hono } from 'hono';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerBatchScheme } from '@circle-fin/x402-batching/client';
import { dynamicSigner } from '../lib/signer';
import { audit } from '../lib/audit';
import { microToUsd } from '../lib/arc';
import { sealApp, SEAL_FEE_MICRO } from './seal';
import type { Env } from '../env';

type SealOutcome = {
  employee_id: number;
  name: string;
  amount_micro: number;
  status: 'sealed' | 'failed';
  unlink_ref?: string;
  gateway_ref?: string;
  error?: string;
};

export async function executeRun(env: Env, runId: number): Promise<{
  payments: SealOutcome[];
  total_micro: number;
  fees_micro: number;
  message: string;
}> {
  const { results: roster } = await env.DB.prepare(
    'SELECT id, name, salary_micro FROM employees ORDER BY id'
  ).all<{ id: number; name: string; salary_micro: number }>();
  // A run may target a subset of the roster ("pay just Ben").
  const runRow = await env.DB.prepare('SELECT employee_ids FROM payroll_runs WHERE id = ?')
    .bind(runId)
    .first<{ employee_ids: string | null }>();
  const onlyIds: number[] | null = runRow?.employee_ids ? JSON.parse(runRow.employee_ids) : null;
  const employees = onlyIds ? roster.filter((e) => onlyIds.includes(e.id)) : roster;

  const core = new x402Client();
  registerBatchScheme(core, {
    signer: dynamicSigner(env, env.TREASURY_WALLET_ADDRESS as `0x${string}`) as never,
  });
  const http = new x402HTTPClient(core);

  // Each employee's seal is independent (its own x402 payment + Unlink transfer),
  // so run them concurrently — a 3-employee run drops from ~3x one seal to ~1x.
  const sealOne = async (employee: { id: number; name: string; salary_micro: number }): Promise<SealOutcome> => {
    const path = `/seal/${employee.id}`;
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: runId }),
    };
    try {
      let res = await sealApp.request(path, init, env);
      if (res.status === 402) {
        const responseBody = await res.json().catch(() => undefined);
        const paymentRequired = http.getPaymentRequiredResponse(
          (name) => res.headers.get(name),
          responseBody
        );
        const payload = await http.createPaymentPayload(paymentRequired);
        const paymentHeaders = http.encodePaymentSignatureHeader(payload);
        res = await sealApp.request(
          path,
          { ...init, headers: { ...init.headers, ...paymentHeaders } },
          env
        );
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return {
          employee_id: employee.id,
          name: employee.name,
          amount_micro: employee.salary_micro,
          status: 'failed',
          error: String(body.error ?? `seal -> ${res.status}`) + (body.reason ? `: ${body.reason}` : ''),
        };
      }
      return {
        employee_id: employee.id,
        name: employee.name,
        amount_micro: (body.amount_micro as number) ?? employee.salary_micro,
        status: 'sealed',
        unlink_ref: body.unlink_ref as string | undefined,
        gateway_ref: (body.gateway_ref as string | null) ?? undefined,
      };
    } catch (err) {
      return {
        employee_id: employee.id,
        name: employee.name,
        amount_micro: employee.salary_micro,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
  const payments: SealOutcome[] = await Promise.all(employees.map(sealOne));

  const sealed = payments.filter((p) => p.status === 'sealed');
  const total = sealed.reduce((sum, p) => sum + p.amount_micro, 0);
  const fees = sealed.length * SEAL_FEE_MICRO;
  const allSealed = sealed.length === payments.length && payments.length > 0;

  await env.DB.prepare(
    "UPDATE payroll_runs SET status = ?, total_micro = ?, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(allSealed ? 'sealed' : 'failed', total, runId)
    .run();
  await audit(env.DB, {
    actor: 'system',
    action: allSealed ? 'run_sealed' : 'run_failed',
    run_id: runId,
    detail: { sealed: sealed.length, failed: payments.length - sealed.length, total_micro: total, fees_micro: fees },
  });

  return {
    payments,
    total_micro: total,
    fees_micro: fees,
    message: allSealed
      ? `Sealed. ${sealed.length} payments. ${microToUsd(fees)} in fees.`
      : `${sealed.length} of ${payments.length} payments sealed. See audit log.`,
  };
}

export const disburseApp = new Hono<{ Bindings: Env }>();

disburseApp.post('/disburse', async (c) => {
  const env = c.env;
  const body = await c.req.json().catch(() => ({}));
  const period = typeof body.period === 'string' ? body.period : new Date().toISOString().slice(0, 7);

  const run = await env.DB.prepare(
    "INSERT INTO payroll_runs (period, status, requested_by) VALUES (?, 'executing', ?) RETURNING id"
  )
    .bind(period, 'employer')
    .first<{ id: number }>();
  if (!run) return c.json({ error: 'failed to create run' }, 500);
  await audit(env.DB, { actor: 'employer', action: 'run_started', run_id: run.id, detail: { period } });

  const result = await executeRun(env, run.id);
  return c.json({ run_id: run.id, period, ...result }, result.payments.every((p) => p.status === 'sealed') ? 200 : 502);
});
