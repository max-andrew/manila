// One-time M1 setup: create + register Unlink accounts for the treasury and
// the three seeded employees on arc-testnet, then print the SQL to point the
// employees table at their unlink1 addresses.
//
// Run: node scripts/setup-unlink.mjs   (needs UNLINK_API_KEY in .dev.vars)
// Output: scripts/.unlink-accounts.json (gitignored — holds demo mnemonics)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateMnemonic, english } from 'viem/accounts';
import { createUnlinkAdmin } from '@unlink-xyz/sdk/admin';
import { createUnlinkClient, account } from '@unlink-xyz/sdk/client';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT = join(here, '.unlink-accounts.json');
const ENV_NAME = 'arc-testnet';
const USDC = '0x3600000000000000000000000000000000000000';

const vars = Object.fromEntries(
  readFileSync(join(root, '.dev.vars'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
const apiKey = process.env.UNLINK_API_KEY ?? vars.UNLINK_API_KEY;
if (!apiKey) {
  console.error('UNLINK_API_KEY missing (set in .dev.vars)');
  process.exit(1);
}

const admin = createUnlinkAdmin({ environment: ENV_NAME, apiKey });

const saved = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};

async function ensureAccount(label) {
  const mnemonic = saved[label]?.mnemonic ?? generateMnemonic(english);
  const client = createUnlinkClient({
    environment: ENV_NAME,
    account: account.fromMnemonic({ mnemonic }),
    register: (payload) => admin.users.register(payload),
    authorizationToken: {
      provider: async (ctx) => {
        const issued = await admin.authorizationTokens.issue({
          subjectType: ctx.subjectType ?? 'unlink_address',
          unlinkAddress: ctx.unlinkAddress,
        });
        return { token: issued.token, expiresAt: issued.expiresAt };
      },
    },
  });
  await client.ensureRegistered();
  const address = await client.getAddress();
  console.log(`${label}: ${address}`);
  return { label, mnemonic, address, client };
}

const treasury = await ensureAccount('treasury');
const employees = [];
for (const label of ['employee-1', 'employee-2', 'employee-3']) {
  employees.push(await ensureAccount(label));
}

writeFileSync(
  OUT,
  JSON.stringify(
    Object.fromEntries(
      [treasury, ...employees].map((a) => [a.label, { mnemonic: a.mnemonic, address: a.address }])
    ),
    null,
    2
  )
);
console.log(`\nsaved -> ${OUT}`);

// Seed the treasury's private balance from the Unlink faucet (testnet only).
try {
  await treasury.client.faucet.requestPrivateTokens({ token: USDC });
  const balances = await treasury.client.getBalances();
  console.log('treasury private balances:', JSON.stringify(balances));
} catch (err) {
  console.error('faucet request failed (non-fatal):', err?.message ?? err);
}

console.log('\nApply to D1 (local and --remote):');
employees.forEach((e, i) => {
  console.log(
    `npx wrangler d1 execute manila --remote --command "UPDATE employees SET unlink_address = '${e.address}' WHERE id = ${i + 1};"`
  );
});
console.log(`\nAdd to .dev.vars:\nTREASURY_UNLINK_MNEMONIC=${treasury.mnemonic}`);
