## `02-architecture.md`
# MDK Architecture Proposal

## 1. Why This Proposal

MDK today has a solid foundation: device libraries organized by brand/model,
a separation between App Node, ORK, and workers, flexible deployment from
single-process to microservices, and persistent storage via Hyperbee.

But as we scale to more device types, more external contributors, and more
diverse consumers (UIs, AI agents, CLIs), we're hitting a structural limit:

**Adding a new device type today requires changes to ORK and App Node.**

That coupling is the core problem. ORK shouldn't need to know what a
Whatsminer is. App Node shouldn't need hardcoded routes per device type.
External contributors shouldn't need to understand our internals to integrate
a new device.

This proposal introduces four architectural changes that eliminate this
coupling while preserving everything that already works.


## 2. What's Changing

### 2.1 A Formal Protocol Between Components

Today, the contract between ORK and workers is implicit — it's whatever
the lib class exposes. Single-process and multi-process modes use different
communication patterns under the hood.

**The change:** Define a single, explicit protocol specification that governs
all communication — whether in-process or over HRPC. Same messages, same
semantics, same contract. Only the transport changes.

This means:
- Every interaction follows a defined message format
- Workers become truly independent — they implement the protocol, not ORK internals
- New device types can be added by implementing the protocol contract
- External developers can build against a spec, not against source code

→ See **protocol.md** for the full message taxonomy, envelope format,
  and lifecycle semantics.

### 2.2 ORK Becomes a Modular Kernel

Today ORK is described as an orchestration/routing layer. In practice it
already does more than that — but its responsibilities aren't formally
separated, which means logic leaks between modules and testing is harder
than it should be.

**The change:** Formalize ORK as the system's coordination kernel, with
six explicitly separated internal modules:

```text
┌─────────────────────────────────────────────────────────┐
│                      ORK KERNEL                          │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   Command     │  │  Scheduler   │  │    Health     │  │
│  │  Dispatcher   │  │  (tick loop) │  │   Monitor     │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                  │           │
│  ┌──────┴───────┐  ┌─────┴────────┐  ┌─────┴────────┐  │
│  │   Command     │  │ Concurrency  │  │    Fault      │  │
│  │ State Machine │  │   Manager    │  │  Supervisor   │  │
│  └──────┬───────┘  └──────────────┘  └──────────────┘  │
│         │                                                │
│  ┌──────┴───────┐  ┌──────────────────────────────────┐ │
│  │ Persistence   │  │       Worker Registry            │ │
│  │ Layer         │  │   (capabilities, health, state)  │ │
│  └──────────────┘  └──────────────────────────────────┘ │
│                                                          │
│  ┌──────────────────────────────────────────────────────┐│
│  │             Telemetry Collector                       ││
│  └──────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

Each module has explicit interfaces, can be independently tested, and
can fail without crashing the others. Key additions include:

- **Command State Machine** with a formal lifecycle
  (QUEUED → DISPATCHED → EXECUTING → SUCCESS/FAILED/TIMEOUT/DEAD),
  persisted to Hyperbee WAL with crash recovery
- **Concurrency Manager** with per-device locks, per-worker capacity
  limits, and backpressure signaling
- **Fault Supervisor** implementing the circuit breaker pattern
  per worker (CLOSED → OPEN → HALF-OPEN)

→ See **ork.md** for the full module decomposition, state machine
  definition, and recovery semantics.

### 2.3 App Node Becomes a Plugin Host

Today App Node serves REST endpoints for a known set of device types.
Adding a new device means adding new routes to App Node.

**The change:** App Node becomes a generic API gateway with a plugin
slot system. It has no built-in knowledge of any device type. Each
integration provides a **Node Plugin** that registers its own routes,
capabilities, and worker type.

```text
┌──────────────────────────────────────────────────────────┐
│                       APP NODE                            │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  CORE (thin, generic)                                │ │
│  │  HTTP server • Auth • Plugin loader • HRPC to ORK   │ │
│  │                                                      │ │
│  │  Built-in routes:                                    │ │
│  │    GET  /health                                      │ │
│  │    GET  /plugins     (discover loaded plugins)       │ │
│  │    GET  /devices     (aggregate across all plugins)  │ │
│  └──────────────────────┬──────────────────────────────┘ │
│                          │ plugin.register(app)           │
│  ┌───────────────────────┴──────────────────────────────┐│
│  │  PLUGIN SLOTS                                         ││
│  │                                                       ││
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐  ││
│  │  │Whatsminer│ │ Antminer │ │ Bitdeer  │ │ Power  │  ││
│  │  │  Plugin  │ │  Plugin  │ │  Plugin  │ │ Plugin │  ││
│  │  │ /wm/... │ │ /am/...  │ │ /bd/...  │ │ /pm/.. │  ││
│  │  └──────────┘ └──────────┘ └──────────┘ └────────┘  ││
│  │                                                       ││
│  │  ┌──────────────┐                                     ││
│  │  │ Any external │  ← Companies build these            ││
│  │  │   plugin     │                                     ││
│  │  └──────────────┘                                     ││
│  └───────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────┘
```

Each plugin declares its routes, capabilities, and corresponding worker
type. The App Node discovers what's available at startup and exposes
a self-describing API surface via `GET /plugins`.

→ See **node.md** for the plugin interface contract, loader design,
  and configuration model.

### 2.4 Workers Declare Capabilities

Today all device libs expose a flat standard interface. But devices have
wildly different capabilities — a power meter is not a miner.

**The change:** Every worker, on registration, declares what it can do.
ORK maintains a **capability registry** built from these declarations.
Commands are validated against capabilities. Consumers (UI, AI agents,
CLIs) can discover what's available without hardcoded knowledge.

This is what allows ORK to stay generic — it routes and validates based
on declared capabilities, not device-specific logic.

→ See **worker.md** for the capability declaration format, registration
  flow, and worker lifecycle.

---

## 3. Full System View

```text
╔═══════════════════════════════════════════════════════════════════════╗
║                            CONSUMERS                                 ║
║                                                                       ║
║  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐        ║
║  │ MDK UI Kit│  │ Custom UI │  │ AI Agent  │  │ CLI / SDK │        ║
║  │ (React)   │  │ (any FE)  │  │ (LLM)    │  │ Consumer  │        ║
║  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘        ║
║        └───────────────┴───────┬──────┴──────────────┘               ║
║                                │ REST / WebSocket                     ║
╠════════════════════════════════╪═════════════════════════════════════╣
║                         APP NODE                                      ║
║                                │                                      ║
║  ┌─────────────────────────────┴────────────────────────────────┐    ║
║  │                    APP NODE CORE (thin, generic)              │    ║
║  │                                                               │    ║
║  │  ┌────────────┐  ┌──────────────┐  ┌──────────────┐         │    ║
║  │  │ Auth       │  │ Session      │  │ Plugin       │         │    ║
║  │  │ Middleware  │  │ Manager      │  │ Registry     │         │    ║
║  │  └────────────┘  └──────────────┘  └──────┬───────┘         │    ║
║  │                                            │                  │    ║
║  │  ┌─────────────────────────────────────────┴──────────────┐  │    ║
║  │  │                   PLUGIN SLOTS                          │  │    ║
║  │  │                                                         │  │    ║
║  │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐         │  │    ║
║  │  │  │ Whatsminer │ │ Antminer  │ │ Power      │  ...     │  │    ║
║  │  │  │ Node Plugin│ │ Node Plugin│ │ Node Plugin│         │  │    ║
║  │  │  │            │ │           │ │            │         │  │    ║
║  │  │  │ GET /wm/.. │ │ GET /am/..│ │ GET /pm/.. │         │  │    ║
║  │  │  │ POST /wm/. │ │ POST /am/.│ │            │         │  │    ║
║  │  │  │ WS /wm/ev  │ │ WS /am/ev │ │            │         │  │    ║
║  │  │  └─────┬──────┘ └─────┬─────┘ └─────┬──────┘         │  │    ║
║  │  └────────┼──────────────┼─────────────┼──────────────────┘  │    ║
║  └───────────┼──────────────┼─────────────┼─────────────────────┘    ║
║              └──────────────┴──────┬──────┘                          ║
║                                    │ HRPC (in-process or network)     ║
╠════════════════════════════════════╪═════════════════════════════════╣
║                              ORK KERNEL                               ║
║                                    │                                  ║
║  ┌─────────────────────────────────┴──────────────────────────────┐  ║
║  │                                                                 │  ║
║  │  ┌──────────────┐ ┌────────────┐ ┌──────────────┐             │  ║
║  │  │ Command      │ │ Scheduler  │ │ Health       │             │  ║
║  │  │ Dispatcher   │ │ (tick loop)│ │ Monitor      │             │  ║
║  │  └──────┬───────┘ └─────┬──────┘ └──────┬───────┘             │  ║
║  │         │               │               │                      │  ║
║  │  ┌──────┴───────┐ ┌────┴────────┐ ┌────┴──────────┐          │  ║
║  │  │ Command      │ │ Concurrency │ │ Fault         │          │  ║
║  │  │ State Machine│ │ Manager     │ │ Supervisor    │          │  ║
║  │  └──────┬───────┘ └─────────────┘ └───────────────┘          │  ║
║  │         │                                                      │  ║
║  │  ┌──────┴───────┐ ┌──────────────────────────────────────┐   │  ║
║  │  │ Persistence  │ │ Worker Registry                       │   │  ║
║  │  │ Layer ◄──────┤ │  ┌────────┐ ┌────────┐ ┌────────┐   │   │  ║
║  │  │ (Hyperbee)   │ │  │Slot 1  │ │Slot 2  │ │Slot N  │   │   │  ║
║  │  └──────────────┘ │  └───┬────┘ └───┬────┘ └───┬────┘   │   │  ║
║  │                    └──────┼──────────┼──────────┼─────────┘   │  ║
║  │  ┌────────────────────────────────────────────────────────┐   │  ║
║  │  │ Telemetry Collector                                     │   │  ║
║  │  │  - Aggregate metrics, write to Hyperbee                 │   │  ║
║  │  │  - Push events to App Node via HRPC stream              │   │  ║
║  │  │  - Downsample / compact old data                        │   │  ║
║  │  └────────────────────────────────────────────────────────┘   │  ║
║  └────────────────────────────────────────────────────────────────┘  ║
║              │              │              │                          ║
║              │ HRPC         │ HRPC         │ HRPC                    ║
╠══════════════╪══════════════╪══════════════╪═════════════════════════╣
║         WORKERS (DEVICE LIBS)                                        ║
║              │              │              │                          ║
║  ┌───────────┴──┐ ┌────────┴────┐ ┌──────┴───────┐                 ║
║  │ Whatsminer   │ │ Antminer    │ │ Power Meter  │  ...            ║
║  │ Worker       │ │ Worker      │ │ Worker       │                 ║
║  │ ┌──────────┐ │ │ ┌─────────┐ │ │ ┌──────────┐ │                 ║
║  │ │Device Lib│ │ │ │Device Lib│ │ │ │Device Lib│ │                 ║
║  │ │(WM_M56S) │ │ │ │(AM_S21) │ │ │ │(PM_100)  │ │                 ║
║  │ └────┬─────┘ │ │ └────┬────┘ │ │ └────┬─────┘ │                 ║
║  └──────┼───────┘ └──────┼──────┘ └──────┼───────┘                 ║
║         ▼                ▼               ▼                           ║
║    ⛏ Miners         ⛏ Miners        ⚡ Power Meters                 ║
╚═════════════════════════════════════════════════════════════════════╝

                      STORAGE LAYER (CROSS-CUTTING)

  ┌────────────────────────────────────────────────────────────────┐
  │                      HYPERBEE STORE                             │
  │           (1M+ ops/sec — critical assumption)                   │
  │                                                                 │
  │  ┌───────────┐ ┌────────────┐ ┌──────────┐ ┌────────────┐    │
  │  │ Command   │ │ Telemetry  │ │ Device   │ │ Event      │    │
  │  │ Log (WAL) │ │ Time-Series│ │ State    │ │ Log (audit)│    │
  │  └───────────┘ └────────────┘ └──────────┘ └────────────┘    │
  │                                                                 │
  │  ┌──────────────┐                                              │
  │  │ Worker       │                                              │
  │  │ Registry     │                                              │
  │  └──────────────┘                                              │
  │                                                                 │
  │  Append-only │ Crash-resilient │ B-tree indexed │ Replicable   │
  └────────────────────────────────────────────────────────────────┘
