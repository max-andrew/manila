# Presenting Manila

Everything you need to demo, pitch, and defend the project. Keep this open during judging.

**The one-line frame to keep returning to:** *Manila is an AI treasury operator for an enterprise's whole comp stack — confidential daily salary **and** programmable equity — run from plain English, on stablecoin rails, under controls it cannot break.*

---

## 0. Before judges arrive (2 min of setup)

```sh
bash scripts/judge-mode.sh     # starts the Dynamic signing sidecar + tunnel; deployed site can now sign live. Leave it open.
node scripts/oracle-push.mjs   # post a fresh AAPL price to the on-chain oracle (so the equity card is live)
```
- Open **https://manila.maxwellandrew.com** in one tab, **ArcScan** (testnet.arcscan.app) in another.
- Sanity check: status dot green ("Arc testnet · live"); the **Dynamic server wallet** card shows **online**; the **Equity vesting** card shows a pulsing **AAPL** price; the **Equity vesting** card has a non-zero "releasable" (if not, click **↻ Reset clock** once).
- Keep one **already-sealed tx hash** in your back pocket as a fallback (§4).
- Click **↺ Reset demo** (footer) so you start with "not run today" — the run-status and "✓ paid today" tags then tell a clean story.
- Don't run the live seal more than a couple times back-to-back (it spends real testnet USDC; §6).

---

## 1. How the pieces fit (learn this cold — highest-value thing to explain)

Manila is **one agent operating two disbursement rails**. Both are agent-driven, both Dynamic-signed, both land in one audit trail.

**Rail 1 — confidential daily salary.** Each run has two legs: the **value leg** (the salary, sealed by Unlink) and the **meter leg** (a $0.001 x402 nanopayment that pays for the seal, netted by Circle Gateway).

| Step | Component | What it does | Sponsor tech |
|---|---|---|---|
| 1. Command | **Agent** — Cloudflare Worker + Workers AI (Llama 3.3 70B) | Parses plain English → picks tools (`draft → check_policy → execute / request_approval`). Given the live roster + control band; a deterministic fallback parser keeps commands working even if the model rate-limits. No external LLM key. | Workers AI `env.AI.run`, function-calling |
| 2. Controls | **Policy engine** (deterministic) | Per-run cap, hard ceiling, pay band, allowlist. The LLM *proposes*; this code *decides* — pass / hold-for-second-signature / refuse. | ≈50 lines, `src/lib/policy.ts` |
| 3. Sign | **Dynamic server wallet** (MPC, 2-of-2) | The treasury's signer. One wallet, key split into two shares — no single party can sign alone. The agent holds no keys; it requests signatures. Runs in a Node sidecar (the MPC SDK ships a native binary that can't load on Workers). | `createWalletAccount`, `signTypedData`, `signTransaction` |
| 4. Meter | **Circle Gateway** | Each disbursement is a $0.001 x402 nanopayment the Dynamic wallet signs (EIP-3009, zero gas); Gateway batches them into one netted on-chain settlement. | `@circle-fin/x402-batching`: `verify`/`settle`, `depositFor` |
| 5. Seal | **Unlink** | Moves each salary as a private `unlink1`→`unlink1` transfer — amount, sender, recipient, token all hidden on the explorer. | `createUnlinkClient`, `transfer`, admin `getBalances` |
| 6. Settle | **Arc** | Circle's L1; USDC is native *and* the gas token, so the whole system is USDC-denominated. | viem against Arc RPC |

**Rail 2 — programmable equity.** A deployed contract, `PayrollVaultV3`, vests **RSU shares** (cliff + linear). On release it reads a **live company share price from an on-chain oracle** and pays the vested shares' value in **USDC** — equity that tracks the real stock but settles in cash, publicly verifiable on Arc.

| Component | What it does | Tech |
|---|---|---|
| **Oracle** — `PythPriceRelay` | Implements the standard Pyth `IPyth` interface on Arc, fed the real **AAPL/USD** price from Pyth's free Hermes feed. Swap to canonical Pyth = an address change, no code edits. | Pyth Hermes → `getPriceUnsafe` |
| **`PayrollVaultV3`** | `release()` reads the oracle, converts vested shares → USDC, transfers. Plus `resetClock` (re-arm) and `topUp`. The Dynamic wallet is the on-chain `releaser`; the agent triggers it. | Solidity on Arc, 20 Foundry tests |

