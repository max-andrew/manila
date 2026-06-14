// PayrollVaultV3 — RSU vesting, settled in USDC, priced by an oracle (Arc
// "Advanced Stablecoin Logic"). Each employee vests a number of equity SHARES
// (cliff + linear); on release the contract reads a live company stock price
// from a Pyth-shaped oracle on Arc and pays the vested shares' value in USDC.
// So the grant is equity (its USDC value tracks the real share price) that
// settles in cash — and every release is publicly verifiable on the explorer.
//
// The Worker only READS the contract and BROADCASTS a release/reset that the
// Dynamic server wallet (the vault's `releaser`) signs in the sidecar. The agent
// holds no keys; the employer key that grants/funds never touches the Worker.

import { createPublicClient, http, encodeFunctionData } from 'viem';
import { arcTestnet, ARC_TESTNET_CHAIN_ID, explorerTxUrl, explorerAddressUrl } from './arc';
import { signTransaction } from './signer';
import type { Env } from '../env';

export const PAYROLL_VAULT_ADDRESS = '0x021Bf03C10ed7d8205aaD4dE6D3847D94715B06b' as const;
// PythPriceRelay on Arc — fed real AAPL/USD from Pyth Hermes, read via IPyth.
export const PRICE_RELAY_ADDRESS = '0xb8e18484bebC0356A67293590B8affE2b55e3424' as const;
// Pyth AAPL/USD feed id (the equity the RSUs track).
export const PRICE_FEED_ID = '0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688' as const;
export const EQUITY_TICKER = 'AAPL';
const USDC_DECIMALS = 6;

export const VAULT_SOURCE_URL =
  'https://github.com/max-andrew/manila/blob/main/contracts/src/PayrollVaultV3.sol';
export const VAULT_PROOF = {
  schedule_tx: '0x7448cb5f13dc295e3947cf73f2b0526755f081a53db682d9a0d9d960b8947ed5',
  oracle_tx: '0x0da23eeec57092d28c1a2be4a16e865a1a6695acd69ea7418a9f6da3dfcf0021',
};
const PYTH_FEED_URL = 'https://www.pyth.network/price-feeds/equity-us-aapl-usd';

