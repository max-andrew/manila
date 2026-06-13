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

// Provision a fresh private (unlink1) account for a new employee so they can
// receive sealed pay: generate a mnemonic, derive the address, register it.
export async function provisionRecipient(env: Env): Promise<string> {
  const { generateMnemonic, english } = await import('viem/accounts');
  const admin = unlinkAdmin(env);
  const client = createUnlinkClient({
    environment: UNLINK_ENVIRONMENT,
    account: account.fromMnemonic({ mnemonic: generateMnemonic(english) }),
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
  await client.ensureRegistered();
  return client.getAddress();
}

// One sealed salary transfer. Amounts in micro-USDC (base units).
export async function sealTransfer(
  env: Env,
  recipientUnlinkAddress: string,
  amountMicro: number
): Promise<{ ref: string }> {
  const client = treasuryUnlinkClient(env);
  await client.ensureRegistered();
  // On arc-testnet the privacy pool holds a mock token (USDCm), not native
  // USDC — configurable, with native USDC as the mainnet default. Salary
  // amounts are 6-decimal micro-USD; scale to the pool token's decimals.
  const token = env.UNLINK_TOKEN_ADDRESS || ARC_USDC_ADDRESS;
  const decimals = Number(env.UNLINK_TOKEN_DECIMALS || '6');
  const amount = (BigInt(amountMicro) * 10n ** BigInt(Math.max(0, decimals - 6))).toString();
  const tx = await client.transfer({
    recipientAddress: recipientUnlinkAddress,
    token,
    amount,
  } as Parameters<typeof client.transfer>[0]);
  const result = (await tx.wait()) as { status?: string; txHash?: string; txId?: string };
  if (result.status === 'failed') {
    throw new Error(`unlink transfer failed: ${JSON.stringify(result).slice(0, 300)}`);
  }
  // The on-chain hash of the sealed transfer — verifiable on ArcScan as a
  // privacy-pool interaction, with amount and counterparty unreadable.
  return { ref: result.txHash ?? result.txId ?? 'sealed' };
}
