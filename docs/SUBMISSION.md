# Manila — submission

*The pay envelope, rebuilt onchain.*

**Live:** https://manila.maxwellandrew.com · **Repo:** https://github.com/max-andrew/manila

Confidential, AI-agent-operated payroll in USDC on Arc. An employer funds a treasury; an AI agent drafts and executes payroll runs from plain-English commands; a policy engine (per-run cap + recipient allowlist) gates every run, with over-threshold runs halting for human approval — two signatures on the envelope. Disbursements settle as batched, gas-free USDC nanopayments on Arc via Circle Gateway, sealed by Unlink so amounts and counterparties stay confidential, and the employer keeps a full exportable audit trail. Salaries on a public chain are the documented blocker to stablecoin payroll adoption (<1%); Manila is the fix: public confidentiality, private auditability.

## Bounties

### Private Nanopayments — Dynamic × Arc × Unlink (joint)
All three are core and load-bearing. A **Dynamic** server wallet (MPC) is the treasury and the agent's signer — it signs every x402 payment authorization, and the agent holds no key material. **Circle Gateway** batches those authorizations into one gas-free, netted settlement on **Arc** testnet. **Unlink** seals every salary as a private `unlink1`→`unlink1` transfer, hiding amount, sender, recipient, and token on the explorer. A real agent-driven run sealed three salaries: e.g. `0x1e76d25d2ceb8900649b1b30fe7e8bb99ca7dc6b20e840707501a905c5b15f4c`. Remove any one of the three and the product stops working.

### Dynamic — Best Agentic Build
The agent (a function-calling loop on Cloudflare Workers AI, Llama 3.3 70B) decides *and* executes: from "run the June payroll" it drafts the run, checks policy, and — if it passes — calls the disbursement path, where the **Dynamic server wallet** signs the on-chain settlement authorizations. The policy gate and execute/approve branch are deterministic by design, so the agent can act autonomously without an LLM ever being able to talk past a spending cap. Combines server wallets + a signing boundary + meaningful autonomy. (`src/lib/agent.ts`, `sidecar/server.mjs`, `src/lib/signer.ts`.)

### Dynamic — Best Money App
A real money-movement app built on the Dynamic server-wallet SDK: confidential USDC payroll with maker-checker controls and an auditable record. Deployed and usable by judges; the agent, policy engine, approval flow, live treasury balance, and CSV export run on the deployed URL.

### Arc — Best Agentic Economy with Circle Agent Stack
An autonomous agent transacting via gas-free nanopayments on Arc: each disbursement is metered as a $0.001 x402 micropayment the agent pays to a 402-protected seal service, all netted by Circle Gateway — exactly the per-call agent-to-service commerce pattern the track targets. Functional MVP with frontend + backend; architecture diagram in the README. (`src/routes/seal.ts`, `src/routes/disburse.ts`.)

### Arc — Best Smart Contracts (Advanced Stablecoin Logic)
**`PayrollVaultV3`** — equity that settles in cash. Each employee vests RSU **shares** (cliff + linear); on `release()` the contract reads a **live company share price from an on-chain oracle** and pays the vested shares' value in **USDC** — multi-step settlement (oracle read → share→USDC conversion → transfer), so a grant tracks the real stock but pays stablecoin. Plus `resetClock` (re-arm a schedule's remaining shares over a fresh clock, never over-promising the pool) and `topUp`. **20 passing Foundry tests**, incl. proof the payout tracks the oracle price. The oracle is the standard Pyth `IPyth` interface — on Arc we deploy `PythPriceRelay` fed the real **AAPL/USD** price from Pyth's free Hermes feed, so it's a drop-in for canonical Pyth (address swap, no code change). Deployed: vault `0x021Bf03C10ed7d8205aaD4dE6D3847D94715B06b`, oracle relay `0xb8e18484bebC0356A67293590B8affE2b55e3424`; the Dynamic server wallet is the `releaser` and the agent releases on command, every release a real USDC transfer on Arc. Diagram: `docs/ARCHITECTURE.md`. (`contracts/src/PayrollVaultV3.sol`, `contracts/src/PythPriceRelay.sol`.)

## What's confidential vs auditable
Hidden from the public: salary amounts and counterparties (sealed via Unlink). Visible to the employer: the complete run history, every policy decision, and settlement references, exported as CSV. That split is the compliance-correct shape for payroll.

## Notes for judges
The entire app runs on Cloudflare at the deployed URL — agent, policy, maker-checker approval, live treasury balance, audit export, and the full on-chain disbursement path. The Dynamic signer runs as a Cloudflare Container the Worker calls through a binding (its SDK ships a native binary that can't run inside a Worker); see the README "Run it" section. On arc-testnet the sealed token is Unlink's mock USDC (`USDCm`); the architecture is token-agnostic. AI tool usage is documented in `docs/AI_USAGE.md`, with the pre-build spec in `docs/SPEC.md` and per-sponsor DX feedback in `docs/FEEDBACK.md`.
