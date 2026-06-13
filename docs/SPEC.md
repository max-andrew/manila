# Manila — project brief / Claude Code kickoff spec

*This is the working spec I wrote before the build and gave to Claude Code as
its standing instructions, committed per ETHGlobal's AI-usage guidance that
spec and planning artifacts belong in the repo. Light edits for secrets only.
See [AI_USAGE.md](./AI_USAGE.md) for how the AI was used against this spec.*

---

**Manila** — "The pay envelope, rebuilt onchain." Confidential, AI-agent-operated payroll in native USDC on Arc (Circle's L1 testnet). Solo hacker, ~36 hours remaining, submission Sunday morning. Keep `main` demoable at all times and advance through milestones IN ORDER. Never start a milestone until the previous one's gate is met. If an integration fights us past its timebox, flag it and propose the cut — do not silently burn hours.

## THE PRODUCT (one paragraph)

Employer funds a payroll treasury; an AI agent drafts and executes payroll runs from plain-English commands; a policy engine (per-run cap + recipient allowlist) gates execution; over-threshold runs halt for human approval (maker-checker); disbursements settle as batched, gas-free USDC micropayments on Arc testnet via Circle Gateway (x402-style), with **Unlink** keeping amounts and counterparties confidential; everything is recorded to an exportable audit trail. Privacy is the product: salaries on a public chain are the documented blocker to stablecoin payroll adoption.

## PRIZE ENTRIES (requirements, not aspirations)

1. **Joint "Private Nanopayments" (Dynamic × Arc × Unlink)** — REQUIRES all three as CORE: Dynamic server wallets (delegated access) signing payment authorizations; settlement on Arc testnet via Circle Gateway with batched micro-settlement (NOT one large transfer); at least one genuinely private Unlink transfer shown live. Deployed and usable by judges. Public repo + README explaining each integration and what specifically is private.
2. **Dynamic "Best Agentic Build"** — agent uses Dynamic server wallets to sign/execute onchain transactions; bonus for combining delegated access + signing policies + meaningful agent autonomy.
3. **Arc "Best Agentic Economy with Circle Agent Stack"** — agents transacting via gas-free nanopayments on Arc; functional MVP with frontend AND backend; architecture diagram required; demo video required.
4. **Dynamic "Best Use of Flow"** (Milestone 4, timeboxed) — accept deposit in any token/chain, settle USDC; elegant webhook use is a scored bonus.
5. **Arc "Advanced Stablecoin Logic"** (Milestone 5, stretch) — deployed Solidity contract with programmable payroll/vesting in USDC.

Hard rules from sponsors: no hard-coded demo values (seeded DB rows are fine; faked tx results are not). Real testnet transactions. Clean commit history (no single-commit dump).

## STACK (use this; don't propose alternatives)

- **Cloudflare Workers** (Hono) + **D1** (SQLite) + **wrangler**. Frontend: single static page served from the Worker — one screen, three panels: Treasury / Agent Chat / Audit Table.
- **TypeScript everywhere.** viem against the Arc testnet RPC.
- **Anthropic API** (claude-sonnet-4-6) for the agent: single tool-use call, NOT an agent framework. Tools: `draft_payroll_run`, `check_policy`, `execute_run`, `request_approval`.
- **Dynamic** server wallets via their API/SDK (hackathon doc + Agents/Agent Payments docs).
- **Unlink SDK** `@unlink-xyz/sdk` — follow the official tri-party guide (docs.unlink.xyz/partner-integrations); treat it as authoritative over general docs.
- **Circle Gateway nanopayments**: developers.circle.com/gateway/nanopayments.
- Version control: jj (Jujutsu) colocated with git; commit at every working step with descriptive messages.

## BRAND SYSTEM (apply everywhere — UI, README, demo copy)

Concept: for a century salaries were private because they came in a sealed manila envelope; public chains broke that; Manila brings the envelope back. Boring-on-purpose office-stationery aesthetic — flat, restrained, no gradients/neon.

- **Palette:** `manila` #E0BE7E (kraft — sealed badges + approval banner ONLY), `ink` #1F2430 (structural text/borders), `stamp` #C0392B (reserved EXCLUSIVELY for blocked/pending/over-policy states), `paper` #FAF6EE (page background), muted `khaki` #6B6253 (secondary text). Discipline matters: stamp red appearing only on policy events is itself a feature demo.
- **Type:** clean sans for headers; IBM Plex Mono (or system mono) for ALL numbers, addresses, amounts, and agent output.
- **Copy conventions:** payments are never "private," they are **"sealed."** The employer-only audit export is **"open the envelope."** Maker-checker approval is **"two signatures on the envelope."** Agent confirmations in mono, terse: `Sealed. 3 payments. $0.003 in fees.` Voice is dry and competent; sentence case; no exclamation points; no crypto jargon in user-facing copy.
- **UI status badges:** `SEALED` (manila bg, dark khaki text), `PENDING APPROVAL` (stamp red outline), `RELEASED` (ink). Style SEALED like a rubber stamp.
- **Naming in code:** envelope metaphors in user-facing strings; function/variable names literal (`disburse`, `sealTransfer`, `auditExport`).
- **Assets:** logo lockup + comparison graphic exist as SVGs in `/assets`. Tagline everywhere: *The pay envelope, rebuilt onchain.*

## SECRETS / CONFIG

`.dev.vars` + wrangler secrets: ANTHROPIC_API_KEY, DYNAMIC_API_KEY (+ env id), UNLINK creds, ARC_RPC_URL, treasury wallet identifiers. Never commit secrets. `.dev.vars.example` documents every var.

## MILESTONES

### M0 — Scaffold (gate: deployed hello-world, tonight)
wrangler project, Hono app, D1 schema + seed: `employees` (3 rows), `payroll_runs`, `payments`, `audit_log`, `policies` (per_run_cap, allowlist). Deploy to workers.dev. README skeleton. Architecture diagram v1 (Mermaid).

### M1 — CORE: the joint-track money path (gate: one private, batched, agent-walletless disbursement on Arc testnet, end-to-end, before sleep tonight)
Dynamic server wallet (delegated access pattern); fund from Arc faucet. Unlink: deposit into private account; one private transfer; verify on explorer that amount/counterparty are NOT readable. Gateway: batch 3 employee micropayments as one settled flow (visibly micro-settlement, not one lump transfer). Wire as `POST /api/disburse` reading employees from D1, writing `payments` + `audit_log`. THIS MILESTONE HAS NO TIMEBOX. It is the product.

### M2 — Agent + controls (gate: Dynamic Agentic + Arc Agentic demoable, Sat ~2 PM)
`POST /api/agent`: Claude tool-use loop. "Run June payroll" → draft → check_policy → pass ⇒ execute (M1 path); cap exceeded or off-allowlist ⇒ request_approval (run pending, surfaces in UI, `POST /api/approve/:id` releases). Policy engine ~50 lines: cap + allowlist; resist adding rules. Audit log records every decision. `GET /api/audit.csv`.

### M3 — UI + insurance (gate: SUBMITTABLE; record backup demo video Sat evening)
One page in the brand system: treasury balance, chat with run history, audit table, pending-approval banner with Approve button ("Add second signature"), CSV button ("Open the envelope"). Polish the demo path only. RECORD THE FULL DEMO VIDEO while everything works, before touching M4.

### M4 — Flow funding (TIMEBOX 4h, cut at Sat 6 PM if blocked)
Pre-check: does Flow have testnet/sandbox? If mainnet-only and unworkable → CUT. Otherwise: deposit screen, Flow settles USDC to treasury, webhook `POST /api/webhooks/flow` marks treasury funded + audit entry.

### M5 — Vesting contract (STRETCH, TIMEBOX 3h, Sat night only, first thing cut)
~120-line Solidity `PayrollVault` — scheduled releases (cliff + linear or epoch), funded in USDC, `release()` callable by agent wallet, events for audit. Deploy to Arc (foundry), verify, wire one employee through it. Gas paid in USDC.

### M6 — Submission package (Sun early AM)
README final. Architecture diagram exported as image. 2–3 min video. Submission text: name EVERY bounty explicitly. Half-page honest DX feedback per sponsor.

## DOCS (write as you go — judges score this)

README sections, maintained from M0: (1) logo + tagline + one-paragraph pitch; (2) architecture (Mermaid); (3) "How we use each sponsor" — graded by a judge in 60 seconds: what it does here, why the product breaks without it, file/line pointers; (4) privacy model: exactly what is confidential, what is auditable, why that split is compliance-correct; (5) run it from README alone; (6) 90-second demo script; (7) known limitations (honesty scores well).

## ENGINEERING RULES

- Demoable `main` after every milestone; feature work in jj changes, squash to clean commits.
- Errors fail loudly in dev and gracefully in the demo (catch + audit-log + UI toast; never a blank screen in front of a judge).
- No mocking chain calls. If a sponsor API is down, surface it; don't fake it.
- Each integration must read as load-bearing, not bolted on: Flow is THE funding path, the vault is THE disbursement path for at least one employee, Unlink wraps EVERY disbursement.
- Ask before adding any dependency beyond: hono, viem, @anthropic-ai/sdk, @unlink-xyz/sdk, Dynamic's SDK, foundry (M5 only).
