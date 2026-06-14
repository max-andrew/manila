// Re-fund and re-arm the V3 equity demo on Arc: top up the vault's USDC payout
// pool, grant/extend an employee's RSU shares, and reset the clock so a slice is
// immediately releasable (and the grant can't fully drain). Run when the demo
// runs low. The oracle price comes from scripts/oracle-push.mjs.
//
// Run: node scripts/vault-vest.mjs [beneficiary] [fundUSDC] [topUpShares]
// Defaults: Ada's wallet, fund 0.3 USDC, grant 0.001 RSU shares.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, createPublicClient, http, defineChain, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const opsKey = JSON.parse(readFileSync(join(here, '.gateway-ops.json'), 'utf8')).key;

const VAULT = '0x021Bf03C10ed7d8205aaD4dE6D3847D94715B06b'; // PayrollVaultV3
const USDC = '0x3600000000000000000000000000000000000000';

const beneficiary = process.argv[2] ?? '0x1111111111111111111111111111111111111111';
const fund = BigInt(Math.round(Number(process.argv[3] ?? 0.3) * 1e6)); // USDC, 6 dec
const shares = BigInt(Math.round(Number(process.argv[4] ?? 0.001) * 1e6)) * 10n ** 12n; // RSU shares, 18 dec
const DURATION = 172800n; // 2 days
const OFFSET = 43200n; // start 1/4 in, so ~25% is vested immediately

const arc = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } } });
const account = privateKeyToAccount(opsKey);
const pub = createPublicClient({ chain: arc, transport: http() });
const wallet = createWalletClient({ account, chain: arc, transport: http() });
// USDC is the native gas token, so an over-eager gas estimate can trip a tight
// balance — pass explicit gas limits.
const GAS = { gas: 150000n };

const erc20 = parseAbi(['function approve(address,uint256) returns (bool)']);
const vaultAbi = parseAbi([
  'function fundPool(uint256)',
  'function createSchedule(address,uint256,uint64,uint64,uint64)',
  'function topUp(address,uint256)',
  'function resetClock(address,uint64,uint64,uint64)',
  'function schedules(address) view returns (uint256,uint256,uint64,uint64,uint64,bool)',
  'function releasableUsdc(address) view returns (uint256)',
]);

async function send(label, params) {
  const h = await wallet.writeContract({ ...params, ...GAS });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  ${label}: ${h}`);
}

console.log(`fund pool ${Number(fund) / 1e6} USDC + grant ${Number(shares) / 1e18} shares to ${beneficiary}`);
await send('approve', { address: USDC, abi: erc20, functionName: 'approve', args: [VAULT, fund] });
await send('fundPool', { address: VAULT, abi: vaultAbi, functionName: 'fundPool', args: [fund] });

const now = BigInt(Math.floor(Date.now() / 1000));
const start = now - OFFSET;
const exists = (await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'schedules', args: [beneficiary] }))[5];
if (exists) {
  await send('topUp', { address: VAULT, abi: vaultAbi, functionName: 'topUp', args: [beneficiary, shares] });
  await send('resetClock', { address: VAULT, abi: vaultAbi, functionName: 'resetClock', args: [beneficiary, start, start, DURATION] });
} else {
  await send('createSchedule', { address: VAULT, abi: vaultAbi, functionName: 'createSchedule', args: [beneficiary, shares, start, start, DURATION] });
}

const releasable = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'releasableUsdc', args: [beneficiary] });
console.log(`releasable now: $${(Number(releasable) / 1e6).toFixed(4)} (priced by the AAPL oracle)`);
