# PayrollVault — programmable USDC vesting on Arc

A ~95-line Solidity vault for the optional on-chain disbursement path: per-employee **cliff + linear** vesting in USDC, funded up front by the employer, with `release()` callable by the agent wallet. Every release emits a `Released` event the off-chain audit log records.

This is the **Arc "Advanced Stablecoin Logic"** track — programmable payroll/vesting in USDC, deployed and exercised on Arc testnet.

## Deployed (Arc testnet)

- **PayrollVault:** [`0x2f217B2A62826F247084B207106233E5F67c60Ac`](https://testnet.arcscan.app/address/0x2f217B2A62826F247084B207106233E5F67c60Ac)
- Constructor: `usdc = 0x3600…0000` (native USDC's ERC-20 interface), `releaser = 0x599927…2e32` (the Dynamic treasury/agent wallet)
- A real vest + release: schedule [`0x8915b699…`](https://testnet.arcscan.app/tx/0x8915b69980cbb4cfa58bdac5c1fd66c25d01d392006269ca839755b26a9cc894), release [`0x9f38e840…`](https://testnet.arcscan.app/tx/0x9f38e8409dbf3cd4c04f5a3bc7f2e538783a68ef0bdcbb24fea6dc4ce5bf2ba5) — 0.5 USDC vested and paid out. Gas paid in USDC (Arc native).

## How it fits

The main disbursement path seals salaries privately via Unlink. The vault is the **programmable** alternative for an employee on a vesting plan (e.g. an equity-style cliff): the employer funds the schedule once, and the agent calls `release()` as funds vest — each release a real USDC transfer on Arc, logged to the same audit trail.

## Develop

```sh
cd contracts
forge install foundry-rs/forge-std   # first time
forge test                            # cliff, linear, no-double-release, authorization

# deploy
forge create src/PayrollVault.sol:PayrollVault --rpc-url https://rpc.testnet.arc.network \
  --private-key <key> --broadcast \
  --constructor-args 0x3600000000000000000000000000000000000000 <agentWallet>

# drive one payment through it
node ../scripts/vault-demo.mjs <vaultAddress> [beneficiary]
```
