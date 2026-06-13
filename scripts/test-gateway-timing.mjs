// Answers empirically: how fast does a Gateway-batched x402 payment settle
// on Arc testnet, and is settle's `transaction` a real on-chain hash?
//
// Run once with no funds to print the test address, faucet it at
// https://faucet.circle.com (Arc Testnet), then run again.
// Uses throwaway keys (scripts/.gateway-test.json, gitignored) — independent
// of the Dynamic/Unlink stack, so it needs no sponsor credentials.

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http as viemHttp } from 'viem';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';

const here = dirname(fileURLToPath(import.meta.url));
const KEYFILE = join(here, '.gateway-test.json');

const keys = existsSync(KEYFILE)
  ? JSON.parse(readFileSync(KEYFILE, 'utf8'))
  : { buyer: generatePrivateKey(), seller: generatePrivateKey() };
writeFileSync(KEYFILE, JSON.stringify(keys, null, 2));

const buyerAddress = privateKeyToAccount(keys.buyer).address;
const sellerAddress = privateKeyToAccount(keys.seller).address;
console.log(`buyer  (faucet this): ${buyerAddress}`);
console.log(`seller (fee sink):    ${sellerAddress}`);

const gateway = new GatewayClient({ chain: 'arcTestnet', privateKey: keys.buyer });
const balances = await gateway.getBalances();
console.log('balances:', JSON.stringify(balances, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

const usdc = await gateway.getUsdcBalance();
const walletUsdc = Number(usdc?.balance ?? usdc ?? 0);
const gatewayBalance = Number(balances?.gateway?.available ?? balances?.available ?? 0);
if (walletUsdc === 0 && gatewayBalance === 0) {
  console.log('\nNo funds yet. Faucet the buyer address above, then re-run.');
  process.exit(0);
}

if (gatewayBalance < 10_000) {
  console.log('\ndepositing 2.00 USDC into Gateway…');
  const t = Date.now();
  const dep = await gateway.deposit('2.00');
  console.log(`deposit tx ${dep.depositTxHash} (+${Date.now() - t}ms)`);
}

// Minimal x402 seller on localhost (Express-shaped middleware on bare node:http).
const mw = createGatewayMiddleware({ sellerAddress }).require('$0.001');
const server = http.createServer((req, res) =>
  mw(req, res, () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, paid: req.payment }));
  })
);
await new Promise((r) => server.listen(8902, r));

console.log('\npaying $0.001 via x402…');
const t0 = Date.now();
const result = await gateway.pay('http://localhost:8902/resource');
const tPay = Date.now() - t0;
const settlement = result?.settlement ?? result?.paymentResponse ?? result;
console.log(`pay() returned in ${tPay}ms`);
console.log('pay result:', JSON.stringify(settlement, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 600));

const txHash = settlement?.transaction ?? result?.transaction;
server.close();
if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(String(txHash))) {
  console.log(`\nsettle returned "${txHash}" — not an on-chain hash; settlement is deferred/netted later.`);
  console.log('Re-run scripts/check-settlement.mjs (or this script) later and compare seller Gateway balance.');
  process.exit(0);
}

console.log(`\npolling Arc for settlement tx ${txHash}…`);
const pub = createPublicClient({ transport: viemHttp('https://rpc.testnet.arc.network') });
const start = Date.now();
for (;;) {
  try {
    const receipt = await pub.getTransactionReceipt({ hash: txHash });
    console.log(`ON-CHAIN after ${((Date.now() - start) / 1000).toFixed(1)}s — block ${receipt.blockNumber}, status ${receipt.status}`);
    console.log(`https://testnet.arcscan.app/tx/${txHash}`);
    break;
  } catch {
    if (Date.now() - start > 180_000) {
      console.log('not on-chain after 180s — settlement batches on a longer interval; show a prior settlement in the demo.');
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
