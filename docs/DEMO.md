# Manila — demo guide

Manila is an AI treasury operator for an enterprise's whole comp stack:
confidential daily salary and programmable equity, run from plain English, on
stablecoin rails, under controls the agent can't talk past. This guide is how to
run it and a walkthrough of what each part does.

## Run it

The deployed app is live at **https://manila.maxwellandrew.com** and runs
entirely on Cloudflare — the agent, policy engine, maker-checker approvals, live
balances, vesting display, audit export, *and* live on-chain signing (sealing
salaries, releasing equity).

The Dynamic **MPC server wallet** signs from a **Cloudflare Container** the Worker
calls through a Durable Object binding — the Dynamic SDK ships a native binary
that can't run inside a Worker, and the container is the minimal real-OS process
that can. There's nothing to stand up separately; it scales to zero, so the first
signing action after it's been idle cold-starts it (~15s) and it stays warm while
you use the app.

To post a fresh equity price to the on-chain oracle:

```sh
node scripts/oracle-push.mjs   # posts the latest AAPL/USD price to the oracle
```

Redeploying the signer container needs Docker running locally (`wrangler deploy`
builds its amd64 image; on Apple Silicon, turn on Docker's Rosetta option so the
build is fast).

Reset to a clean state any time with **↺ Reset demo** in the footer (time-aware —
it re-opens today's run without deleting history).

## Walkthrough

The whole app is a Cloudflare Worker (Hono + D1); the agent is Workers AI (Llama
3.3 70B) in a function-calling loop. The model routes plain English to tools; a
deterministic policy engine makes every money decision.

**Confidential daily payroll.** "Pay the team for today" → the agent drafts the
run, the policy engine clears it, and each salary seals. On ArcScan the
transaction is visible but the amount and recipient are not — that's Unlink,
sealing each salary as a private `unlink1`→`unlink1` transfer. The run costs
$0.003: each disbursement is a $0.001 x402 nanopayment the Dynamic wallet signs,
netted by Circle Gateway into one gas-free settlement on Arc. The team card marks
who's paid today.

**A real agent, roster-aware.** Commands aren't hardcoded buttons. "Pay just Ben
Strauss" seals one person; "pay everyone else" seals the rest and won't
double-pay. Rephrasings resolve to the same structured intent.

**Controls the agent is bound to.** The policy is a deterministic gate, not a
prompt the model can argue with — and editing it changes the agent's behavior
live. "Run payroll with the maximally acceptable bonus" applies the policy's max
(it reads the live control band), which trips the per-run cap and halts for a
**second signature** (maker-checker). Lower the max bonus in Controls and the
same command drafts a smaller run. Off-allowlist recipients and over-ceiling runs
are refused outright — the agent operates autonomously but cannot drain the
treasury or redirect funds, because that branch is code, not the model.

**Onboarding.** Adding an employee provisions a private Unlink payout account for
them automatically; the agent can pay them immediately.

**Programmable equity, same agent.** The second rail is equity that settles in
cash. `PayrollVaultV3` (deployed on Arc) vests RSU **shares**; on release it reads
a **live AAPL/USD price** from an on-chain oracle and pays the vested shares'
value in **USDC** — the grant tracks the real stock but settles in stablecoin.
The oracle is the standard Pyth `IPyth` interface, fed real prices from Pyth's
Hermes feed via a relay on Arc (a drop-in for canonical Pyth). "Release Ada's
vested equity" performs a real on-chain release, signed by the Dynamic wallet
(the vault's `releaser`); **↻ Reset clock** re-arms the schedule. This is the Arc
*Advanced Stablecoin Logic* track: oracle read → share-to-USDC conversion →
settlement, in one transaction.

**The signing boundary.** Every action above — salary seals and equity releases —
is signed by the Dynamic MPC (2-of-2) server wallet. The agent holds no keys.

**Audit.** "Open the envelope" exports the full trail — every instruction, policy
decision, and settlement reference. Confidential to the public, fully auditable to
the employer.

## Design notes

- **The model proposes, deterministic code disposes.** The LLM drafts and routes;
  a ~50-line policy engine (`src/lib/policy.ts`) decides pass / hold-for-signature
  / refuse. That boundary is why an autonomous agent is safe on a treasury, and
  why a prompt can't talk it past a cap. A deterministic fallback parser keeps
  commands working even if Workers AI rate-limits.
- **Two-leg payments.** A salary run has a sealed value leg (Unlink) and a metered
  nanopayment leg (x402 → Circle Gateway). The per-call nanopayment is the
  agent-to-service economy pattern, and the platform-fee rail.
- **Keyless agent.** Signing runs in the Dynamic SDK's native MPC binary, which
  can't load in a Worker — so it runs in a Cloudflare Container the Worker calls
  through a Durable Object binding; the Worker never holds key material. Same
  platform, one `wrangler deploy`, no tunnel or separate host.
- **Oracle by interface, not address.** The vault consumes `IPyth`; on Arc we
  supply a relay implementing it. Pointing at a canonical Pyth deployment is a
  constructor address change, no code edits.
- **Testnet specifics.** Unlink's arc-testnet faucet mints mock USDC (`USDCm`), and
  Arc has no canonical Pyth yet so the price is relayed — both are token-/oracle-
  agnostic in code, identical on mainnet.
- **Automation.** The demo runs the agent manually; a Cloudflare Cron Trigger runs
  it daily hands-off (safe to leave unattended precisely because the controls are
  deterministic), and a Durable Object per company scales it multi-tenant.

Full architecture diagrams: [`ARCHITECTURE.md`](ARCHITECTURE.md). Per-sponsor
integration details: [`SUBMISSION.md`](SUBMISSION.md).
