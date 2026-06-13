// Remote signer backed by the Dynamic server wallet (MPC) in the Node sidecar.
// Implements the shape @circle-fin/x402-batching expects of a BatchEvmSigner:
// { address, signTypedData } — so every Gateway payment authorization is
// signed by the Dynamic wallet, never by a key the agent holds.

import type { Env } from '../env';

async function sidecar<T>(env: Env, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.SIGNER_SIDECAR_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sidecar-secret': env.SIGNER_SIDECAR_SECRET,
    },
    // EIP-712 typed data carries uint256 values as BigInt (amount, nonce,
    // valid-after/before). JSON can't serialize those — stringify them; the
    // sidecar's viem signer coerces numeric strings back for hashing.
    body: JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`sidecar ${path} -> ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

export async function sidecarHealth(env: Env): Promise<{ ok: boolean; address: string }> {
  const res = await fetch(`${env.SIGNER_SIDECAR_URL}/health`, {
    headers: { 'x-sidecar-secret': env.SIGNER_SIDECAR_SECRET },
  });
  if (!res.ok) throw new Error(`sidecar health -> ${res.status}`);
  return res.json();
}

export function dynamicSigner(env: Env, address: `0x${string}`) {
  return {
    address,
    signTypedData: async (params: unknown): Promise<`0x${string}`> => {
      const { signature } = await sidecar<{ signature: `0x${string}` }>(
        env,
        '/sign-typed-data',
        { typedData: params }
      );
      return signature;
    },
  };
}

// For plain transactions (e.g. the one-time Gateway deposit, Unlink deposit):
// sidecar signs, caller broadcasts via viem.
export async function signTransaction(
  env: Env,
  transaction: Record<string, unknown>
): Promise<`0x${string}`> {
  const { signedTx } = await sidecar<{ signedTx: `0x${string}` }>(env, '/sign-transaction', {
    transaction,
  });
  return signedTx;
}
