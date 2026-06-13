# Presenting Manila

Everything you need to demo, pitch, and defend the project. Keep this open during judging.

---

## 0. Before judges arrive (2 min of setup)

```sh
bash scripts/judge-mode.sh     # starts sidecar + tunnel; deployed site can now seal live. Leave it open.
```
- Open **https://manila.maxwell-andrew.workers.dev** in one tab, **ArcScan** (testnet.arcscan.app) in another.
- Sanity check: the Treasury panel shows a real balance and the status dot is green ("Arc testnet · live").
- Keep one **already-sealed tx hash** in your back pocket as a fallback (see §4).
- Don't run the real seal more than a couple times back-to-back (it spends real testnet USDC; see §6).

---

## 1. How the pieces fit (learn this cold — it's the highest-value thing to explain)

One payroll run has **two legs**: the **value leg** (the salary, sealed) and the **meter leg** (a tiny nanopayment that pays for the seal). Walk a judge through the flow in this order:

| Step | Component | What it does | Sponsor SDK |
|---|---|---|---|
| 1. Command | **Agent** — Cloudflare Worker + Workers AI (Llama 3.3 70B) | Parses plain English → picks tools (`draft → check_policy → execute / request_approval`). No external LLM key. | Workers AI `env.AI.run` with function-calling |
| 2. Controls | **Policy engine** (deterministic) | Per-run cap + recipient allowlist. The LLM *proposes*; this code *decides*. Over-cap → human approval. | — (≈50 lines, `src/lib/policy.ts`) |
| 3. Sign | **Dynamic server wallet** (MPC) | The treasury and the agent's signer. Agent holds no keys; it requests signatures. Runs in a Node sidecar (the MPC SDK ships a native binary that can't load on Workers). | `createWalletAccount`, `signTypedData` |
| 4. Meter | **Circle Gateway** | Each disbursement is a $0.001 x402 nanopayment the agent signs (EIP-3009, zero gas); Gateway batches them into one netted on-chain settlement. | `@circle-fin/x402-batching`: `verify`/`settle`, `depositFor`, `getSupported` |
| 5. Seal | **Unlink** | Moves each salary as a private `unlink1`→`unlink1` transfer — amount, sender, recipient, token all hidden on the explorer. | `createUnlinkAdmin`, `createUnlinkClient`, `transfer` |
| 6. Settle | **Arc** | Circle's L1; USDC is native *and* the gas token, so the whole system is USDC-denominated. | viem against Arc RPC |
| 7. Record | **Audit log → CSV** | Every instruction, policy decision, and settlement ref → D1, exported as CSV. | Cloudflare D1 |

**The one-sentence version:** "An agent runs payroll from plain English; a Dynamic wallet signs each payment, Circle Gateway batches them gas-free on Arc, Unlink seals them private, and the employer keeps a full audit trail — with a deterministic policy gate so the AI can never overpay."

---

## 2. The pitch (60–90 seconds, say it out loud a few times)

> Stablecoin payroll should be a no-brainer — instant, global, near-free. But under **1% of payroll** uses it, and the blocker isn't tech, it's **privacy**: no company will put every employee's salary on a public ledger forever.
>
> Manila fixes exactly that. An employer tells an AI agent, in plain English, to run payroll. The agent drafts it, a policy engine checks a spending cap and an allowlist, and it pays everyone — but each salary is **sealed**: on the explorer you see that a payment happened, but not the amount or who got paid. The employer still gets a complete, exportable audit trail. **Confidential to the world, auditable to the employer** — which is exactly what payroll compliance needs.
>
> Under the hood, four things work together: a **Dynamic** server wallet signs every payment so the agent holds no keys; **Circle Gateway** batches them gas-free as nanopayments on **Arc**; and **Unlink** makes each one private. The agent runs on **Cloudflare Workers AI**, and the policy gate is deterministic — so the AI can operate payroll autonomously but can never be talked into paying past a cap.
>
> It's not a mockup. Every disbursement is a real transaction on Arc, there's a deployed vesting contract for employees on a cliff, and it's live — you can run payroll on it right now. Solo build.

**Why it's practical (the part that separates you from toy demos):**
- The privacy gap is *the* documented reason stablecoin payroll adoption is <1%. Manila is the only shape that's actually adoptable by a real company.
- vs. other agent projects (mostly an LLM calling one API): Manila moves **real money under hard policy controls with maker-checker** — the unglamorous parts that make it deployable.
- vs. a normal stablecoin payroll tool: those expose salaries → instant non-starter. The confidentiality *is* the product.

---

## 3. Live demo path (≈3 minutes — wow, low risk)