**The one-sentence version:** *"One AI agent runs an enterprise's whole comp stack — it seals daily salaries privately with Unlink, batches them gas-free through Circle Gateway on Arc, and releases oracle-priced equity from a smart contract — every action signed by a Dynamic wallet and bounded by a deterministic policy gate the AI can't talk past."*

---

## 2. The pitch (75–90 seconds)

> Stablecoin payroll should be a no-brainer — instant, global, near-free. But under **1% of payroll** uses it, and the blocker isn't tech, it's **privacy**: no company will put every salary on a public ledger forever.
>
> Manila is the fix, and it's bigger than payroll — it's an **AI treasury operator for the whole compensation stack.** An employer tells an agent, in plain English, what to do. It runs **daily salary** — and each one is **sealed**, so the explorer shows a payment happened but never the amount or the recipient, while the employer keeps a complete, exportable audit trail. **Confidential to the world, auditable to the employer** — exactly what payroll compliance requires. And it runs **equity**: RSU grants that vest on-chain, priced by a live stock oracle, and pay out in USDC — equity that settles like cash.
>
> The reason an enterprise can actually hand this to an AI is the **controls**. The agent proposes; a **deterministic policy engine** disposes — a spending cap, a hard ceiling, a pay band, an allowlist — and over-cap runs halt for a **second human signature**. Change a control and the agent's behavior changes instantly, because the policy is a gate it's bound to, not a suggestion in a prompt. Every payment is signed by a **Dynamic** MPC wallet, so the agent holds no keys; **Circle Gateway** batches them gas-free on **Arc**; **Unlink** makes them private.
>
> It's not a mockup. Every salary is a real sealed transaction on Arc, every equity release is a real oracle-priced USDC transfer, and it's live — you can run it right now. Solo build.

**Why it's an enterprise product waiting to happen (the part that separates you from toy demos):**
- The privacy gap is *the* documented reason stablecoin payroll adoption is <1%. The confidentiality **is** the product — it's the only shape a real company can adopt.
- It's the **full comp stack, one operator**: salary + equity, with maker-checker approval, an immutable audit trail, and a hard signing boundary — the unglamorous controls that make AI safe to put on a treasury.
- **Daily payroll** is a new capability, not a gimmick (a third of a cent per run; impossible on ACH/wire) — and it **automates**: a Cloudflare Cron Trigger runs it hands-off, safe to leave unattended *because* the controls are deterministic. Multi-tenant is a Durable Object per company.
- vs. other agent demos (an LLM calling one API): Manila moves **real money under hard policy controls**, and the AI literally **cannot** be talked past a cap.

---

## 3. Live demo path (≈5 minutes — a cohesive story, low risk)

