// Drive one real payment through the deployed PayrollVault on Arc testnet:
// approve → createSchedule (funds the vault) → release → verify USDC landed.
// Uses the ops EOA as the employer; the releaser is the treasury (agent) wallet.
//
// Run: node scripts/vault-demo.mjs <vaultAddress> [beneficiary]

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, createPublicClient, http, defineChain, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const vault = process.argv[2];
if (!vault) { console.error('usage: node scripts/vault-demo.mjs <vaultAddress> [beneficiary]'); process.exit(1); }

const v = Object.fromEntries(readFileSync(join(here,'..','.dev.vars'),'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')).trim(),l.slice(l.indexOf('=')+1).trim()]));
const opsKey = JSON.parse(readFileSync(join(here,'.gateway-ops.json'),'utf8')).key;
const USDC = '0x3600000000000000000000000000000000000000';
const beneficiary = process.argv[3] ?? v.SEAL_FEE_ADDRESS;
const AMOUNT = 500000n; // 0.5 USDC (6 decimals)

const arc = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name:'USDC', symbol:'USDC', decimals:18 }, rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } } });
const account = privateKeyToAccount(opsKey);
const pub = createPublicClient({ chain: arc, transport: http() });
const wallet = createWalletClient({ account, chain: arc, transport: http() });

const erc20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const vaultAbi = parseAbi(['function createSchedule(address,uint256,uint64,uint64,uint64)', 'function release(address) returns (uint256)', 'function releasable(address) view returns (uint256)']);

const before = await pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [beneficiary] });
console.log(`beneficiary ${beneficiary}`);
console.log(`USDC before: ${Number(before)/1e6}`);

const now = BigInt(Math.floor(Date.now()/1000));
console.log('approve…');
let h = await wallet.writeContract({ address: USDC, abi: erc20, functionName: 'approve', args: [vault, AMOUNT] });
await pub.waitForTransactionReceipt({ hash: h });

console.log('createSchedule (0.5 USDC, vests over 1s)…');
h = await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: 'createSchedule', args: [beneficiary, AMOUNT, now, now, 1n] });
await pub.waitForTransactionReceipt({ hash: h });
console.log(`  schedule tx: ${h}`);

const claimable = await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'releasable', args: [beneficiary] });
console.log(`releasable now: ${Number(claimable)/1e6} USDC`);

console.log('release…');
h = await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: 'release', args: [beneficiary] });
const rcpt = await pub.waitForTransactionReceipt({ hash: h });
console.log(`  release tx: ${h} (block ${rcpt.blockNumber})`);

const after = await pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [beneficiary] });
console.log(`USDC after: ${Number(after)/1e6}  (+${Number(after-before)/1e6})`);
console.log(`https://testnet.arcscan.app/tx/${h}`);
