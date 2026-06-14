// PayrollVault — the optional on-chain disbursement path (Arc "Advanced
// Stablecoin Logic"). Unlike the sealed Unlink rail, USDC here is *publicly*
// custodied: it sits locked in the deployed contract and visibly transfers out
// on release() — the one part of Manila a judge can verify on the explorer.
//
// The Worker only ever READS the contract and BROADCASTS a release that the
// Dynamic server wallet (the vault's authorized `releaser`) signs in the
// sidecar. The agent holds no keys; the employer key that funds schedules never
// touches the Worker.

import { createPublicClient, http, encodeFunctionData } from 'viem';
import { arcTestnet, ARC_TESTNET_CHAIN_ID, explorerTxUrl, explorerAddressUrl } from './arc';
import { signTransaction } from './signer';
import type { Env } from '../env';

// PayrollVaultV2, deployed on Arc testnet. Constructor: usdc = native USDC's
// ERC-20 interface, releaser = the Dynamic treasury wallet. V2 adds resetClock,
// which re-arms a schedule's remaining funds over a fresh clock so the release
// flow always has something to show.
export const PAYROLL_VAULT_ADDRESS = '0xb18B2D0119Afde4868889cf42Eb8d272f1Fd90FC' as const;
// USDC's ERC-20 interface on Arc is 6 decimals (the vault moves these units).
const VAULT_USDC_DECIMALS = 6;

export const VAULT_SOURCE_URL =
  'https://github.com/max-andrew/manila/blob/main/contracts/src/PayrollVaultV2.sol';
// Real txs this contract has executed on Arc — standing proof the path works.
export const VAULT_PROOF = {
  deploy_tx: '0xeccaab98eaeed190bf388a442f09d8aafaaf84f0b2561efe066d68ac1d66436e',
  schedule_tx: '0x84f4ff83f4ba8b87a60f4f0c1bef6c7ff71d1f099068d57e0845adda7b1522fd',
};