```

---

## 4. What This Solves

### Before (current)

Adding a new device type requires:

1. Write the device lib ✓
2. Modify ORK to handle the new type ✗
3. Modify App Node to add routes ✗
4. Test across single and multi-process modes
5. Release a new MDK version

### After (proposed)

1. Write a plugin package (device lib + worker + node plugin)
2. Add it to `mdk.config.json`
3. Restart MDK
4. Done — ORK and App Node discover it automatically

Steps 2 and 3 from "before" disappear entirely.

---

## 5. What's NOT Changing

These are strengths of the current design that remain untouched:

- **Deployment flexibility** — single-process, PM2, Docker/K8s
- **Hyperbee storage** — append-only, crash-resilient, local-first
- **HRPC for multi-process communication**
- **Config-driven deployment** via `mdk.config.json`
- **Device libs organized by brand/model**
- **Security-by-design** — explicit interfaces, no implicit exposure,
  least-privilege workers
- **The fundamental topology**: Consumers → Node → ORK → Workers → Devices

---

## 6. The External Integration Model

When a company wants to integrate their device into MDK, they ship
**one npm package** containing everything:

```text
@acme-corp/mdk-plugin-acmeminer
├── lib/             ← Device communication logic
├── worker/          ← Worker (HRPC ↔ device lib)
├── node-plugin/     ← App Node plugin (REST routes)
├── ui/              ← Optional React components
└── package.json
```

Consumer installs:

```bash
npm install @tetherto/mdk @acme-corp/mdk-plugin-acmeminer
```

Result: the plugin's worker registers with ORK, the plugin's node plugin
registers routes on App Node, and the optional UI components become
available to any frontend consuming MDK UI Kit.

**Zero core changes. Zero MDK team involvement.**

---

## 7. Data Flow (End-to-End Example)

A user clicks "Reboot" on device WM001 in the UI:

```text
UI ──POST /wm/WM001/reboot──► App Node (Whatsminer Plugin)
                                  │
                                  │ orkClient.sendCommand()
                                  ▼
                               ORK Command Dispatcher
                                  │ validate → registry lookup → concurrency check
                                  ▼
                               Command State Machine
                                  │ QUEUED → WAL write
                                  │ DISPATCHED → send to worker via HRPC
                                  ▼
                               Whatsminer Worker
                                  │ device lib calls physical miner
                                  ▼
                               Physical Device reboots
                                  │
                               Worker → ORK: result
                                  │ EXECUTING → SUCCESS → WAL write
                                  │ release concurrency lock
                                  │ record success in fault supervisor
                                  ▼
                               ORK → App Node → UI
                                  HTTP 200 + WebSocket state update
```

Every state transition is persisted. If ORK crashes mid-command,
recovery on restart re-queues in-flight commands automatically.

---

## 8. Companion Documents

This document provides the architectural overview. For implementation
details, see:

| Document | Covers |
|---|---|
| **03-protocol.md** | Message format, envelope spec, action taxonomy, transport independence |
| **04-ork.md** | Module decomposition, command state machine, concurrency, fault supervision, crash recovery |
| **05-node.md** | Plugin interface contract, loader, configuration, discovery endpoints |
| **06-worker.md** | Capability declaration, registration flow, worker lifecycle, health model |

---

## 9. Open Questions

See **07-open-questions.md** for the specific areas where we want
team input before moving forward.
```