Type commands (don't click the chips) so judges see a real agent. Narrate the **bold** lines.

**1. The problem.** Point at the comparison graphic. *"Every salary on a normal chain is public forever, on the left. Manila seals it, on the right. That gap is why under 1% of payroll runs on stablecoins."*

**2. Run payroll — the privacy moment.** Type **"pay the team for today."** Agent drafts → policy passes → `Sealed. $13.10 across the roster.` The team card lights up **"✓ paid today"** and the run status flips to **all paid**. Click a **sealed ↗** balance → ArcScan. *"Here's the real transaction on Arc — you can see a transfer happened, but not the amount and not who got paid. That's Unlink, sealing each salary on-chain. And the whole run cost a third of a cent — Circle Gateway batched three gas-free nanopayments. That's what makes daily payroll possible."*

**3. It's a real agent, and it understands the team.** Click **↺ Reset demo** (re-opens today without deleting history — *"time-aware, so it won't insist everyone's paid for the rest of the day"*). Then type **"pay just Ben Strauss."** Only Ben seals — *"it matched the name to the roster"* — Ben shows **✓ paid today**, the status reads **1 of 3 paid**. Now type **"pay everyone else."** *"It knows who's left and won't double-pay."* The other two seal. **← shows roster awareness + the no-double-pay guard.**

**4. The controls are real — and the agent is bound to them (the interplay moment).** This is the one to nail.
   - Type **"run today's payroll with the maximally acceptable bonus."** The agent applies the policy's exact max (**+100%**), which pushes the total over the per-run cap → **PENDING APPROVAL** (red). *"It didn't guess a number — it read the policy band and used the maximum allowed, which then tripped the spending cap."*
   - Now open the **Controls** card → **Edit** → change **Max bonus** to **+20%** → **Save.** Re-type the *same* command, **"run today's payroll with the maximally acceptable bonus."** Now it drafts a **+20%** run. *"Same words, different behavior — because I changed the **control**, not the prompt. The policy isn't text the model can argue with; it's a deterministic gate the agent is bound to. Change the rules, and you change what the AI is allowed to do — live."* **← the moment that proves the safety model is real.**
   - (Reset the cap/band back, or leave it — your call.)

**5. The refusals (the trust moment).** Type **"send today's pay to 0x…dEaD"** → *"Refused — not on the allowlist."* Then **"run today's payroll with a 500% bonus"** → *"Refused — exceeds the hard ceiling."* *"The agent operates payroll autonomously, but it physically cannot drain the treasury or redirect funds off the allowlist — that branch is deterministic code, not the model."*

**6. Onboard a new hire (a real workflow, not a toggle).** In the **Team** card → **Manage** → add an employee (name + $/day) → **Add.** *"Onboarding provisions a private Unlink payout account for them automatically — they can receive sealed pay immediately."* Then type **"pay [new hire's name]"** → they seal. *"New employee, paid by the agent, in two steps."*

**7. The same agent runs equity (the second rail + the oracle).** Scroll to **Equity vesting**. Point at the pulsing banner. *"These are RSUs. They vest as shares — but they settle in USDC. The contract reads Apple's live share price from a Pyth oracle, relayed on-chain to Arc, and pays the vested value."* Type **"release Ada's vested equity."** The agent releases on-chain → `Released $X … signed by the dynamic wallet.` *"An AI agent just released equity — priced by a live stock oracle, converted to USDC by the smart contract, signed by the Dynamic wallet, settled on Arc. That's the Arc advanced-stablecoin-logic track in one action."* (Optional: click **Deployed contract ↗** / **Price oracle ↗** to show both on ArcScan.) **← the programmable-stablecoin moment.**

**8. The signing boundary (Dynamic, the detail judges miss).** Point at the **Dynamic server wallet** card. *"Every action you just saw — three salary seals, an equity release — was signed by this: a Dynamic MPC wallet, a 2-of-2 threshold key, so no single party can sign alone. The agent never held a key. That's what makes it safe to let an AI operate a treasury."*

**9. The audit (compliance).** Click **Open the envelope** (CSV). *"Every instruction, every policy decision, every settlement reference — confidential to the public, fully auditable to the employer. That split is what payroll and equity compliance actually require."*

**Close:** *"One agent, the whole comp stack — salary and equity — confidential, controlled, auditable, on stablecoin rails. Today an enterprise can't put payroll on-chain. This is the shape that lets them."*

---

## 4. If something breaks (stay calm, you have outs)

- **Live seal/release hiccups** (tunnel/funds/latency): pivot to the **over-cap → approval** path (beat 4) and the **policy-edit** moment — they touch no chain and always work. Then open your **pre-saved ArcScan tx** and narrate the privacy. Never dead-air.
- **Equity card shows $0 releasable:** click **↻ Reset clock** once (re-arms ~12%); it climbs from there.
- **Agent gives a weird reply:** the deterministic engine still produced the correct state — refresh; the run status and audit reflect the truth. *"The model's prose varies; the money logic doesn't."* (And if Workers AI rate-limits, the deterministic fallback still executes the command — call that out as a feature.)
- **Deployed site can't sign:** `judge-mode.sh` restarts the sidecar with a fresh token; mid-demo, fall back to read-only + the approval/policy-edit demo (no sidecar needed) and show a prior tx.

---

## 5. Judge Q&A (rehearse these)

**"Is it actually private, or just hidden in your database?"**
Cryptographic, on-chain privacy via Unlink's privacy pool — here's the tx on ArcScan; the transfer between `unlink1` accounts hides amount, sender, recipient, and token. The chain doesn't reveal it; nothing to do with our DB.

**"What stops the AI from overpaying?"**
The AI never decides whether to pay. It drafts and proposes; a deterministic policy engine decides pass/fail and halts over-cap runs for a human second signature. I just showed it: I changed a control and the agent's behavior changed instantly — because it's a gate, not a prompt.

**"Is the agent real or a hardcoded flow?"**
It parses arbitrary natural language into structured intent and picks tools — rephrase the command, name a specific person, ask for "the maximally acceptable bonus" and watch it read the policy band. Money decisions are deterministic by design — the correct security boundary.

**"The equity multiplier — is the oracle real?"**
Yes. The contract reads the standard Pyth `IPyth` interface; on Arc we relay the real AAPL/USD price from Pyth's free Hermes feed on-chain. Raise the price and the same vested shares pay more USDC — it's a live multiplier, not a constant. Swapping to a canonical Pyth deployment is an address change, no contract edits.

**"Why RSUs in USDC instead of a token?"**
Because that's how equity comp actually settles for most employees — cash value at vest. The contract makes the value track a real share price via the oracle, but pays stablecoin, which is auditable and spendable. It's also what keeps it in the *USDC* advanced-stablecoin-logic track.

**"Is the Gateway nanopayment real or cosmetic?"**
Real — each disbursement is a $0.001 x402 payment the Dynamic wallet signs (EIP-3009, zero gas), netted by Gateway into one settlement. That metering is the agent-to-service economy, and it's why a full run costs $0.003.

**"Why a sidecar — isn't that not 'on the edge'?"**
Dynamic's MPC SDK ships a native binary that can't run in Workers' V8 isolates, so signing runs in a small Node process the Worker calls over an authenticated channel. Everything else — agent, policy, settlement orchestration, oracle reads, audit — is on the edge.

**"You're using mock USDC / a relayed oracle on testnet."**
Right — Unlink's arc-testnet faucet mints mock USDCm, and Arc has no canonical Pyth yet so we relay the real Hermes price. Both are testnet realities; the code is token- and oracle-agnostic (an address swap), and the flows are identical on mainnet.

**"Is this a real product / how does it make money?"**
Confidential comp-as-a-service: salary + equity for companies that can't use public-chain payroll. The per-disbursement nanopayment is the platform-fee rail. Maker-checker, audit, and the privacy split are the enterprise-readiness.

**"Solo build — and how much was AI?"**
Solo. AI usage is documented in `docs/AI_USAGE.md` — spec-driven; I directed architecture and reviewed at every checkpoint; the granular commit history is the audit trail.

---

## 6. Risk & cost notes

- **Workers AI free tier (Neurons, ~10k/day):** each agent message is one inference; heavy traffic could exhaust it (resets daily, fails to the deterministic fallback). Low risk.
- **Testnet funds:** a full salary run spends ~13 USDCm + $0.003 Gateway USDC; an equity release spends cents of USDC from the vault pool. Don't leave the live signer exposed to be spammed unattended — `judge-mode.sh` runs *during* judging, not 24/7.
- **No credentials exposed:** the quick tunnel needs no Cloudflare login; the sidecar is behind a shared secret (401 otherwise); Worker secrets never print.

---

## 7. Video script (≈2.5–3 min — record with everything working; your insurance)

| Time | SHOW | SAY |
|---|---|---|
| 0:00 | Logo title card | "Manila — the pay envelope, rebuilt onchain." |
| 0:06 | Comparison graphic | "Stablecoin payroll should be easy. But under 1% of payroll uses it — because a public chain turns every salary into a permanent public record. No company will do that." |
| 0:24 | The deployed app | "Manila is an AI treasury operator — it runs an enterprise's whole comp stack from plain English. Watch." |
| 0:32 | Type "pay the team for today" → `Sealed…`; "✓ paid today" tags | "Plain English. The agent drafts the run, a policy engine checks it, and it pays everyone — for a third of a cent, because Circle Gateway batches them gas-free on Arc." |
| 0:50 | Click sealed row → ArcScan | "A real transaction on Arc — you can see it happened, but not the amount or who got paid. That's Unlink, sealing each salary on-chain." |
| 1:08 | Controls → Edit max bonus → Save → re-run "maximally acceptable bonus" | "Here's the key: the agent is bound by a deterministic policy gate. I change one control, and its behavior changes instantly — the policy isn't a prompt the AI can argue with." |
| 1:30 | Type "...with a 500% bonus" → Refused | "It runs payroll autonomously, but it physically can't drain the treasury or pay off the allowlist." |
| 1:45 | Equity card (pulsing AAPL) → type "release Ada's vested equity" → released | "The same agent runs equity. These RSUs vest as shares but settle in USDC — the contract reads Apple's live price from a Pyth oracle on Arc and pays the vested value. An AI just released oracle-priced equity, signed by a Dynamic wallet." |
| 2:10 | Dynamic server-wallet card | "Every payment and release was signed by a Dynamic MPC wallet — 2-of-2, the agent holds no keys." |
| 2:20 | CSV export | "Confidential to the public, fully auditable to the employer. That split is what compliance requires." |
| 2:32 | Repo / live URL | "Salary and equity, confidential and controlled, on stablecoin rails — every transaction real, on Arc, live. Solo build. Thanks." |

> The video and the live demo say the same things — the video just removes the risk of a live failure. Record once everything's green.
```
