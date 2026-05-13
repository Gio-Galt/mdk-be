# MDK Libraries, Monorepo Layout & Terminology

Index of MDK packages, their canonical NPM names, and where they live on disk. For what MDK is, see [About MDK](./about.md); for architecture, see the [High-Level Design](./hld.md).

---

## Terminology legend

Short glossary for MDK docs and code. **Surface** follows the HLD stack (consumers → gateway → ORK → workers → devices).

| Term | Meaning | Surface |
| --- | --- | --- |
| **MDK** | *Mining Development Kit* — the open platform (protocol, packages, and tooling). | Both |
| **BE** / **backend** | Server-side and edge processes: ORK, App Node, Workers, and transport toward ORK. Not the browser. | BE |
| **FE** / **frontend** | Browser or native UI that talks to an **App Node** over HTTP/WebSocket — never directly to ORK in production. | FE |
| **ORK** / **mdk-ork** | Orchestration kernel — the central coordinator. No end-user auth. | BE |
| **Parallel ORKs** | Multiple independent ORK kernels (one per physical site) all overseen by a single App Node / AI Agent; the multi-site scaling model. See [HLD](./hld.md). | BE |
| **App Node** / **mdk-app-node** | Mandatory gateway between FE/agents and ORK. Owns JWT/RBAC and the MCP endpoint; uses **`@tetherto/mdk-client`** to reach ORK. | BE |
| **JWT / RBAC** | Bearer-token auth (JWT) and role-based access control (RBAC) enforced exclusively at the App Node before any traffic reaches ORK. See [HLD](./hld.md). | BE |
| **ORK whitelisting** | ORK-level allowlist of approved App Node / client connections authenticated via HRPC keys; replaces per-user auth at the kernel level. See [HLD](./hld.md). | BE |
| **MCP** | Model Context Protocol endpoint on the App Node — same auth/RBAC as other clients. | BE (endpoint consumed by agents) |
| **mdk-client** | Universal MDK Protocol client (`hrpc://` / `ipc://` transports). | BE (primary: Node; Python/Go planned) |
| **Worker** | Edge process: speaks MDK Protocol **up** to ORK and device-native protocol **down** to hardware. | BE / Edge |
| **mdk-worker-base** | Abstract base SDK for building Workers (`@tetherto/mdk-worker-base`). | BE / Edge |
| **MDK Protocol** | Shared envelope (`id`, `type`, `action`, `payload`, …) and action set (`command.request`, `telemetry.pull`, …). | BE (wire); FE only via App Node APIs |
| **mdk-contract.json** | Per-worker capability + AI context schema; validated against **`mdk-contract.schema.json`**. | BE (declared by Worker; surfaced via App Node APIs) |
| **mdk-contract.schema.json** | JSON Schema file that validates any worker's `mdk-contract.json`; the authoritative structural contract every external integrator must satisfy. See [HLD](./hld.md). | BE |
| **Device-Lib Contract** | Strict interface spec an external integrator must implement to expose a new device type as a compatible Worker (capability schema + `onCommand` / `onTelemetryPull`). See [HLD](./hld.md). | BE / Edge |
| **Device-Lib Template** | Starter scaffold for building a Device-Lib-Contract-compliant worker package (wraps device protocol, declares `mdk-contract.json`, subclasses `mdk-worker-base`). See [HLD](./hld.md). | BE / Edge |
| **HRPC / Hyperswarm** | Encrypted P2P streams used for server↔server transport (e.g. App Node ↔ ORK, multi-site). | BE |
| **IPC** | Local-socket transport (`ipc://` scheme in `mdk-client`); used for low-latency same-host connections in testing and co-located deployments. See [HLD](./hld.md). | BE |
| **DHT topic** | Hyperswarm discovery topic Workers join passively; ORK listens on the same topic to detect new peers without any Worker-initiated RPC. See [HLD](./hld.md). | BE |
| **Hypercore** | Append-only distributed log (holepunchto); the foundational storage primitive underlying Hyperbee and other Hyper-stack data structures. See [HLD](./hld.md). | BE |
| **Hyperbee** | B-tree key-value store built on Hypercore; recommended persistent store for ORK state, Worker telemetry, and App Node data. See [HLD](./hld.md). | BE |
| **WAL** | Write-Ahead Log; ORK scans this on restart to detect and recover stranded `EXECUTING` commands. See [HLD](./hld.md). | BE |
| **Hyperschema** | Schema / validation library (holepunchto) used to govern MDK Protocol message contracts across ORK, App Node, and Workers. See [HLD](./hld.md). | BE |
| **RPC (Worker)** | ORK-initiated requests **down** to Workers only — Workers respond, they do not call ORK. | BE / Edge |
| **Plugin (MDK-App)** | Optional App Node + UI extension model (fleet logic, dashboard widgets). See [MDK App HLD](./hld-mdk-app.md). | Both |
| **MDK App Toolkit** | "Batteries-included" open-source layer combining the frontend toolkit and backend App Node middleware; sits above ORK for rapid app development. See [MDK App HLD](./hld-mdk-app.md). | Both |
| **App Shell** | Pre-built deployable React dashboard (`apps/mdk-shell`); hosts MDK-App Widgets and wires the full frontend toolkit at runtime. See [MDK App HLD](./hld-mdk-app.md). | FE |
| **MDK-App Widget** | Frontend React component supplied by a Plugin; mounts into the App Shell grid and queries the paired MDK-App Server route. See [MDK App HLD](./hld-mdk-app.md). | FE |
| **MDK-App Server** | Backend route package supplied by a Plugin; injects custom API endpoints into the App Node middleware at runtime. See [MDK App HLD](./hld-mdk-app.md). | BE |
| **ui-client** / **mdk-ui-core** | Headless browser client — no React. Folder name `ui-client`; package name stays `@tetherto/mdk-ui-core`. | FE |
| **mdk-react** | Thin React bindings over `mdk-ui-core`. | FE |
| **mdk-ui-devkit-react** | Radix-based React component library for dashboards. | FE |