const VAULT_ABI = [
  { type: 'function', name: 'releaser', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'releasableShares', stateMutability: 'view', inputs: [{ name: 'b', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'releasableUsdc', stateMutability: 'view', inputs: [{ name: 'b', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'vestedShares', stateMutability: 'view', inputs: [{ name: 'b', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'quoteUsdc', stateMutability: 'view', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function', name: 'schedules', stateMutability: 'view', inputs: [{ name: 'b', type: 'address' }],
    outputs: [
      { name: 'totalShares', type: 'uint256' }, { name: 'releasedShares', type: 'uint256' },
      { name: 'start', type: 'uint64' }, { name: 'cliff', type: 'uint64' },
      { name: 'duration', type: 'uint64' }, { name: 'exists', type: 'bool' },
    ],
  },
  { type: 'function', name: 'release', stateMutability: 'nonpayable', inputs: [{ name: 'b', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'resetClock', stateMutability: 'nonpayable', inputs: [{ name: 'b', type: 'address' }, { name: 'start', type: 'uint64' }, { name: 'cliff', type: 'uint64' }, { name: 'duration', type: 'uint64' }], outputs: [] },
] as const;

const RELAY_ABI = [
  {
    type: 'function', name: 'getPriceUnsafe', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{
      type: 'tuple',
      components: [
        { name: 'price', type: 'int64' }, { name: 'conf', type: 'uint64' },
        { name: 'expo', type: 'int32' }, { name: 'publishTime', type: 'uint64' },
      ],
    }],
  },
] as const;

const usd = (micro: bigint) =>
  (Number(micro) / 10 ** USDC_DECIMALS).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shares = (raw: bigint) => (Number(raw) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

function publicClient(env: Env) {
  const rpc = env.ARC_RPC_URL || undefined;
  return createPublicClient({ chain: arcTestnet(rpc), transport: http(rpc) });
}

// Live oracle reading (the company share price driving the RSU value).
export async function readOraclePrice(env: Env): Promise<{ ticker: string; price_usd: string; updated_at: number } | null> {
  try {
    const p = (await publicClient(env).readContract({
      address: PRICE_RELAY_ADDRESS, abi: RELAY_ABI, functionName: 'getPriceUnsafe', args: [PRICE_FEED_ID],
    })) as { price: bigint; expo: number; publishTime: bigint };
    const value = Number(p.price) * 10 ** Number(p.expo);
    return { ticker: EQUITY_TICKER, price_usd: value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), updated_at: Number(p.publishTime) };
  } catch {
    return null;
  }
}

export type VestingSchedule = {
  beneficiary: string;
  total_shares: string;
  released_shares: string;
  total_usd: string;
  released_usd: string;
  vested_usd: string;
  releasable_usd: string;
  start: number;
  cliff: number;
  duration: number;
  cliff_passed: boolean;
  vested_pct: number;
  released_pct: number;
};

export async function readVaultSchedule(env: Env, beneficiary: string): Promise<VestingSchedule | null> {
  const client = publicClient(env);
  const addr = beneficiary as `0x${string}`;
  const common = { address: PAYROLL_VAULT_ADDRESS, abi: VAULT_ABI } as const;
  const [schedule, vestedSh] = await Promise.all([
    client.readContract({ ...common, functionName: 'schedules', args: [addr] }),
    client.readContract({ ...common, functionName: 'vestedShares', args: [addr] }),
  ]);
  const [total, released, start, cliff, duration, exists] = schedule as readonly [bigint, bigint, bigint, bigint, bigint, boolean];
  if (!exists) return null;
  // Value the share amounts at the current oracle price.
  const [totalUsd, vestedUsd, releasedUsd, releasableUsd] = await Promise.all([
    client.readContract({ ...common, functionName: 'quoteUsdc', args: [total] }),
    client.readContract({ ...common, functionName: 'quoteUsdc', args: [vestedSh as bigint] }),
    client.readContract({ ...common, functionName: 'quoteUsdc', args: [released] }),
    client.readContract({ ...common, functionName: 'releasableUsdc', args: [addr] }),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const pct = (n: bigint) => (total > 0n ? Math.min(100, Math.round((Number(n) / Number(total)) * 100)) : 0);
  return {
    beneficiary,
    total_shares: shares(total),
    released_shares: shares(released),
    total_usd: usd(totalUsd as bigint),
    released_usd: usd(releasedUsd as bigint),
    vested_usd: usd(vestedUsd as bigint),
    releasable_usd: usd(releasableUsd as bigint),
    start: Number(start),
    cliff: Number(cliff),
    duration: Number(duration),
    cliff_passed: now >= Number(cliff),
    vested_pct: pct(vestedSh as bigint),
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

export async function releaseVesting(env: Env, beneficiary: string): Promise<ReleaseResult> {
  const client = publicClient(env);
  const addr = beneficiary as `0x${string}`;
  const owed = (await client.readContract({
    address: PAYROLL_VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'releasableUsdc', args: [addr],
  })) as bigint;
  if (owed === 0n) return { released: false, beneficiary, error: 'nothing vested to release yet' };

  const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'release', args: [addr] });
  const hash = await sendFromReleaser(env, data);
  const receipt = await client.waitForTransactionReceipt({ hash });
  return {
    released: receipt.status === 'success',
    beneficiary,
    amount_micro: owed.toString(),
    amount_usd: usd(owed),
    tx_hash: hash,
    explorer_url: explorerTxUrl(hash),
  };
}

async function sendFromReleaser(env: Env, data: `0x${string}`): Promise<`0x${string}`> {
  const client = publicClient(env);
  const from = env.TREASURY_WALLET_ADDRESS as `0x${string}`;
  const [nonce, gas, fees] = await Promise.all([
    // 'pending' so back-to-back releases/resets don't reuse a nonce that's still
    // in the mempool ("nonce too low").
    client.getTransactionCount({ address: from, blockTag: 'pending' }),
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

export async function resetVestingClock(env: Env, beneficiary: string): Promise<ResetResult> {
  const client = publicClient(env);
  const addr = beneficiary as `0x${string}`;
  const schedule = (await client.readContract({
    address: PAYROLL_VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'schedules', args: [addr],
  })) as readonly [bigint, bigint, bigint, bigint, bigint, boolean];
  const [total, released, , , , exists] = schedule;
  if (!exists) return { reset: false, beneficiary, error: 'no schedule for this beneficiary' };
  if (total - released === 0n) return { reset: false, beneficiary, error: 'fully released — nothing left to re-arm' };

  // Re-arm over a long (2-day) clock with ~25% already vested: a slice is
  // immediately releasable and the cliff is passed, but the grant can't fully
  // vest during a demo — so a single release never drains it. Each reset re-arms
  // the remaining shares, shrinking geometrically, never reaching zero.
  const dur = 172800;
  const now = Math.floor(Date.now() / 1000);
  const start = BigInt(now - Math.floor(dur / 4));
  const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'resetClock', args: [addr, start, start, BigInt(dur)] });
  const hash = await sendFromReleaser(env, data);
  const receipt = await client.waitForTransactionReceipt({ hash });
  const nowReleasable = (await client.readContract({
    address: PAYROLL_VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'releasableUsdc', args: [addr],
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
  schedule_tx_url: explorerTxUrl(VAULT_PROOF.schedule_tx),
  oracle: {
    ticker: EQUITY_TICKER,
    relay_address: PRICE_RELAY_ADDRESS,
    relay_url: explorerAddressUrl(PRICE_RELAY_ADDRESS),
    feed_url: PYTH_FEED_URL,
    relay_tx_url: explorerTxUrl(VAULT_PROOF.oracle_tx),
  },
};
