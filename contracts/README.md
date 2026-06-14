# PayrollVault — programmable equity vesting on Arc

Solidity for the on-chain disbursement rail. The current contract,
**`PayrollVaultV3`**, is **equity that settles in cash**: each employee vests RSU
**shares** (cliff + linear), and on `release()` the contract reads a live company
share price from an on-chain **oracle** and pays the vested shares' value in
**USDC**. A grant tracks the real stock but settles in stablecoin. Every release
emits an event the off-chain audit log records.

This is the **Arc "Advanced Stablecoin Logic"** track: multi-step settlement
(oracle read → share→USDC conversion → transfer), deployed and exercised on Arc.

## Deployed (Arc testnet)

- **PayrollVaultV3 (current):** [`0x021Bf03C10ed7d8205aaD4dE6D3847D94715B06b`](https://testnet.arcscan.app/address/0x021Bf03C10ed7d8205aaD4dE6D3847D94715B06b) — RSU shares, oracle-priced, USDC-settled.
- **PythPriceRelay (oracle):** [`0xb8e18484bebC0356A67293590B8affE2b55e3424`](https://testnet.arcscan.app/address/0xb8e18484bebC0356A67293590B8affE2b55e3424)
- Earlier USDC-denominated vaults: V2 [`0xb18B2D…90FC`](https://testnet.arcscan.app/address/0xb18B2D0119Afde4868889cf42Eb8d272f1Fd90FC), V1 [`0x2f217B2A…60Ac`](https://testnet.arcscan.app/address/0x2f217B2A62826F247084B207106233E5F67c60Ac).
- V3 constructor: `usdc` (native USDC's ERC-20 interface), `oracle` (the relay), `priceId` (Pyth AAPL/USD), `releaser` (the Dynamic treasury/agent wallet). Gas paid in USDC (Arc native).

## The oracle (Pyth-shaped, swappable)

`PayrollVaultV3` consumes the **standard Pyth `IPyth` interface** (`getPriceUnsafe`).
Where Arc has no canonical Pyth deployment yet, **`PythPriceRelay`** implements that
same interface and is fed the real **AAPL/USD** price from Pyth's free
[Hermes](https://hermes.pyth.network) service (`scripts/oracle-push.mjs` pulls the
freshest regular/pre/post/overnight tick and posts it on-chain). Pointing the vault
at a native Pyth contract later is a constructor address change — **zero contract
edits**. The release payout literally tracks Apple's share price.

## Contract surface

- **`createSchedule(beneficiary, totalShares, start, cliff, duration)`** — grant an RSU schedule (shares, 18-dec); employer only.
- **`fundPool(amount)`** — top the shared USDC pool that release pays from.
- **`release(beneficiary)`** — pay the vested shares' current USDC value; callable by beneficiary, employer, or the agent releaser.
- **`resetClock(beneficiary, start, cliff, duration)`** — re-arm the *remaining* (unreleased) shares over a fresh clock, no new grant; can never promise more shares than are left. The agent uses this so the release flow always has something to show.
- **`topUp(beneficiary, addShares)`** — grant more shares.
- Views: `vestedShares`, `releasableShares`, `quoteUsdc(shares)`, `releasableUsdc`.

## How it fits

The default rail seals salaries privately via Unlink (hidden on the explorer). The
vault is the **publicly-verifiable** equity rail: the employer grants shares and
funds the pool once, and the agent `release()`s (and `resetClock()`s) as they vest
— each call a real USDC transaction on Arc, signed by the Dynamic server wallet,
logged to the same audit trail.

## Develop

```sh
cd contracts
forge install foundry-rs/forge-std   # first time
forge test                            # 20 tests across V1/V2/V3, incl. proof the V3
                                      # payout tracks the oracle price, reset re-arms
                                      # remaining shares, and an underfunded pool reverts

# deploy V3 (usdc, oracle relay, AAPL feed id, releaser)
forge create src/PythPriceRelay.sol:PythPriceRelay --constructor-args <relayer> ...
forge create src/PayrollVaultV3.sol:PayrollVaultV3 --constructor-args \
  0x3600000000000000000000000000000000000000 <relay> <aaplFeedId> <agentWallet> ...

# relay a real AAPL/USD price on-chain, then grant + fund a schedule
node ../scripts/oracle-push.mjs
```