---

## Package index

See the legend above for what each package conceptually *is*; the **Description** column lists what the package ships and its key tech.

| S.No. | Folder | Package | Domain | Description |
| --- | --- | --- | --- | --- |
| 1 | `packages/core/ork/` | **`@tetherto/mdk-ork`** | Backend | Ships the Kernel: worker registry, command dispatcher, telemetry state machines. |
| 2 | `packages/core/client/` | **`@tetherto/mdk-client`** | Backend / Comm | Transport SDK over IPC/HRPC; message envelopes and reconnect. |
| 3 | `packages/core/app-node/` | **`@tetherto/mdk-app-node`** | Backend | Fastify/Express middleware bundle: JWT, RBAC, REST/WS routes, MCP server. |
| 4 | `packages/workers/base/` | **`@tetherto/mdk-worker-base`** | Backend / Edge | Shared worker library: subclass for HRPC/MDK Protocol plumbing, `onTelemetryPull` / `onCommand`, and capability wiring; base for all device workers below. |
| 5 | `packages/ui/ui-core/` | **`@tetherto/mdk-ui-core`** | Frontend | Headless state + API client; telemetry buffering and optimistic UI. Zero framework deps. |
| 6 | `packages/ui/react/` | **`@tetherto/mdk-react`** | Frontend | React hooks over `mdk-ui-core` (e.g. `useTelemetry`). |
| 7 | `packages/ui/ui-devkit-react/` | **`@tetherto/mdk-ui-devkit-react`** | Frontend | Radix-based React component library; 3-tier CSS customization, no host Tailwind dependency. |
| 8 | `packages/workers/miners/whatsminer/` | **`@tetherto/mdk-worker-whatsminer`** | Backend / Edge | Reference Whatsminer worker; device protocol translation + contract-driven capabilities for ORK/MCP. |
| 9 | `packages/workers/miners/antminer/` | **`@tetherto/mdk-worker-antminer`** | Backend / Edge | Reference Antminer worker; device protocol translation + contract-driven capabilities for ORK/MCP. |
| 10 | `packages/workers/miners/avalon/` | **`@tetherto/mdk-worker-avalon`** | Backend / Edge | Reference Avalon worker; device protocol translation + contract-driven capabilities for ORK/MCP. |
| 11 | `packages/workers/containers/antspace/` | **`@tetherto/mdk-worker-antspace`** | Backend / Edge | Reference Antspace container worker; device protocol translation + contract-driven capabilities for ORK/MCP. |
| 12 | `packages/workers/temperature/generic-temp/` | **`@tetherto/mdk-worker-temperature-generic`** | Backend / Edge | Reference generic temperature sensor worker; device protocol translation + contract-driven capabilities for ORK/MCP. |
| 13 | `packages/workers/power-meter/seneca/` | **`@tetherto/mdk-worker-power-meter-seneca`** | Backend / Edge | Reference Seneca power-meter worker; device protocol translation + contract-driven capabilities for ORK/MCP. |

---

## Monorepo folder structure

```text
mdk/
├── apps/                            # 🚀 Deployable applications & reference implementations
│   ├── mdk-ui-shell/                # The pre-built React App Shell / Dashboard
│   ├── single-process-mode/         # A reference implementation of all components, from a single executable
│   └── multi-process-mode/          # A reference implementation of all components, from a multiple executable
│
├── packages/                        # 📦 Publishable NPM libraries
│   │
│   ├── core/                        # Core infrastructure (BE)
│   │   ├── ork/                     # @tetherto/mdk-ork
│   │   ├── client/                  # @tetherto/mdk-client
│   │   └── app-node/                # @tetherto/mdk-app-node
│   │
│   ├── ui-client/                   # Frontend toolkit (FE)
│   │   ├── ui-core/                 # @tetherto/mdk-ui-core
│   │   ├── react/                   # @tetherto/mdk-react
│   │   ├── ui-devkit-react/         # @tetherto/mdk-ui-devkit-react
│   │   └── fonts/                   # @tetherto/mdk-fonts
│   │
│   └── workers/                     # Hardware integration (reference workers built by us)
│       ├── base/                    # @tetherto/mdk-worker-base
│       │
│       ├── miners/                  # ⛏️ Miner device workers
│       │   ├── whatsminer/          # @tetherto/mdk-worker-whatsminer
│       │   ├── antminer/            # @tetherto/mdk-worker-antminer
│       │   └── avalon/              # @tetherto/mdk-worker-avalon
│       │
│       ├── containers/              # 📦 Container device workers
│       │   └── antspace/            # @tetherto/mdk-worker-antspace
│       │
│       ├── temperature/             # 🌡️ Temperature sensor workers
│       │   └── generic-temp/        # @tetherto/mdk-worker-temperature-generic
│       │
│       └── power-meter/             # ⚡ Power meter workers
│           └── seneca/              # @tetherto/mdk-worker-power-meter-seneca
```
