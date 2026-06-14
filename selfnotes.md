# Self Notes — MDK Platform

> **Last Updated:** 2026-05-18 | Personal working notes and action items

---

## 🤖 Agentic Framework on MDK

> Priority: **High** — mid-call on Monday with agentic framework team

### Open Questions

- ~~**MCP vs CLI:** How would an AI Agent use ORK? Define the canonical integration path.~~ — **Resolved.** MCP chosen; rationale + comparison documented in `hld-agentic-framework.md` §3.4.
- ~~**Agent-Generated UI:** Can agents generate UI dynamically using the `@tetherto/mdk-ui-devkit-react` component library?~~ — **Resolved.** Yes — Operator Agent selects from a visualization catalogue and the contract-driven UI renderer materialises it. See `hld-agentic-framework.md` §3.5, §3.7.

### To-Do

- ~~Read QVAC Docs — understand their agentic patterns and how they map to MDK's MCP tool derivation (§4.2.1 in HLD)~~ — QVAC HTTP server reviewed; integration path documented in `hld-agentic-framework.md` §3.7 (LLM Provider).
- ~~Build POC: end-to-end agentic flow (Agent → MCP → App Node → ORK → Worker)~~ — POC lives at `mdk-be/poc/`; demo recordings under `mdk-be/docs/demo-videos/`.
  - ~~Example use-case: *"Generate a report I want to send to the boss"~~* — covered as Use Case A in HLD.
  - ~~Example use-case: *"Take action"~~* — covered as Use Case B in HLD; demo: `set_power_limit_to_miner.mov`.

---

## 🏗️ MOS → MDK Migration

~~> Priority: **High** — requires cross-team alignment (Hemant, Arif)~~

### ~~Goal~~

