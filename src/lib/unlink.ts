// Treasury-side Unlink client (custodial: the Worker holds the treasury's
// Unlink account; registration and authorization tokens go through the
// admin handle, never exposing the API key beyond this process).

import { createUnlinkAdmin } from '@unlink-xyz/sdk/admin';
import { createUnlinkClient, account } from '@unlink-xyz/sdk/client';
import { ARC_USDC_ADDRESS } from './arc';
import type { Env } from '../env';

export const UNLINK_ENVIRONMENT = 'arc-testnet';

export function unlinkAdmin(env: Env) {
  return createUnlinkAdmin({ environment: UNLINK_ENVIRONMENT, apiKey: env.UNLINK_API_KEY });
}

export function treasuryUnlinkClient(env: Env) {
  const admin = unlinkAdmin(env);
  return createUnlinkClient({
    environment: UNLINK_ENVIRONMENT,
    account: account.fromMnemonic({ mnemonic: env.TREASURY_UNLINK_MNEMONIC }),
    register: (payload) => admin.users.register(payload),
    authorizationToken: {
      provider: async (ctx) => {
        const issued = await admin.authorizationTokens.issue({
          subjectType: ctx.subjectType ?? 'unlink_address',
          unlinkAddress: ctx.unlinkAddress,
        } as Parameters<typeof admin.authorizationTokens.issue>[0]);
        return { token: issued.token, expiresAt: issued.expiresAt };
      },
    },
  });
}

// One sealed salary transfer. Amounts in micro-USDC (base units).
export async function sealTransfer(
  env: Env,
  recipientUnlinkAddress: string,
  amountMicro: number
): Promise<{ ref: string }> {
  const client = treasuryUnlinkClient(env);
  await client.ensureRegistered();
  const tx = await client.transfer({
    recipientAddress: recipientUnlinkAddress,
    token: ARC_USDC_ADDRESS,
    amount: String(amountMicro),
  } as Parameters<typeof client.transfer>[0]);
  const result = await tx.wait();
  if ((result as { status?: string }).status === 'failed') {
    throw new Error(`unlink transfer failed: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return { ref: (tx as unknown as { id?: string }).id ?? JSON.stringify(result).slice(0, 80) };
}
