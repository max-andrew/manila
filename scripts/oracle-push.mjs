// Relay the live AAPL/USD price from Pyth (Hermes, free, no key) onto Arc, into
// the PythPriceRelay the RSU vault reads. Stocks don't trade 24/7, so we pull
// the regular feed plus its pre/post/overnight sessions and post the freshest —
// always a real, recent Apple share price.
//
// Run: node scripts/oracle-push.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, createPublicClient, http, defineChain, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const opsKey = JSON.parse(readFileSync(join(here, '.gateway-ops.json'), 'utf8')).key;

const RELAY = '0xb8e18484bebC0356A67293590B8affE2b55e3424';
// Canonical Pyth AAPL/USD feed id (what the vault reads).
const AAPL = '0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688';
// Sessions to consider for the freshest tick (regular, post, pre, overnight).
const SESSIONS = [
  '0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688',
  '0x5a207c4aa0114baecf852fcd9db9beb8ec715f2db48caa525dbd878fd416fb09',
  '0x8c320e4cd87c6cef41513aead15db413cf9253211923fef6e87187a7f6688906',
  '0x241b9a5ce1c3e4bfc68e377158328628f1b478afaa796c4b1760bd3713c2d2d2',
];

const url = `https://hermes.pyth.network/v2/updates/price/latest?${SESSIONS.map((s) => `ids[]=${s}`).join('&')}`;
const res = await fetch(url);
const data = await res.json();
const freshest = data.parsed.sort((a, b) => Number(b.price.publish_time) - Number(a.price.publish_time))[0];
const { price, conf, expo, publish_time } = freshest.price;
console.log(`AAPL/USD = $${(Number(price) * 10 ** Number(expo)).toFixed(2)}  (published ${new Date(Number(publish_time) * 1000).toISOString()})`);

const arc = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } } });
const account = privateKeyToAccount(opsKey);
const pub = createPublicClient({ chain: arc, transport: http() });
const wallet = createWalletClient({ account, chain: arc, transport: http() });
const abi = parseAbi(['function pushPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime)']);

const h = await wallet.writeContract({
  address: RELAY,
  abi,
  functionName: 'pushPrice',
  args: [AAPL, BigInt(price), BigInt(conf), Number(expo), BigInt(publish_time)],
});
await pub.waitForTransactionReceipt({ hash: h });
console.log(`relayed on-chain: ${h}`);
console.log(`https://testnet.arcscan.app/tx/${h}`);
