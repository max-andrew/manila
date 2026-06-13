// Generate the Unlink accounts OFFLINE — mnemonic + unlink1 address for the
// treasury and the three employees. No API key, no network: this is pure local
// key derivation. Registration + faucet still need UNLINK_API_KEY and happen in
// scripts/setup-unlink.mjs, which reuses the accounts persisted here.
//
// Run: node scripts/gen-unlink-accounts.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateMnemonic, english } from 'viem/accounts';
import { account } from '@unlink-xyz/sdk/client';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '.unlink-accounts.json');
const LABELS = ['treasury', 'employee-1', 'employee-2', 'employee-3'];

const saved = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const out = {};

for (const label of LABELS) {
  const mnemonic = saved[label]?.mnemonic ?? generateMnemonic(english);
  const address = await account.fromMnemonic({ mnemonic }).getAddress();
  out[label] = { mnemonic, address };
}

writeFileSync(OUT, JSON.stringify(out, null, 2));

console.log('Unlink accounts (offline-generated):\n');
for (const label of LABELS) console.log(`  ${label.padEnd(11)} ${out[label].address}`);

console.log('\nAdd to .dev.vars:');
console.log(`TREASURY_UNLINK_MNEMONIC=${out.treasury.mnemonic}`);

console.log('\nApply to D1 (run for --local and --remote):');
LABELS.slice(1).forEach((label, i) => {
  console.log(
    `npx wrangler d1 execute manila --remote --command "UPDATE employees SET unlink_address = '${out[label].address}' WHERE id = ${i + 1};"`
  );
});

console.log(`\nSaved to ${OUT} — setup-unlink.mjs will register + faucet these once UNLINK_API_KEY is set.`);
