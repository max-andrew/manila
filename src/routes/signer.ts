// Dynamic server-wallet status and the switch flow. The signer is a Dynamic
// MPC (2-of-2) wallet living in the sidecar; the app can read which wallet is
// active, switch to another of the account's wallets, or provision a new one.

import { Hono } from 'hono';
import { signerStatus, selectSigner, provisionSigner } from '../lib/signer';
import type { Env } from '../env';

export const signerApp = new Hono<{ Bindings: Env }>();

signerApp.get('/signer', async (c) => c.json(await signerStatus(c.env)));

signerApp.post('/signer/select', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const address = String(body.address ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return c.json({ error: 'valid address required' }, 400);
  try {
    const out = await selectSigner(c.env, address);
    return c.json({ ok: true, ...out });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

signerApp.post('/signer/provision', async (c) => {
  try {
    const out = await provisionSigner(c.env);
    return c.json({ ok: true, ...out });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});