Five beats. Type commands (don't click buttons) so judges see it's a real agent.

1. **The problem** — point at the comparison graphic on the page. *"Every salary, public forever [left]. Manila seals it [right]."*
2. **Run payroll** — type **"pay the team for June"** (natural phrasing, not the chip). Agent drafts → policy passes → `Sealed. 3 payments. $0.003 in fees.` Click a **sealed ↗** row → ArcScan → *"the transaction is right here — but the amount and who got paid aren't readable. That's Unlink, on-chain."* **← this is the moment.**
3. **Show flexibility** — type a rephrasing like **"process this month's salaries"**. Same correct action. *"It's not a hardcoded button — it parses intent. And the policy gate is deterministic, so even if the model phrases it oddly, the money logic is exact."*
4. **The control** — type **"run June payroll with a 25% bonus"**. It trips the cap → **PENDING APPROVAL** (red). *"It won't pay over policy — it needs a second signature."* Click **Add second signature** → releases. *"Two signatures on the envelope."*
5. **The audit** — click **Open the envelope · CSV**. *"Confidential to the public, fully auditable to the employer — the compliance-correct split."* (Optional: mention the deployed `PayrollVault` for vesting.)

---

## 4. If something breaks (stay calm, you have outs)

- **Live seal hiccups** (tunnel/funds/latency): immediately pivot to the **over-cap → approval** path (beat 4) — it touches no chain and always works. Then open your **pre-saved ArcScan tx** and narrate the privacy there. Never dead-air on a failed live call.
- **Agent gives a weird reply**: the deterministic engine still produced the correct run state — refresh; the treasury balance and audit reflect the truth. Say *"the model's prose varies; the money logic doesn't."*
- **Deployed site can't sign**: `judge-mode.sh` restarts the sidecar with a fresh token; if mid-demo, fall back to read-only + approval demo (no sidecar needed) and show a prior tx.

---

## 5. Judge Q&A (rehearse these)

**"Is it actually private, or just hidden in your database?"**
Cryptographic, on-chain privacy via Unlink's privacy pool — here's the tx on ArcScan; the transfer between `unlink1` accounts hides amount, sender, recipient, and token. The chain itself doesn't reveal it; nothing to do with our DB.

**"You're using a mock USDC on testnet, not real USDC."**
Right — Unlink's arc-testnet faucet only mints mock tokens, so we use USDCm as the testnet stand-in. The code is token-agnostic (`UNLINK_TOKEN_ADDRESS`); on mainnet it's native USDC, same flow.

**"Why a sidecar — isn't that not 'on the edge'?"**
Dynamic's MPC SDK ships a native binary that can't run in Workers' V8 isolates, so signing runs in a small Node process the Worker calls over an authenticated channel. Everything else — agent, policy, settlement orchestration, audit — is on the edge. For judging it's tunnelled so the deployed site signs live.

**"What stops the AI from overpaying?"**
The AI never decides whether to pay. It drafts and proposes; a deterministic policy engine decides pass/fail and halts over-cap runs for a human second signature. The LLM cannot bypass it — that's the core design choice.

**"Is the agent real or a hardcoded flow?"**
It parses arbitrary natural language into a structured intent and chooses tools — rephrase the command and watch. But money-movement decisions are deterministic, which is the correct security boundary for payroll.

**"Is the Gateway nanopayment real or cosmetic?"**
Real — each disbursement is a $0.001 x402 payment the Dynamic wallet signs (EIP-3009, zero gas), netted by Gateway into one on-chain settlement. That metering is what makes it an agent-to-service economy, and it's why the whole run costs $0.003.

**"Is this a real product / how does it make money?"**
Confidential payroll-as-a-service; the per-disbursement nanopayment is the platform fee rail. The privacy split is what makes it adoptable where public-chain payroll isn't.

**"Solo build — and how much was AI?"**
Solo, yes. AI usage is documented in `docs/AI_USAGE.md` — spec-driven, I directed architecture and reviewed at every checkpoint; the granular commit history is the audit trail.

**"Why Arc?"**
USDC is native and gas is paid in USDC, so the entire treasury → payroll flow is USDC-denominated — no separate gas token to manage.

---

## 6. Risk & cost notes (what to watch)

- **Workers AI free tier (Neurons, ~10k/day):** each agent message is one inference. Heavy judge traffic *could* exhaust it; it resets daily and fails gracefully. Low risk.
- **Testnet funds:** each full run spends ~13 USDCm + $0.003 Gateway USDC. Treasury has plenty for a demo; re-faucet if it runs low. Don't leave the live seal exposed to be spammed unattended — `judge-mode.sh` is meant to run *during* judging, not 24/7.
- **No credentials are exposed:** the quick tunnel needs no Cloudflare login; the sidecar is protected by a shared secret (unauthenticated callers get 401); Worker secrets never print.

---

## 7. Video script (≈2.5 min — record with everything working; this is your insurance)

| Time | SHOW | SAY |
|---|---|---|
| 0:00 | Logo title card | "Manila — the pay envelope, rebuilt onchain." |
| 0:06 | Comparison graphic | "Stablecoin payroll should be easy. But under 1% of payroll uses it — because a public chain turns every salary into a permanent public record. No company will do that." |
| 0:25 | The deployed app | "Manila is confidential USDC payroll, run by an agent. Watch." |
| 0:33 | Type "pay the team for June" → `Sealed…` | "Plain English. The agent drafts the run, a policy engine checks a cap and an allowlist, and it pays everyone." |
| 0:50 | Click sealed row → ArcScan | "Here's a real transaction on Arc. You can see it happened — but not the amount, and not who got paid. That's Unlink, sealing each salary on-chain." |
| 1:10 | (stay on app) | "Four pieces make this work: a Dynamic server wallet signs every payment, so the agent holds no keys. Circle Gateway batches them gas-free as nanopayments on Arc. Unlink makes them private. And the agent runs on Cloudflare Workers AI." |
| 1:30 | Type "...with a 25% bonus" → PENDING | "It won't pay over policy. This run exceeds the cap, so it halts for a second signature." |
| 1:42 | Click Add second signature → released | "Two signatures on the envelope — maker-checker, like real treasury controls. The key design choice: the policy gate is deterministic, so the AI can operate payroll but can never be talked past a cap." |
| 1:58 | Click CSV export | "Confidential to the public, fully auditable to the employer. That split is what payroll compliance actually requires." |
| 2:10 | ArcScan: PayrollVault address | "There's also a deployed vesting contract on Arc for employees on a cliff — programmable USDC payroll." |
| 2:20 | Repo / live URL | "Every transaction here is real, on Arc testnet. It's deployed and live. Solo build. Thanks." |

> The video and the live demo say the same things — the video just removes the risk of a live failure. Record it once everything's green; re-record only if a live take is clearly better.
