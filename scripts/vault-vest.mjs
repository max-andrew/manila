// Seed a live vesting schedule on the deployed PayrollVault, so the demo has a
// real, accruing equity-style cliff the agent can release on Arc.
//
// Funds the Dynamic releaser wallet with a little native USDC for gas (so it
// can sign+send release()), then — as the employer (ops EOA) — approves and
// creates the schedule. createSchedule is one-per-beneficiary forever; pick a
// fresh beneficiary to re-seed.
//
// Run: node scripts/vault-vest.mjs [beneficiary] [totalUSDC] [durationSec] [cliffAgoSec] [startAgoSec]
// Defaults: Ada's wallet, 5 USDC over 6h, 30m start / 15m cliff in the past.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, createPublicClient, http, defineChain, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const v = Object.fromEntries(
  readFileSync(join(root, '.dev.vars'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
const opsKey = JSON.parse(readFileSync(join(here, '.gateway-ops.json'), 'utf8')).key;

const VAULT = '0xb18B2D0119Afde4868889cf42Eb8d272f1Fd90FC'; // PayrollVaultV2
const USDC = '0x3600000000000000000000000000000000000000';
const RELEASER = v.TREASURY_WALLET_ADDRESS;

// Defaults: a slow, long-horizon vest (equity-style) — 2 USDC over a year,
// started 60 days ago with the cliff 30 days past. Never fully vests during a
// demo; the agent's resetClock keeps a slice releasable. Override via args.
const beneficiary = process.argv[2] ?? '0x1111111111111111111111111111111111111111';
const totalUsd = Number(process.argv[3] ?? 2);
const duration = BigInt(process.argv[4] ?? 365 * 24 * 3600);
const cliffAgo = BigInt(process.argv[5] ?? 30 * 24 * 3600);
const startAgo = BigInt(process.argv[6] ?? 60 * 24 * 3600);
const total = BigInt(Math.round(totalUsd * 1e6)); // USDC ERC-20 is 6 decimals

const arc = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } } });
const account = privateKeyToAccount(opsKey);
const pub = createPublicClient({ chain: arc, transport: http() });
const wallet = createWalletClient({ account, chain: arc, transport: http() });

const erc20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const vaultAbi = parseAbi([
  'function createSchedule(address,uint256,uint64,uint64,uint64)',
  'function releasable(address) view returns (uint256)',
  'function schedules(address) view returns (uint256,uint256,uint64,uint64,uint64,bool)',
]);

// 1) Make sure the releaser (Dynamic wallet) has gas to send release() later.
const relGas = await pub.getBalance({ address: RELEASER });
console.log(`releaser ${RELEASER} native gas: ${Number(relGas) / 1e18} USDC`);
if (relGas < 100000000000000000n) {
  // < 0.1 USDC
  console.log('funding releaser with 0.5 USDC for gas…');
  const fh = await wallet.sendTransaction({ to: RELEASER, value: 500000000000000000n });
  await pub.waitForTransactionReceipt({ hash: fh });
  console.log(`  funded: ${fh}`);
}

// 2) Create the schedule as the employer (ops EOA).
const exists = (await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'schedules', args: [beneficiary] }))[5];
if (exists) {
  console.error(`a schedule already exists for ${beneficiary} — pick a fresh beneficiary to re-seed.`);
  process.exit(1);
}

const now = BigInt(Math.floor(Date.now() / 1000));
const start = now - startAgo;
const cliff = now - cliffAgo;
console.log(`\nschedule: ${totalUsd} USDC to ${beneficiary}`);
console.log(`  start ${startAgo}s ago, cliff ${cliffAgo}s ago (passed), vests over ${duration}s`);

console.log('approve…');
let h = await wallet.writeContract({ address: USDC, abi: erc20, functionName: 'approve', args: [VAULT, total] });
await pub.waitForTransactionReceipt({ hash: h });

console.log('createSchedule…');
h = await wallet.writeContract({ address: VAULT, abi: vaultAbi, functionName: 'createSchedule', args: [beneficiary, total, start, cliff, duration] });
const rcpt = await pub.waitForTransactionReceipt({ hash: h });
console.log(`  schedule tx: ${h} (block ${rcpt.blockNumber})`);
console.log(`  https://testnet.arcscan.app/tx/${h}`);

const releasable = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'releasable', args: [beneficiary] });
console.log(`\nreleasable now: ${Number(releasable) / 1e6} USDC (accrues until fully vested)`);
