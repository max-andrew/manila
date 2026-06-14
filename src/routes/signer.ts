// Dynamic server-wallet status (read-only). The signer is a Dynamic MPC (2-of-2)
// wallet living in the sidecar. Rotating the signing set is deliberately not
// exposed as an endpoint — it's a treasury operation, so a misclick can't lock
// the infra out.

import { Hono } from 'hono';
import { signerStatus } from '../lib/signer';
import type { Env } from '../env';

export const signerApp = new Hono<{ Bindings: Env }>();

signerApp.get('/signer', async (c) => c.json(await signerStatus(c.env)));
