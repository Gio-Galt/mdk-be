# Self Notes — MDK Platform

> **Last Updated:** 2026-05-18 | Personal working notes and action items

---

## 🤖 Agentic Framework on MDK

> Priority: **High** — mid-call on Monday with agentic framework team

### Open Questions

- [x] ~~**MCP vs CLI:** How would an AI Agent use ORK? Define the canonical integration path.~~ — **Resolved.** MCP chosen; rationale + comparison documented in `hld-agentic-framework.md` §3.4.
- [x] ~~**Agent-Generated UI:** Can agents generate UI dynamically using the `@tetherto/mdk-ui-devkit-react` component library?~~ — **Resolved.** Yes — Operator Agent selects from a visualization catalogue and the contract-driven UI renderer materialises it. See `hld-agentic-framework.md` §3.5, §3.7.

### To-Do

- [x] ~~Read QVAC Docs — understand their agentic patterns and how they map to MDK's MCP tool derivation (§4.2.1 in HLD)~~ — QVAC HTTP server reviewed; integration path documented in `hld-agentic-framework.md` §3.7 (LLM Provider).
- [x] ~~Build POC: end-to-end agentic flow (Agent → MCP → App Node → ORK → Worker)~~ — POC lives at `mdk-be/poc/`; demo recordings under `mdk-be/docs/demo-videos/`.
  - [x] ~~Example use-case: *"Generate a report I want to send to the boss"*~~ — covered as Use Case A in HLD.
  - [x] ~~Example use-case: *"Take action"*~~ — covered as Use Case B in HLD; demo: `set_power_limit_to_miner.mov`.

---

## 🏗️ MOS → MDK Migration

> Priority: **High** — requires cross-team alignment (Hemant, Arif)

### Goal

Disintegrate the existing MOS monolith ([demo.mos.tether.io](https://demo.mos.tether.io/)) and identify gaps when mapping features into the MDK architecture.

### Key Question

Can we extract the features visible in the MOS sidebar into separate, pluggable modules combining BE + FE as MDK-App Plugins?

- **Where does the backend code for these features live today?** Audit the current MOS codebase.
- **Where should it live in MDK?**

### To-Do

- Discuss with Hemant and Arif — audit MOS sidebar features
- Discuss with them on how to bootstrap a deployment of MDK (ui + appnode), then would need a cil like npx create-mdk-instance
- Create a feature-to-MDK mapping table (feature → package/plugin)
- Identify gaps: features MOS supports that MDK architecture doesn't yet cover
- Confirm the abstraction with Gio

---

## 📦 Documentation & Naming

> Priority: **Medium**

### To-Do

- [x] ~~Clarify naming for each package — ensure 1:1 mapping between package names and architecture diagrams (see `mdk-libraries.md`)~~
- [ ] **Rename `device-lib` → `lib`** (per Gio) — `device-lib` is misleading because the same package shape is used for non-device integrations (mempool.space, mining pools, other third-party services). Update `mdk-libraries.md` and any references in HLD docs accordingly.
- Workers in monorepo are built by us — explicitly mention this ownership boundary in the docs
  - Workers ship as reference implementations; external integrators build their own by subclassing `@tetherto/mdk-worker-base`
- Improve + refine the architecture docs (HLD + supplementary)
  - [x] ~~`hld.md` — review for completeness after recent protocol simplification~~
  - [x] ~~`hld-mdk-app.md` — ensure frontend toolkit layering is accurate~~
  - [x] ~~`hld-agentic-framework.md` — restructure, simplify, add diagrams, examples, and demo recordings~~
  - [x] ~~`about.md` — resolve outstanding `{/* todo */}` comments (license link, UI kit naming, next steps links)~~
- [x] ~~Update docs with Harrie — coordinate on public-facing documentation site alignment~~

### Key Question

- **Workers monorepo layout:** Align with Hemant — do we still need a `base/` folder per device-type vertical (`miners/`, `containers/`, …), or can we flatten that? Clarify what that layer buys us before locking `mdk-libraries.md` (monorepo section).

---

## ✅ Decisions Made

### 🔒 Repository Strategy

**Decision: Private repository.**
Publish packages to NPM from the private monorepo. Public access is via the published packages and the documentation site, not the source repo.
