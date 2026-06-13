// Seal service — the 402-protected disbursement endpoint.
//
// Each employee payment is bought as an x402 resource: no nanopayment, no
// seal. The handler verifies + settles the buyer's payment authorization with
// Circle Gateway (batched, gas-free), then moves the salary as an Unlink
// private transfer. Protocol port of @circle-fin/x402-batching's Express
// middleware (same headers: PAYMENT-REQUIRED / payment-signature /
// PAYMENT-RESPONSE, base64 JSON envelopes).

import { Hono } from 'hono';
import {
  BatchFacilitatorClient,
  GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
} from '@circle-fin/x402-batching/server';
import {
  CIRCLE_BATCHING_NAME,
  CIRCLE_BATCHING_SCHEME,
  CIRCLE_BATCHING_VERSION,
} from '@circle-fin/x402-batching';
import { sealTransfer } from '../lib/unlink';
import { audit } from '../lib/audit';
import { ARC_TESTNET_CHAIN_ID } from '../lib/arc';
import type { Env } from '../env';

export const FACILITATOR_TESTNET_URL = 'https://gateway-api-testnet.circle.com';
export const SEAL_FEE_MICRO = 1000; // $0.001 per disbursement
export const ARC_NETWORK = `eip155:${ARC_TESTNET_CHAIN_ID}`;

type Requirements = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};

export function facilitator() {
  return new BatchFacilitatorClient({ url: FACILITATOR_TESTNET_URL });
}

// The live Arc payment kind advertised by the facilitator, or null if Arc is
// not currently offered. Shared with the readiness preflight.
export async function arcKind(): Promise<Record<string, any> | null> {
  const supported = await facilitator().getSupported();
  return (
    (supported.kinds as Array<Record<string, any>>).find(
      (k) => k.network === ARC_NETWORK && k.extra?.verifyingContract
    ) ?? null
  );
}

// USDC address as the facilitator advertises it for this network — same
// extractor Circle's own middleware uses (extra.assets, by symbol).
export function usdcAddressOf(kind: Record<string, any>): string | null {
  const assets = kind.extra?.assets as Array<{ symbol: string; address: string }> | undefined;
  return assets?.find((a) => a.symbol === 'USDC')?.address ?? null;
}

async function arcRequirements(env: Env): Promise<Requirements | null> {
  const kind = await arcKind();
  if (!kind) return null;
  const asset = usdcAddressOf(kind);
  if (!asset) return null;
  return {
    scheme: CIRCLE_BATCHING_SCHEME,
    network: ARC_NETWORK,
    asset,
    amount: String(SEAL_FEE_MICRO),
    payTo: env.SEAL_FEE_ADDRESS,
    maxTimeoutSeconds: GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
    extra: {
      name: CIRCLE_BATCHING_NAME,
      version: CIRCLE_BATCHING_VERSION,
      verifyingContract: kind.extra.verifyingContract,
    },
  };
}

export const sealApp = new Hono<{ Bindings: Env }>();