const VAULT_ABI = [
  { type: 'function', name: 'releaser', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'releasable', stateMutability: 'view', inputs: [{ name: 'b', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'vested', stateMutability: 'view', inputs: [{ name: 'b', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function', name: 'schedules', stateMutability: 'view', inputs: [{ name: 'b', type: 'address' }],
    outputs: [
      { name: 'total', type: 'uint256' }, { name: 'released', type: 'uint256' },
      { name: 'start', type: 'uint64' }, { name: 'cliff', type: 'uint64' },
      { name: 'duration', type: 'uint64' }, { name: 'exists', type: 'bool' },
    ],
  },
  { type: 'function', name: 'release', stateMutability: 'nonpayable', inputs: [{ name: 'b', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'resetClock', stateMutability: 'nonpayable', inputs: [{ name: 'b', type: 'address' }, { name: 'start', type: 'uint64' }, { name: 'cliff', type: 'uint64' }, { name: 'duration', type: 'uint64' }], outputs: [] },
] as const;

const usd = (micro: bigint) =>
  (Number(micro) / 10 ** VAULT_USDC_DECIMALS).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function publicClient(env: Env) {
  const rpc = env.ARC_RPC_URL || undefined;
  return createPublicClient({ chain: arcTestnet(rpc), transport: http(rpc) });
}

export type VestingSchedule = {
  beneficiary: string;
  total_micro: string;
  released_micro: string;
  releasable_micro: string;
  vested_micro: string;
  total_usd: string;
  released_usd: string;
  releasable_usd: string;
  vested_usd: string;
  start: number;
  cliff: number;
  duration: number;
  cliff_passed: boolean;
  vested_pct: number; // 0..100 of total
  released_pct: number; // 0..100 of total
};

// On-chain vesting state for one beneficiary, or null if no schedule exists.
export async function readVaultSchedule(env: Env, beneficiary: string): Promise<VestingSchedule | null> {
  const client = publicClient(env);
  const addr = beneficiary as `0x${string}`;
  const common = { address: PAYROLL_VAULT_ADDRESS, abi: VAULT_ABI } as const;
  const [schedule, releasable, vested] = await Promise.all([
    client.readContract({ ...common, functionName: 'schedules', args: [addr] }),
    client.readContract({ ...common, functionName: 'releasable', args: [addr] }),
    client.readContract({ ...common, functionName: 'vested', args: [addr] }),
  ]);
  const [total, released, start, cliff, duration, exists] = schedule as readonly [bigint, bigint, bigint, bigint, bigint, boolean];
  if (!exists) return null;
  const now = Math.floor(Date.now() / 1000);
  const pct = (n: bigint) => (total > 0n ? Math.min(100, Math.round((Number(n) / Number(total)) * 100)) : 0);
  return {
    beneficiary,
    total_micro: total.toString(),
    released_micro: released.toString(),
    releasable_micro: (releasable as bigint).toString(),
    vested_micro: (vested as bigint).toString(),
    total_usd: usd(total),
    released_usd: usd(released),
    releasable_usd: usd(releasable as bigint),
    vested_usd: usd(vested as bigint),
    start: Number(start),
    cliff: Number(cliff),
    duration: Number(duration),
    cliff_passed: now >= Number(cliff),
    vested_pct: pct(vested as bigint),
    released_pct: pct(released),
  };
}

export type ReleaseResult = {
  released: boolean;
  beneficiary: string;
  amount_micro?: string;
  amount_usd?: string;
  tx_hash?: string;
  explorer_url?: string;
  error?: string;
};

// Release vested USDC to a beneficiary. The transaction is signed by the
// Dynamic server wallet (the vault's `releaser`) in the sidecar, then broadcast
// from the Worker. Needs the sidecar running and the releaser funded with a
// little native USDC for gas.
export async function releaseVesting(env: Env, beneficiary: string): Promise<ReleaseResult> {
  const client = publicClient(env);
  const addr = beneficiary as `0x${string}`;
  // Signed and sent by the Dynamic treasury wallet (the vault's releaser) inside
  // sendFromReleaser — the agent never holds the key.
  const releasable = (await client.readContract({
    address: PAYROLL_VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: 'releasable',
    args: [addr],
  })) as bigint;
  if (releasable === 0n) {
    return { released: false, beneficiary, error: 'nothing vested to release yet' };
  }

  const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'release', args: [addr] });
  const hash = await sendFromReleaser(env, data);
  const receipt = await client.waitForTransactionReceipt({ hash });

  return {
    released: receipt.status === 'success',
    beneficiary,
    amount_micro: releasable.toString(),
    amount_usd: usd(releasable),
    tx_hash: hash,
    explorer_url: explorerTxUrl(hash),
  };
}

// Build, sidecar-sign (as the Dynamic releaser), and broadcast a call to the
// vault. Shared by release() and resetClock().
async function sendFromReleaser(env: Env, data: `0x${string}`): Promise<`0x${string}`> {
  const client = publicClient(env);
  const from = env.TREASURY_WALLET_ADDRESS as `0x${string}`;
  const [nonce, gas, fees] = await Promise.all([
    client.getTransactionCount({ address: from }),
    client.estimateGas({ account: from, to: PAYROLL_VAULT_ADDRESS, data }).catch(() => 150_000n),
    client.estimateFeesPerGas().catch(() => null),
  ]);
  const tx: Record<string, unknown> = { to: PAYROLL_VAULT_ADDRESS, data, value: 0n, gas, nonce, chainId: ARC_TESTNET_CHAIN_ID };
  if (fees?.maxFeePerGas) {
    tx.maxFeePerGas = fees.maxFeePerGas;
    tx.maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? fees.maxFeePerGas;
  } else {
    tx.gasPrice = await client.getGasPrice();
  }
  const signedTx = await signTransaction(env, tx);
  return client.sendRawTransaction({ serializedTransaction: signedTx });
}

export type ResetResult = {
  reset: boolean;
  beneficiary: string;
  releasable_usd?: string;
  tx_hash?: string;
  explorer_url?: string;
  error?: string;
};

// Re-arm a schedule's remaining funds over a fresh clock, started slightly in
// the past so a slice is immediately releasable — so the release flow always
// has something to show. Signed by the Dynamic releaser.
export async function resetVestingClock(env: Env, beneficiary: string): Promise<ResetResult> {
  const client = publicClient(env);
  const addr = beneficiary as `0x${string}`;
  const schedule = (await client.readContract({
    address: PAYROLL_VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'schedules', args: [addr],
  })) as readonly [bigint, bigint, bigint, bigint, bigint, boolean];
  const [total, released, , , duration, exists] = schedule;
  if (!exists) return { reset: false, beneficiary, error: 'no schedule for this beneficiary' };
  if (total - released === 0n) return { reset: false, beneficiary, error: 'fully released — nothing left to re-arm' };

  // Start the fresh clock 1/12 of the way in, so ~8% of the remaining vests at
  // once and the rest keeps streaming. Geometric, so it never fully drains.
  const dur = Number(duration) > 0 ? Number(duration) : 30 * 24 * 3600;
  const now = Math.floor(Date.now() / 1000);
  const start = BigInt(now - Math.floor(dur / 12));
  const data = encodeFunctionData({
    abi: VAULT_ABI, functionName: 'resetClock', args: [addr, start, start, BigInt(dur)],
  });
  const hash = await sendFromReleaser(env, data);
  const receipt = await client.waitForTransactionReceipt({ hash });
  const nowReleasable = (await client.readContract({
    address: PAYROLL_VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'releasable', args: [addr],
  })) as bigint;
  return {
    reset: receipt.status === 'success',
    beneficiary,
    releasable_usd: usd(nowReleasable),
    tx_hash: hash,
    explorer_url: explorerTxUrl(hash),
  };
}

export const vaultMeta = {
  address: PAYROLL_VAULT_ADDRESS,
  address_url: explorerAddressUrl(PAYROLL_VAULT_ADDRESS),
  source_url: VAULT_SOURCE_URL,
  deploy_tx_url: explorerTxUrl(VAULT_PROOF.deploy_tx),
  schedule_tx_url: explorerTxUrl(VAULT_PROOF.schedule_tx),
};
