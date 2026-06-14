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

// Deployed on Arc testnet. Constructor: usdc = native USDC's ERC-20 interface,
// releaser = the Dynamic treasury wallet (TREASURY_WALLET_ADDRESS).
export const PAYROLL_VAULT_ADDRESS = '0x2f217B2A62826F247084B207106233E5F67c60Ac' as const;
// USDC's ERC-20 interface on Arc is 6 decimals (the vault moves these units).
const VAULT_USDC_DECIMALS = 6;

export const VAULT_SOURCE_URL =
  'https://github.com/max-andrew/manila/blob/main/contracts/src/PayrollVault.sol';
// The real vest + release this contract has already executed on Arc (see
// contracts/README.md) — standing proof the path works end to end.
export const VAULT_PROOF = {
  schedule_tx: '0x8915b69980cbb4cfa58bdac5c1fd66c25d01d392006269ca839755b26a9cc894',
  release_tx: '0x9f38e8409dbf3cd4c04f5a3bc7f2e538783a68ef0bdcbb24fea6dc4ce5bf2ba5',
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
  // Signed and sent by the Dynamic treasury wallet — the vault's authorized
  // releaser. The agent never holds the key.
  const from = env.TREASURY_WALLET_ADDRESS as `0x${string}`;

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
  const [nonce, gas, fees] = await Promise.all([
    client.getTransactionCount({ address: from }),
    client.estimateGas({ account: from, to: PAYROLL_VAULT_ADDRESS, data }).catch(() => 150_000n),
    client.estimateFeesPerGas().catch(() => null),
  ]);

  const tx: Record<string, unknown> = {
    to: PAYROLL_VAULT_ADDRESS,
    data,
    value: 0n,
    gas,
    nonce,
    chainId: ARC_TESTNET_CHAIN_ID,
  };
  if (fees?.maxFeePerGas) {
    tx.maxFeePerGas = fees.maxFeePerGas;
    tx.maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? fees.maxFeePerGas;
  } else {
    tx.gasPrice = await client.getGasPrice();
  }

  const signedTx = await signTransaction(env, tx);
  const hash = await client.sendRawTransaction({ serializedTransaction: signedTx });
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

export const vaultMeta = {
  address: PAYROLL_VAULT_ADDRESS,
  address_url: explorerAddressUrl(PAYROLL_VAULT_ADDRESS),
  source_url: VAULT_SOURCE_URL,
  schedule_tx_url: explorerTxUrl(VAULT_PROOF.schedule_tx),
  release_tx_url: explorerTxUrl(VAULT_PROOF.release_tx),
};
