# AI usage

ETHGlobal's guidelines permit AI tools with two requirements: **attribution**
(document where and how AI was used, including which parts of the code or
assets were AI-generated or assisted) and **involvement** (AI assists the
development process; it doesn't create the entire project). This file is the
attribution; the involvement story is verifiable from the artifacts linked
below.

## Tools

- **Claude Code** (Anthropic, various Claude models) — primary development assistant
  for the build.

## How it was used

This is a spec-driven build. I wrote the project brief before any code —
product definition, architecture, sponsor-integration requirements, milestone
gates, engineering rules, and the brand system — and gave it to Claude Code as
standing instructions. That spec is committed verbatim-in-substance at
[docs/SPEC.md](./SPEC.md) (trimmed of secrets), per the guidance that prompts
and planning artifacts belong in the repo.

Within that spec, Claude Code:

- **generated the large majority of the code in this repo** — the Worker, D1
  schema, integration libraries, signing sidecar, setup scripts, and frontend
  markup;
- researched sponsor docs (fetched live during the event) and probed each SDK
  for Workers-runtime compatibility before we built on it;
- proposed concrete designs where the spec left room — e.g. running Dynamic's
  MPC signer in a Node sidecar after verifying the SDK's native binary can't
  load in workerd, and metering each disbursement with a $0.001 x402
  nanopayment so Gateway batching and Unlink privacy compose without leaking
  salaries;
- drafted documentation, including most of this README.

In essence, I worked as the senior engineering manager, directing goals, performing research on both the technology and architecture as well as the product, stepping in during difficult technical challenges to write code and debug, after reviewing the sponsor documentation manually.

My role expanded (not exhaustive): the product concept, spec, architecture direction, stack and
integration choices, milestone sequencing and cuts, brand system and assets,
all sponsor-account/key/faucet operations, and accept/reject decisions at
every checkpoint — each milestone was reviewed and verified working
(deployed, hit with real requests) before moving on. Design questions that
came up mid-build (prize-eligibility tradeoffs, what to verify with sponsor
teams, what to cut) were decided by me.

## Map: AI-generated vs. human-authored

| Area | Origin |
|---|---|
| `docs/SPEC.md` (project brief) | Human-written before the build |
| `assets/` (logo, comparison graphic) | AI-drafted, human-edited and directed |
| `src/`, `sidecar/`, `scripts/`, `migrations/`, `public/` | AI-generated from the spec, human-reviewed at checkpoints |
| `wrangler.jsonc`, config files | AI-generated, human-reviewed |
| README + docs | AI-drafted, human-edited and directed |
| Architecture & integration design | Human-specified frame; AI-proposed compositions accepted/rejected by me |
| Commit history | Granular checkpoints of the above loop |

The commit history is the audit trail of the loop: small, scoped commits, each
a reviewed working state ("demoable `main` after every milestone" is a spec
rule).
