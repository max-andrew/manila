// Fund the treasury's Circle Gateway balance so it can pay the per-disbursement
// x402 nanopayment fees. The treasury is a Dynamic MPC wallet with no extractable
// key, so a small ops EOA (faucet-funded, key held here) deposits ON BEHALF OF
// the treasury via Gateway's depositFor — the treasury address ends up with the
// balance, and it alone signs the payment authorizations.
//
// Run: node scripts/fund-gateway.mjs [amountUSDC] [treasuryAddress]
//   1) first run prints the ops address → faucet it at faucet.circle.com (Arc Testnet)
//   2) treasury address defaults to TREASURY_WALLET_ADDRESS in .dev.vars
//   3) re-run to deposit (default $1.00 — thousands of $0.001 seals)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { GatewayClient } from '@circle-fin/x402-batching/client';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const KEYFILE = join(here, '.gateway-ops.json');

function devVars() {
  const path = join(root, '.dev.vars');
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  );
}

const vars = { ...devVars(), ...process.env };
const amount = process.argv[2] ?? '1.00';
const treasury = process.argv[3] ?? vars.TREASURY_WALLET_ADDRESS;

const opsKey = existsSync(KEYFILE) ? JSON.parse(readFileSync(KEYFILE, 'utf8')).key : generatePrivateKey();
writeFileSync(KEYFILE, JSON.stringify({ key: opsKey }, null, 2));
const opsAddress = privateKeyToAccount(opsKey).address;
console.log(`ops EOA (faucet this): ${opsAddress}`);

if (!treasury) {
  console.error('\nNo treasury address. Pass it as arg 2, or set TREASURY_WALLET_ADDRESS in .dev.vars');
  console.error('(run the sidecar first — it prints and provisions the treasury wallet).');
  process.exit(1);
}
console.log(`treasury (depositing for): ${treasury}`);

const gateway = new GatewayClient({ chain: 'arcTestnet', privateKey: opsKey });
const { balance } = await gateway.getUsdcBalance();
console.log(`ops USDC balance: ${(Number(balance) / 1e6).toFixed(6)}`);

if (Number(balance) < Number(amount) * 1e6) {
  console.log(`\nNot enough USDC. Faucet the ops address above, then re-run.`);
  process.exit(0);
}

console.log(`\ndepositing ${amount} USDC into the treasury's Gateway balance…`);
const result = await gateway.depositFor(amount, treasury);
console.log(`approval tx: ${result.approvalTxHash ?? '(already approved)'}`);
console.log(`deposit  tx: ${result.depositTxHash}`);

const balances = await gateway.getBalances(treasury);
console.log('treasury Gateway balance:', JSON.stringify(balances, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
console.log('\nDone. The treasury can now pay seal-fee nanopayments.');
