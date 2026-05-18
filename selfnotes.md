# Self Notes — MDK Platform

> **Last Updated:** 2026-05-13 | Personal working notes and action items

---

## 🤖 Agentic Framework on MDK

> Priority: **High** — mid-call on Monday with agentic framework team

### Open Questions

- **MCP vs CLI:** How would an AI Agent use ORK? Define the canonical integration path.
  - The HLD already defines MCP as the entry point (`App Node → MCP Endpoint`). Clarify if CLI access is also needed for non-agentic scripting.
- **Agent-Generated UI:** Can agents generate UI dynamically using the `@tetherto/mdk-ui-devkit-react` component library?
  - Explore: agent inspects `mdk-contract.json` → auto-scaffolds a dashboard widget.

### To-Do

- Read QVAC Docs — understand their agentic patterns and how they map to MDK's MCP tool derivation (§4.2.1 in HLD)
- Build POC: end-to-end agentic flow (Agent → MCP → App Node → ORK → Worker)
  - Example use-case: *"Generate a report I want to send to the boss"* — agent queries telemetry, aggregates fleet stats, renders a formatted report
  - Example use-case: *"Take action"* — agent detects anomaly and executes a command autonomously

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

- Clarify naming for each package — ensure 1:1 mapping between package names and architecture diagrams (see `mdk-libraries.md`)
- Workers in monorepo are built by us — explicitly mention this ownership boundary in the docs
  - Workers ship as reference implementations; external integrators build their own by subclassing `@tetherto/mdk-worker-base`
- Improve + refine the architecture docs (HLD + supplementary)
  - `hld.md` — review for completeness after recent protocol simplification
  - `hld-mdk-app.md` — ensure frontend toolkit layering is accurate
  - `about.md` — resolve outstanding `{/* todo */}` comments (license link, UI kit naming, next steps links)
- Update docs with Harrie — coordinate on public-facing documentation site alignment

### Key Question

- **Workers monorepo layout:** Align with Hemant — do we still need a `base/` folder per device-type vertical (`miners/`, `containers/`, …), or can we flatten that? Clarify what that layer buys us before locking `mdk-libraries.md` (monorepo section).

---

## 🔒 Repository Strategy

> Priority: **Low** — decision made

**Decision: Private repository is the way to go.**

Publish packages to NPM from the private monorepo. Public access is via the published packages and the documentation site, not the source repo.

---

Gio:
My only comment would be on device-lib
These are not for "device" only but you can build a lib to integrate a third party service like mempool.space or a mining pool, etc 
These are not devices, so probably call it just lib would be better. Wdyt?