~~Disintegrate the existing MOS monolith ([demo.mos.tether.io](https://demo.mos.tether.io/)) and identify gaps when mapping features into the MDK architecture.~~

### ~~Key Question~~

~~Can we extract the features visible in the MOS sidebar into separate, pluggable modules combining BE + FE as MDK-App Plugins?~~

- ~~**Where does the backend code for these features live today?** Audit the current MOS codebase.~~
- ~~**Where should it live in MDK?**~~

### ~~To-Do~~

- ~~Discuss with Hemant and Arif — audit MOS sidebar features~~
- ~~Discuss with them on how to bootstrap a deployment of MDK (ui + appnode), then would need a cil like npx create-mdk-instance~~
- ~~Create a feature-to-MDK mapping table (feature → package/plugin)~~
- ~~Identify gaps: features MOS supports that MDK architecture doesn't yet cover~~
- ~~Confirm the abstraction with Gio~~

### Follow-ups

- **Document the asymmetric extraction model for BE vs FE plugins.**
  - **Backend:** API business logic is extracted into separate, pluggable folders/packages — loaded dynamically by the App Node from a JSON manifest (route → controller mapping, AI/agent context). Captured in `[hld-app-node-plugins.md](./hld-app-node-plugins.md)`; reference that doc and tighten the rationale here.
  - **Frontend:** UI is intentionally **not** loaded the same way. It follows the shadcn-style copy-paste model from `hld-mdk-app.md` §2.3 — developers own the source, styling, and layout. Spell out *why* the asymmetry exists: runtime BE plugin loading buys multi-tenant aggregation flexibility, while FE plugin runtime loading would compromise styling control, bundle size, and the headless-core boundary.
  - Deliverable: a short companion doc (e.g. `hld-extraction-model.md`) cross-linked from both `hld-mdk-app.md` and `hld-app-node-plugins.md`.
- **Bootstrap story for a new MDK deployment.** Define how a developer spins up `ui + app-node` from scratch.
  - Target DX: `npx create-mdk-instance <name>` scaffolds a working monorepo (App Node + App Shell + sample plugin + sample widget).
  - Decide ownership and repo location for the CLI (likely `mdk-prv/packages/tooling/create-mdk-instance`).
  - Align with Hemant and Arif on: template contents, default plugins shipped, config defaults, and the upgrade path when core packages bump versions.

---

## 📦 Documentation & Naming

> Priority: **Medium**

### To-Do

- ~~Clarify naming for each package — ensure 1:1 mapping between package names and architecture diagrams (see `mdk-libraries.md`)~~
- **Rename `device-lib` → `lib`** (per Gio) — `device-lib` is misleading because the same package shape is used for non-device integrations (mempool.space, mining pools, other third-party services). Update `mdk-libraries.md` and any references in HLD docs accordingly.
- Workers in monorepo are built by us — explicitly mention this ownership boundary in the docs
  - Workers ship as reference implementations; external integrators build their own by subclassing `@tetherto/mdk-worker-base`
- Improve + refine the architecture docs (HLD + supplementary)
  - ~~`hld.md` — review for completeness after recent protocol simplification~~
  - ~~`hld-mdk-app.md` — ensure frontend toolkit layering is accurate~~
  - ~~`hld-agentic-framework.md` — restructure, simplify, add diagrams, examples, and demo recordings~~
  - ~~`about.md` — resolve outstanding `{/* todo */}` comments (license link, UI kit naming, next steps links)~~
- ~~Update docs with Harrie — coordinate on public-facing documentation site alignment~~

### Key Question

- **Workers monorepo layout:** Align with Hemant — do we still need a `base/` folder per device-type vertical (`miners/`, `containers/`, …), or can we flatten that? Clarify what that layer buys us before locking `mdk-libraries.md` (monorepo section).
- Talk to Parag and build MDK Coding Agent Skill from Parag's exising work (Robert may have some suggestion, not clear tho!) along with Harrie's doc

---

### ~~🔒 Repository Strategy~~

~~**Decision: Private repository.**~~

- ~~Publish packages to NPM from the private monorepo. Public access is via the published packages and the documentation site, not the source repo.~~
- Should we have weekly call where Dev would showcase the progress in tech + product goals.

---

1. sync mdk-libraries with mdk-prv folder strcutre
2. read .github folder n review ci/cd
3. use relative path via npm workspace, rather than ../
4. examples at mdk-prv/packages/core/examples & mdk-prv/packages/core/mdk, should move in correct places.

4.1 Top-level apps or examples These are runnable, cross-package demos. like mdk-prv/packages/core/ork/examples
4.2 Per-package examples/ folders under each publishable package (packages/core/ork/examples/, packages/core/client/examples/, every worker package, etc.) for single-package, copy-pasteable snippets that the package's README.md links to. 

1. libs-stat should not be part of core, it should moved to seperate lib/stat package, to be used in app-node plugin
2. add readme file to each package
3. add linting from start
4. add precommit hoooks to avoid pushing any bad code
5. what is this mock-control-service?
6. move all back to one template folder / package
7. should rename app node to gateway

__

for point 3

the absolute best way to handle this in Node.js—such that you don't have to deal with nested relative imports like ../../../base/lib/... inside your monorepo, and the packages can be cleanly published and deployed to npm—is to use npm Workspaces coupled with proper package configuration.

This is natively supported by Node.js and npm (since npm v7) with zero build steps or third-party libraries required.

Here is how the solution works, what we configured, and how it addresses both local development and npm publishing.

The Architecture: How to Deal with it
In local development (monorepo):
We define npm Workspaces at the parent level. When you run npm install at the workspace root, npm automatically creates symbolic links in the local node_modules/ folder pointing directly to the other directories in your monorepo. This allows you to import local packages using their official package names (e.g. require('@tetherto/tpl-lib-thing')).

When deploying / publishing to npm:
Since you are already using official package names in your require() calls and those local cross-dependencies are listed in the dependencies field of each package.json, when someone installs your published package from the npm registry, npm will fetch and install the correct packages from the registry.

what is the automated test case runner? how can i run for entire project at once? is there any gates which block if coverage is not enough? 

can we keep allow TS code as well if someone wants to build the integration in TS? we still keep our code is JS n later transpile it to TS if needed. but the flexiblity in the monorepo to write TS code for any intergration should be there. 

should we call app-node as gateway? much more generic term for outside to understand, rather than app-node which is very spefic to internal org level detail and other may misinterpret it 

const { getOrk, startWorker } = require('../../../backend/core/mdk'): what exactly does this library has 

__

opt out from ai context 

does FE really needs to send MDK protocol messages? 

OpenAPI standard we want to then how it will work?

secrurity aspect from selfnotes

mcp poc on top of app-node

release process doc from publsh, to ci to devsecops to marketting

__

[https://github.com/awslabs/nx-plugin-for-aws](https://github.com/awslabs/nx-plugin-for-aws)

[https://github.com/aws/agent-toolkit-for-aws/](https://github.com/aws/agent-toolkit-for-aws/)

[https://smithy.io/](https://smithy.io/)

[https://github.com/awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator)

[https://github.com/awslabs/mcp](https://github.com/awslabs/mcp)

create code agent specfic plugin to served to their marketplace native

doc for cli 