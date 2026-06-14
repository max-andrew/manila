# Manila — architecture

Two diagrams: the system end-to-end, and the oracle-priced RSU vesting path in
detail. Both render on GitHub; PNG exports are in `docs/diagrams/` (see
`scripts/render-diagrams.sh`).

## System overview

![Manila system architecture](diagrams/system.png)

```mermaid
flowchart TB
  Employer(["Employer"]) -->|plain-English command| Agent

  subgraph CF["Cloudflare Worker (Hono + D1)"]
    Agent["AI agent — Workers AI<br/>Llama 3.3 70B, function calling"]
    Policy["Deterministic policy engine<br/>cap · hard ceiling · pay band · allowlist"]
    Agent --> Policy
    Policy -->|review| Approval["Maker-checker<br/>2nd signature"]
    Audit[("Audit log → CSV")]
  end

  Sidecar["Signing sidecar (Node)<br/><b>Dynamic</b> MPC 2-of-2 server wallet"]
  Sidecar -. signs, agent holds no keys .-> Agent

  subgraph Salary["Rail 1 — sealed daily salary (private)"]
    Seal["Seal service<br/>x402-protected, per employee"]
    Gateway["<b>Circle Gateway</b><br/>batched gas-free settlement"]
    Unlink["<b>Unlink</b> private account<br/>amount + parties hidden"]
    Seal -->|x402 nanopayment| Gateway
    Seal -->|sealed transfer| Unlink
  end

  subgraph Equity["Rail 2 — programmable equity (public)"]
    Vault["<b>PayrollVaultV3</b><br/>RSU vesting, USDC-settled"]
    Oracle["<b>Pyth</b> price relay<br/>live AAPL/USD via Hermes"]
    Oracle -->|share price| Vault
  end

  Policy -->|pass| Seal
  Approval --> Seal
  Agent -->|release / resetClock| Vault
  Sidecar -. signs settlement .-> Seal
  Sidecar -. signs release .-> Vault
  Unlink --> Employees(["Employees"])
  Vault -->|USDC payout| Employees
  Seal --> Audit
  Vault --> Audit

  Salary -.-> Arc[["Arc testnet — USDC is native gas"]]
  Equity -.-> Arc
```

## Programmable equity — oracle-priced RSU vesting

![Oracle-priced RSU vesting flow](diagrams/rsu-oracle.png)

```mermaid
sequenceDiagram
  autonumber
  participant E as Employer
  participant H as Pyth Hermes (free)
  participant R as PythPriceRelay (Arc)
  participant A as Agent (Worker)
  participant S as Dynamic sidecar
  participant V as PayrollVaultV3 (Arc)
  participant B as Employee wallet

  E->>V: createSchedule(beneficiary, RSU shares, cliff, duration)
  E->>V: fundPool(USDC)
  Note over H,R: relayer pulls real AAPL/USD,<br/>posts it on-chain (oracle-push.mjs)
  H->>R: latest AAPL price (signed)
  A->>V: read schedules + quoteUsdc(shares)
  V->>R: getPriceUnsafe(AAPL)
  R-->>V: price, expo
  V-->>A: vested value in USDC (shares × price)
  A->>S: build release(beneficiary), sign
  S-->>A: signed tx (Dynamic releaser)
  A->>V: broadcast release()
  V->>R: getPriceUnsafe(AAPL)
  V->>B: transfer USDC = vestedShares × price
  Note over V,B: equity grant, settled in cash —<br/>publicly verifiable on Arc
```

### Why a relay

`PayrollVaultV3` consumes the **standard Pyth `IPyth` interface**. Where Arc has
no canonical Pyth deployment yet, `PythPriceRelay` implements that same interface
and is fed real prices from Pyth's Hermes service. Pointing the vault at a native
Pyth contract later is a constructor address change — zero contract edits.
