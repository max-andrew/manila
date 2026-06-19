// Manila signing sidecar.
//
// @dynamic-labs-wallet/node-evm runs MPC signing in a native .node binary,
// which Cloudflare Workers cannot load — so the Dynamic server wallet lives
// here, in a minimal Node process. The Worker is the only caller; every
// request must carry the shared secret. The sidecar exposes signing only:
// no key export, no transfers, no state beyond the wallet metadata.
//
// Run: node sidecar/server.mjs   (reads .dev.vars from the repo root)

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// --- env: process.env wins, .dev.vars fills the gaps ---------------------
function loadDevVars() {
  const path = join(root, '.dev.vars');
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
}
const vars = { ...loadDevVars(), ...process.env };
const need = (k) => {
  if (!vars[k]) {
    console.error(`missing ${k} (set in .dev.vars or environment)`);
    process.exit(1);
  }
  return vars[k];
};

const DYNAMIC_API_KEY = need('DYNAMIC_API_KEY');
const DYNAMIC_ENV_ID = need('DYNAMIC_ENV_ID');
const WALLET_PASSWORD = need('SIDECAR_WALLET_PASSWORD');
const SIDECAR_SECRET = need('SIGNER_SIDECAR_SECRET');
// The Cloudflare Container sets PORT (= the DO's defaultPort); locally we use
// SIDECAR_PORT from .dev.vars. Honor PORT first so the container listener matches.
const PORT = Number(vars.PORT ?? vars.SIDECAR_PORT ?? 8901);
const WALLET_FILE = join(here, '.wallet.json');

// --- Dynamic client -------------------------------------------------------
const { DynamicEvmWalletClient } = await import('@dynamic-labs-wallet/node-evm');

const client = new DynamicEvmWalletClient({ environmentId: DYNAMIC_ENV_ID });
await client.authenticateApiToken(DYNAMIC_API_KEY);

// Dynamic auth tokens expire after a while; if a signing call fails, refresh
// the token once and retry so a long-running sidecar self-heals during a demo.
async function withReauth(fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`sign failed (${err?.message ?? err}); re-authenticating and retrying…`);
    await client.authenticateApiToken(DYNAMIC_API_KEY);
    return fn();
  }
}

async function loadOrCreateWallet() {
  if (existsSync(WALLET_FILE)) {
    const saved = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
    console.log(`wallet loaded: ${saved.walletMetadata.accountAddress}`);
    return saved.walletMetadata;
  }
  const existing = await client.getEvmWallets();
  if (existing.length > 0) {
    const walletMetadata = existing[0];
    writeFileSync(WALLET_FILE, JSON.stringify({ walletMetadata }, null, 2));
    console.log(`wallet recovered from Dynamic: ${walletMetadata.accountAddress}`);
    return walletMetadata;
  }
  const created = await client.createWalletAccount({
    thresholdSignatureScheme: 'TWO_OF_TWO',
    password: WALLET_PASSWORD,
    backUpToDynamic: true,
  });
  writeFileSync(WALLET_FILE, JSON.stringify({ walletMetadata: created.walletMetadata }, null, 2));
  console.log(`wallet created: ${created.walletMetadata.accountAddress}`);
  return created.walletMetadata;
}

const walletMetadata = await loadOrCreateWallet();
const address = walletMetadata.accountAddress;

// The Dynamic MPC signer isn't safe to call concurrently (parallel signs corrupt
// the session — "Error signing typed data"). Serialize all signing through a
// promise chain so the Worker can fan out a payroll run's seals while the signs
// themselves queue (they're the fast step; settlement + Unlink run in parallel).
let signChain = Promise.resolve();
function serializeSign(fn) {
  const run = signChain.then(fn, fn);
  signChain = run.then(() => {}, () => {});
  return run;
}

// --- tx field coercion: JSON carries strings, viem wants bigints ----------
const BIGINT_FIELDS = ['value', 'gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas'];
function coerceTx(tx) {
  const out = { ...tx };
  for (const f of BIGINT_FIELDS) if (out[f] != null) out[f] = BigInt(out[f]);
  if (out.nonce != null) out.nonce = Number(out.nonce);
  if (out.chainId != null) out.chainId = Number(out.chainId);
  return out;
}

// --- http ------------------------------------------------------------------
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  if (req.headers['x-sidecar-secret'] !== SIDECAR_SECRET) {
    return json(res, 401, { error: 'unauthorized' });
  }
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, address });
  }
  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

  let body = '';
  for await (const chunk of req) body += chunk;
  let payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    return json(res, 400, { error: 'invalid json' });
  }

  try {
    if (req.url === '/sign-typed-data') {
      const signature = await serializeSign(() => withReauth(() =>
        client.signTypedData({ walletMetadata, typedData: payload.typedData, password: WALLET_PASSWORD })
      ));
      return json(res, 200, { signature, address });
    }
    if (req.url === '/sign-transaction') {
      const signedTx = await serializeSign(() => withReauth(() =>
        client.signTransaction({ walletMetadata, transaction: coerceTx(payload.transaction), password: WALLET_PASSWORD })
      ));
      return json(res, 200, { signedTx, address });
    }
    if (req.url === '/sign-message') {
      const signature = await serializeSign(() => withReauth(() =>
        client.signMessage({ walletMetadata, message: payload.message, password: WALLET_PASSWORD })
      ));
      return json(res, 200, { signature, address });
    }
    // Read-only: list the account's Dynamic MPC wallets and the active signer.
    // Rotating the signing set is deliberately NOT exposed here — it's a
    // treasury operation, so a misclick can't lock the infra out.
    if (req.url === '/wallets') {
      const wallets = await withReauth(() => client.getEvmWallets());
      return json(res, 200, {
        active: address,
        wallets: wallets.map((w) => ({ address: w.accountAddress, active: w.accountAddress === address })),
      });
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(`${req.url} failed:`, err);
    return json(res, 500, { error: err?.message ?? String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`manila sidecar listening on :${PORT} — treasury ${address}`);
});