sealApp.post('/seal/:employeeId', async (c) => {
  const env = c.env;
  const employeeId = Number(c.req.param('employeeId'));
  const body = await c.req.json().catch(() => ({}));
  const runId = Number(body.run_id);
  if (!runId) return c.json({ error: 'run_id required' }, 400);

  const employee = await env.DB.prepare(
    'SELECT id, name, salary_micro, unlink_address FROM employees WHERE id = ?'
  )
    .bind(employeeId)
    .first<{ id: number; name: string; salary_micro: number; unlink_address: string | null }>();
  if (!employee) return c.json({ error: 'unknown employee' }, 404);
  if (!employee.unlink_address) return c.json({ error: 'employee has no unlink address' }, 409);

  const run = await env.DB.prepare(
    'SELECT id, status, amount_multiplier FROM payroll_runs WHERE id = ?'
  )
    .bind(runId)
    .first<{ id: number; status: string; amount_multiplier: number }>();
  if (!run || run.status !== 'executing') {
    return c.json({ error: 'run not found or not executing' }, 409);
  }
  // Amount for this run = salary × the run's adjustment (e.g. a bonus).
  const amountMicro = Math.round(employee.salary_micro * Number(run.amount_multiplier ?? 1));
  const dupe = await env.DB.prepare(
    "SELECT id FROM payments WHERE run_id = ? AND employee_id = ? AND status = 'sealed'"
  )
    .bind(runId, employeeId)
    .first();
  if (dupe) return c.json({ error: 'already sealed for this run' }, 409);

  const requirements = await arcRequirements(env);
  if (!requirements) return c.json({ error: 'Arc not available at facilitator' }, 503);

  // No payment yet: quote the price (x402 v2).
  const paymentHeader = c.req.header('payment-signature');
  if (!paymentHeader) {
    const paymentRequired = {
      x402Version: 2,
      resource: {
        url: c.req.url,
        description: `Seal payroll disbursement for employee ${employee.id}`,
        mimeType: 'application/json',
      },
      accepts: [requirements],
    };
    c.header('PAYMENT-REQUIRED', btoa(JSON.stringify(paymentRequired)));
    return c.json({}, 402);
  }

  // Paid request: verify + settle with Gateway, then seal the salary.
  let paymentPayload: Record<string, any>;
  try {
    paymentPayload = JSON.parse(atob(paymentHeader));
  } catch {
    return c.json({ error: 'invalid payment-signature header' }, 400);
  }

  const fac = facilitator();
  const verifyResult = await fac.verify(paymentPayload as any, requirements as any);
  if (!verifyResult.isValid) {
    await audit(env.DB, {
      actor: 'system',
      action: 'seal_payment_rejected',
      run_id: runId,
      detail: { employee: employee.id, reason: verifyResult.invalidReason },
    });
    return c.json({ error: 'payment verification failed', reason: verifyResult.invalidReason }, 402);
  }
  const settleResult = await fac.settle(paymentPayload as any, requirements as any);
  if (!settleResult.success) {
    return c.json({ error: 'payment settlement failed', reason: settleResult.errorReason }, 402);
  }

  // Value leg: sealed salary transfer via Unlink.
  let unlinkRef: string;
  try {
    const sealed = await sealTransfer(env, employee.unlink_address, amountMicro);
    unlinkRef = sealed.ref;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await env.DB.prepare(
      "INSERT INTO payments (run_id, employee_id, amount_micro, status, gateway_ref) VALUES (?, ?, ?, 'failed', ?)"
    )
      .bind(runId, employeeId, amountMicro, settleResult.transaction ?? null)
      .run();
    await audit(env.DB, {
      actor: 'system',
      action: 'seal_transfer_failed',
      run_id: runId,
      detail: { employee: employee.id, error: message },
    });
    return c.json({ error: `sealed transfer failed: ${message}` }, 502);
  }

  await env.DB.prepare(
    "INSERT INTO payments (run_id, employee_id, amount_micro, status, unlink_ref, gateway_ref) VALUES (?, ?, ?, 'sealed', ?, ?)"
  )
    .bind(runId, employeeId, amountMicro, unlinkRef, settleResult.transaction ?? null)
    .run();
  await audit(env.DB, {
    actor: 'system',
    action: 'disburse',
    run_id: runId,
    detail: { employee: employee.id, amount_micro: amountMicro, fee_micro: SEAL_FEE_MICRO },
    tx_refs: [unlinkRef, settleResult.transaction ?? ''].filter(Boolean),
  });

  c.header(
    'PAYMENT-RESPONSE',
    btoa(
      JSON.stringify({
        success: true,
        transaction: settleResult.transaction,
        network: requirements.network,
        payer: settleResult.payer ?? verifyResult.payer ?? '',
      })
    )
  );
  return c.json({
    sealed: true,
    employee_id: employee.id,
    amount_micro: amountMicro,
    unlink_ref: unlinkRef,
    gateway_ref: settleResult.transaction ?? null,
  });
});
