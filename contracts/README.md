# PayrollVault — programmable USDC vesting on Arc

A small Solidity vault for the on-chain disbursement path: per-employee **cliff + linear** vesting in USDC, funded up front by the employer, with `release()` callable by the agent wallet. Every release emits an event the off-chain audit log records.

This is the **Arc "Advanced Stablecoin Logic"** track — programmable payroll/vesting in USDC, deployed and exercised on Arc testnet.

## Deployed (Arc testnet)

- **PayrollVaultV2 (current):** [`0xb18B2D0119Afde4868889cf42Eb8d272f1Fd90FC`](https://testnet.arcscan.app/address/0xb18B2D0119Afde4868889cf42Eb8d272f1Fd90FC) — adds `resetClock` and `topUp`.
- **PayrollVault (V1):** [`0x2f217B2A62826F247084B207106233E5F67c60Ac`](https://testnet.arcscan.app/address/0x2f217B2A62826F247084B207106233E5F67c60Ac)
- Constructor: `usdc = 0x3600…0000` (native USDC's ERC-20 interface), `releaser = 0x599927…2e32` (the Dynamic treasury/agent wallet). Gas paid in USDC (Arc native).

## V2: keeping a long schedule live

A pure cliff+linear schedule eventually fully vests and, once fully released, has nothing left to release. V2 adds two operations so a real, long-horizon schedule stays demoable and useful:

- **`resetClock(beneficiary, start, cliff, duration)`** — re-arm the schedule's *remaining* (unreleased) funds over a fresh clock, **without** a new deposit. The new total is whatever the vault still holds for that beneficiary, so it can never promise more than it has. Callable by the employer or the agent releaser. Start it slightly in the past to make a slice immediately releasable — the agent uses this so the release flow always has something to show, draining geometrically and never hitting zero.
- **`topUp(beneficiary, amount)`** — add more USDC to an existing schedule.

## How it fits

The main disbursement path seals salaries privately via Unlink. The vault is the **programmable, publicly-verifiable** alternative for an employee on a vesting plan (e.g. an equity-style cliff): the employer funds the schedule once, and the agent calls `release()` (and `resetClock()`) as funds vest — each call a real USDC transaction on Arc, signed by the Dynamic server wallet, logged to the same audit trail.

## Develop

```sh
cd contracts
forge install foundry-rs/forge-std   # first time
forge test                            # V1: cliff gating + chunk-unlock, linear vest,
                                      # no-double-release, authorization, releaser rotation
                                      # V2: reset re-arms remaining, never over-promises,
                                      # employer/releaser auth, topUp

# deploy V2
forge create src/PayrollVaultV2.sol:PayrollVaultV2 --rpc-url https://rpc.testnet.arc.network \
  --private-key <key> --broadcast \
  --constructor-args 0x3600000000000000000000000000000000000000 <agentWallet>

# seed a slow, long-horizon schedule (and top up the releaser's gas)
node ../scripts/vault-vest.mjs [beneficiary] [totalUSDC] [durationSec] [cliffAgoSec] [startAgoSec]
```
