// The Dynamic MPC signer, now a Cloudflare Container instead of a laptop +
// tunnel. The Dynamic SDK ships a native binary that can't run in workerd, so
// the sidecar (sidecar/server.mjs) runs in this container; the Worker reaches it
// through the Durable Object binding — no public URL, no tunnel, one platform.
//
// Single instance: the MPC session isn't concurrency-safe, so the Worker always
// addresses it by the same name ("signer") and max_instances is 1.
//
// Scale-to-zero: it sleeps after 5 min idle. There is no proactive keep-warm —
// a real sign/status call wakes it on demand. The container's port only opens
// after the wallet has loaded (server.listen runs last in server.mjs), so the
// Worker's fetch transparently waits out the ~cold-start before the first call
// returns rather than erroring.

import { Container } from '@cloudflare/containers';
import type { Env } from './env';

export class SignerContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '5m';

  // Hand the signing secrets to the container process (read by server.mjs via
  // process.env). PORT pins the listener to defaultPort. this.env is populated
  // by the base constructor before these field initializers run.
  envVars: Record<string, string> = {
    PORT: '8080',
    DYNAMIC_API_KEY: this.env.DYNAMIC_API_KEY,
    DYNAMIC_ENV_ID: this.env.DYNAMIC_ENV_ID,
    SIDECAR_WALLET_PASSWORD: this.env.SIDECAR_WALLET_PASSWORD,
    SIGNER_SIDECAR_SECRET: this.env.SIGNER_SIDECAR_SECRET,
  };
}
