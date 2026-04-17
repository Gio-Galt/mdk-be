# MDK — High-Level Design (HLD)

> **Version:** 0.3.0 &nbsp;|&nbsp; **Date:** 2026-04-16 &nbsp;|&nbsp; **Status:** Draft
>
> Derived from the [MDK Architecture Proposal] by Gio.

---

## 1. Introduction

### 1.1 Purpose

This document translates the MDK architecture proposal into a **developer-facing High-Level Design** considering the discussion with Chetas, Gio, Hemant & Parag.

### 1.2 Design Rationale: Flexibility vs. Rigidity

**"Make the common case easy, and the rare case possible — not equally easy."**

A guiding principle of the MDK architecture is avoiding the trap where unbound flexibility leads to system rigidity. Highly flexible systems—often characterized by boundless dynamic configuration, implicit rules, and over-engineered abstractions meant for "every possible future use case"—inevitably have hidden dependencies and steep maintenance burdens. Over time, fear of breaking interconnected logic stalls development, and the resulting chaos eventually forces strict rules, resulting in a rigid platform.

To prevent this, MDK intentionally balances constraints:
- **Opinionated where it must be:** Strict transport envelopes, formal unified JSON semantic schema and clear unidirectional data flows. 
- **Flexible where it matters:** The translation logic residing in isolated Workers allows endless integration points for any hardware without bleeding complex edge-cases back into the core orchestrator.

### 1.3 Scope & Companion Documents

This document covers the **MDK Core Infrastructure**, explicitly focused on the orchestration engine (ORK), the `mdk-contract` schema, worker hardware integration, and the HRPC protocol.

> [!NOTE]
> For developers building the application layer (App Nodes, Dashboards, and UI components), a completely optional, open-source SDK is available. Please see the companion document: **[MDK App Toolkit HLD (`hld-mdk-app.md`)](./hld-mdk-app.md)** for details on the headless `@mdk/ui-core`, React framework adapters, and the plug-and-play MDK-App Plugin architecture.

## 2. System Architecture

### 2.1 Layer overview

```mermaid
graph TB
    subgraph L1["Layer 1: Consumers"]
        UI["UI / Frontend"]
        AI["AI Agent"]
    end

    subgraph L2["Layer 2: App Node"]
        WebApp["HTTP / API Router"]
        MCPServer["MCP Server Endpoint"]
    end

    subgraph L3["Layer 3: ORK Kernel"]
        ORK["ORK"]
    end

    subgraph L4["Layer 4: Workers"]
        Workers["WORKERS"]
    end

    subgraph L5["Layer 5: Physical Devices"]
        Devices["PHYSICAL DEVICES"]
    end

    UI -->|"HTTP / WebSocket"| WebApp
    AI -->|"MCP Protocol"| MCPServer
    WebApp -->|"@mdk/client (HRPC)"| ORK
    MCPServer -->|"@mdk/client (HRPC)"| ORK
    Workers -.->|"announce via static channel"| ORK
    ORK -->|"pull (identity/schema/telemetry) + command"| Workers
    Workers -->|"device libs"| Devices
```

### 2.2 Storage layer

**Hyperbee** stays core to all storage requirements including in Ork, Worker or App Node for Command WAL, telemetry streams, state snapshots, and worker registry persistence.


## 3. MDK Protocol (v0.1.0 — Pull-Based)

### 3.1 Design principles

- **Transport-agnostic** — identical messages over in-process calls or HRPC or API Calls
- **Mostly Unidirectional Communication** — The *only* worker-initiated operations toward static channel are announce. All operational comms (telemetry, state, commands) are strictly pulled downwards from ORK to worker.
- **Generic Interface** — The interface accepted is defined dynamically at the worker level via a self-describing capabilities schema containing both structure and semantic context for AI agents.

### 3.1.1 Worker Discovery Model

Worker discovery follows an announce-and-pull mechanism using a static communication channel:

1. **Announce:** The Worker publishes/announces its presence in a static channel (known universally to ORK and all Workers).
2. **Identity Request:** The ORK kernel listens to this static channel and, upon detecting a new worker, connects and requests the worker's identity.
3. **Registration:** After receiving the identity, ORK saves the worker and its RPC keys into its registry.
4. **Capability Declaration:** ORK then explicitly queries the worker to declare its full capabilities (`mdk-contract.json`).

> **Note:** Once discovery and registration are complete, all subsequent operational communication (telemetry, state, commands) is always **strictly pull-based** from ORK to worker.



### 3.2 Message envelope

```json
{
  "id":            "uuid-v4",
  "version":       "0.1.0",
  "type":          "request | response | event",
  "action":        "<protocol action>",
  "sender":        "<component:type:instance>",
  "target":        "<component:type:instance> | null",
  "deviceId":      "string | null",
  "timestamp":     1711640000000,
  "payload":       {}
}
```
*Note: External consumers (UI/AI agents) only provide `deviceId`; the `target` worker identity is internally resolved by ORK.*

### 3.3 Core actions

| Action | Type | Direction | Purpose |
|---|---|---|---|
| `announce` | event | Worker → Static Channel | Worker broadcasts its presence and RPC endpoint |
| `identity.request` | request | ORK → Worker | ORK requests the worker's identity and managed devices |
| `capability.request` | request | ORK → Worker | ORK asks the worker to declare its full capability schema |
| `state.pull` | request | ORK → Worker | Worker returns a snapshot of worker state-machine status (Low cadence tick, e.g., 60s) |
| `telemetry.pull` | request | ORK → Worker | Worker returns device metrics plus historic metrics (Medium cadence tick, e.g., 10s) |
| `command.request` | request | ORK → Worker | ORK resolves the worker by `deviceId` and dispatches the command for execution |
| `health.ping` | request | ORK → Worker | Liveness probe |

### 3.4 Protocol Governance

To maintain structural integrity and contract stability across disparate components (ORK, App Node, Workers), the MDK Protocol messages are governed and validated using **Hyperschema** (https://github.com/holepunchto/hyperschema). Hyperschema aligns natively with the system's underlying Hyperbee storage, providing strict, binary-compact schema validation for every protocol message and event without the heavyweight toolchain overhead of Protobuf or gRPC.

### 3.5 Base Command Set

MDK standardizes a set of **Base Commands** that are supported by all workers:

- `getConfig`: Retrieve current device configuration.
- `setConfig`: Update device configuration parameters.
- `health`: Fetch detailed diagnostic health status from the device.


#### Protocol message flows

```mermaid
sequenceDiagram
    participant W as Worker
    participant Ch as Static Channel
    participant O as ORK
    participant G as Gateway (App Node / MCP)

    rect rgb(40, 40, 60)
    Note over W,O: Worker Discovery & Registration
    W->>Ch: Event: Announce Presence (RPC Keys)
    O-->>Ch: Listens & Detects Worker
    O->>W: identity.request
    W-->>O: identity.response (devices)
    O->>O: Save Worker to Registry
    O->>W: capability.request
    W-->>O: capability.response (schema)
    end

    rect rgb(40, 60, 40)
    Note over O,W: Telemetry (ORK Pull Loop)
    O->>W: telemetry.pull
    W-->>O: metrics & pending commands
    end

    rect rgb(60, 40, 40)
    Note over G,W: Command execution
    G->>O: MDK Protocol HRPC Envelope
    O->>W: command.request (routed by deviceId)
    W-->>O: command.result
    O-->>G: result
    end
```

---

## 4. Component Design

### 4.1 App Node — The Developer-Owned API Boundary

**Responsibility:** The mandatory boundary between the client-facing world and the ORK kernel.

The UI never connects to ORK directly. The App Node must sit between consumers and ORK. However, MDK does not force developers to use a generic App Node (written in a Node.js/Fastify) provided by the core team. 

The App Node is a *Layer* that developers fulfill using `@mdk/client` inside their preferred framework (Fastify, Hono, Django, Go).

App Node handles:
- **Fleet aggregation:** Computes site hashrate, avg temperature, cross-rack efficiency.
- **Auth / RBAC:** Guards all access to ORK with JWTs and session management.
- **API Surface:** Exposes REST, WebSocket, or GraphQL to the UI.

#### 4.1.1 Routing Contract

UI/AI agents should only provide `deviceId`; the App Node (via `@mdk/client`) passes this down. ORK resolves the owning worker internally and dispatches the `command.request`.

#### 4.1.2 Authentication

**JWT (Bearer Token)** is at the core of the App Node authentication loop. The App Node validates the JWT (signature, expiry, claims) before proxying any traffic into the ORK layer.

**ORK Whitelisting:** The ORK kernel does not perform user-level authentication. Instead, ORK maintains a strict whitelist of approved App Node/Client connections. Once whitelisted securely (e.g., via HRPC keys), ORK implicitly trusts the origin of the HRPC messages.

### 4.2 MCP Server & AI Agent Integration

**Responsibility:** Secure AI/Agent connectivity into the orchestration layer.

An AI Agent communicates with the MDK stack exclusively through the **App Node's MCP Endpoint**. An AI agent is treated as just another authenticated client.

**Under no circumstances do AI agents connect directly to ORK.** 
Because ORK lacks authentication, direct connections bypass all security limits. By binding the AI agent to the App Node via MCP, the agent needs to go through the same JWT validation, rate limits, RBAC as a human API consumer.

#### 4.2.1 MCP Tool Derivation

The tools exposed to the AI Agent (e.g., `list_fleet`, `get_device_telemetry`, `reboot_device`) are not hardcoded. The `@mdk/client` provides an interface to dynamically derives them from the `mdk-contract.json` of each worker.

**Context Format Contract:** Semantic AI context (e.g., Supported Commands, Constraints, Examples) is injected directly as keys within the strict JSON capabilities schema (`mdk-contract.json`). This ensures the programmatic definition and the reasoning context are tightly bound together.


### 4.3 ORK Kernel — Orchestration Engine

**Responsibility:** Trusted coordination kernel. 

ORK is characterized by split internal modules utilizing multiple state machines to track different domains without coupling, operating exclusively.

#### 4.3.1 High-level Modules

To ensure clear boundaries, persistence guarantees, and horizontal scalability, ORK is decomposed into distinct, single-responsibility modules. The ORK design is heavily inspired by the Node.js event loop and Kubernetes architecture, where a **pull-only model** scales exceptionally well. A push model could easily choke the receiver in high-traffic scenarios, but by strictly pulling, ORK intrinsically applies backpressure and dictates the pace of execution.

```mermaid
flowchart TD
    MCP[MCP Handler] -->|Validates/Routes| CD[Command Dispatcher]
    CD -->|Enqueues| CSM[Command State Machine]
    CSM <-->|HRPC Req/Res| W[Worker]
    SCH -->|Triggers State Pull| CSM
    CSM -->|state.pull| W
    WR[Worker Registry] -->|Routing lookup| CD
    HM[Health Monitor] -->|Updates Status| WR
    SCH[Scheduler] -->|Triggers Interval| HM
    SCH -->|Triggers Pull| TC[Telemetry Collector]
    TC -->|Pulls Metrics| W
```

For each core module, we define strict boundaries for business logic, interfaces, recovery, and scale:

##### 1. Command Dispatcher
*   **Business Logic / Responsibility:** Validates incoming commands against the generic MDK schema, checks permissions, and resolves the correct worker based on the `deviceId`. 
    *   *Example:* When an App Node sends a `reboot` command for `wm001`, the Dispatcher verifies that `wm001` exists, that `reboot` is a valid capability for it, and then passes the request to the State Machine.
*   **Interfaces:** 
    *   *Input:* Receives generic commands via HRPC/MDK Protocol from App Node or MCP Handler.
    *   *Output:* Hands off validated commands to the Command State Machine.
    *   *Functions:* `dispatchCommand(deviceId, action, payload)`
*   **State Machine:**
    ```mermaid
    stateDiagram-v2
        [*] --> Validating
        Validating --> RoutingAction : Valid
        Validating --> Rejected : Invalid
        RoutingAction --> Enqueued
        Enqueued --> [*]
    ```
*   **Crash Recovery:** None needed. In-flight requests will fail and must be retried by the client.
*   **Scalability:** Extracted easily; can run independently to offload validation.

##### 2. Command State Machine
*   **Business Logic / Responsibility:** Tracks the execution lifecycle of every single command in the system. It receives execution results directly via the synchronous HRPC response. If the connection drops or a response is delayed, it relies on the Scheduler to fetch the latest status via `state.pull` to ensure commands aren't hung.
    *   *Example:* Once the `reboot` command is dispatched, it transitions to `EXECUTING`. If the HRPC response returns OK, it transitions to `SUCCESS`. If the response hangs, the next `state.pull` fetches the true status from the worker.
*   **Interfaces:**
    *   *Input:* Receives validated commands from Dispatcher. Status updates from HRPC responses or Scheduler ticks.
    *   *Output:* Invokes worker HRPC execution layer; emits terminal state results to the caller.
    *   *Functions:* `enqueue(command)`, `syncState(commandId)`, `cancel(commandId)`
*   **State Machine:**
    ```mermaid
    stateDiagram-v2
        [*] --> QUEUED
        QUEUED --> DISPATCHED
        DISPATCHED --> EXECUTING : HRPC Sent
        EXECUTING --> SUCCESS : state.pull (response)
        EXECUTING --> FAILED : state.pull (error)
        EXECUTING --> TIMEOUT
        TIMEOUT --> QUEUED : Retry allowed
        TIMEOUT --> FAILED : Max retries
        SUCCESS --> [*]
        FAILED --> [*]
    ```
*   **Crash Recovery:** On startup, performs a recovery sweep of pending commands: `DISPATCHED` / `EXECUTING` are forced to `TIMEOUT` (re-queued if retries available); `QUEUED` are left untouched.
*   **Scalability:** Scaling requires state sharding (e.g., sharding by device/rack).

##### 3. Worker Registry
*   **Business Logic / Responsibility:** Acts as the phonebook for the entire ORK ecosystem. It maps which physical device IDs belong to which connected worker channels and stores their declared capabilities. 
    *   *Example:* A `whatsminer-worker` connects and declares it manages `wm001` and `wm002`. The Registry saves this topology so the Dispatcher knows exactly where to route a command for `wm001`.
*   **Interfaces:**
    *   *Input:* `identity.register` requests from workers.
    *   *Output:* Internal events triggering full state lifecycle binding.
    *   *Functions:* `resolveWorkerState(target)`
*   **State Machine:**
    ```mermaid
    stateDiagram-v2
        [*] --> Unregistered
        Unregistered --> Discovered : Worker Announces
        Discovered --> IdentitySaved : ORK pulls Identity
        IdentitySaved --> Ready : ORK pulls Capabilities
        Ready --> Terminated : eviction
        Terminated --> [*]
    ```
*   **Crash Recovery:** Rebuilt from state, which serves as a baseline to detect workers that were registered but failed to reconnect.
*   **Scalability:** Can be read-heavy and extracted into a read-replica architecture or partitioned by region/rack.

##### 4. Telemetry Collector
*   **Business Logic / Responsibility:** Acts as a lightweight proxy and routing layer between the upper system (UI/AI) and the downstream workers. Rather than ORK performing heavy time-series aggregations, the *Worker* is responsible for storing and aggregating data for the specific devices it controls. The ORK Collector simply provides an interface to query this data and proxies the response up to the UI (via App Node) or the AI Agent.
*   **Worker Data Handling (Telemetry Context):**
    *   **Compaction:** The worker handles the compaction of metrics over large time frames.
    *   **Local Storage:** It is recommended that workers save this telemetry data in a local hyper DB.
    *   **As-Requested Serving:** The worker serves the data strictly when ORK asks for it, precisely as dictated by the telemetry schemas in `mdk-contract.json`.
    *   **Internal Scheduling:** To achieve this without blocking ORK, the worker may run its own internal scheduler for internal device polling.
*   **Interfaces:**
    *   *Input:* Client or AI telemetry queries (e.g., "fetch metrics for device wm001").
    *   *Output:* Normalized telemetry payloads passed straight through from the Worker to the requesting layer.
    *   *Functions:* `proxyTelemetryFetch(deviceId, queryArgs)`
*   **State Machine:**
    ```mermaid
    stateDiagram-v2
        [*] --> Idle
        Idle --> Proxying : Request received from UI/AI
        Proxying --> RoutingToClient : Worker returns aggregated data
        Proxying --> Timeout : Worker unresponsive
        RoutingToClient --> Idle
    ```
*   **Scalability:** Because the heavy lifting of data storage and aggregation is pushed down into the isolated worker processes, the ORK Telemetry Collector remains stateless and highly scalable as a pure asynchronous router.

##### 5. Scheduler
*   **Business Logic / Responsibility:** The system metronome. It triggers repetitive tasks without holding any domain-specific logic itself.
    *   *Example:* Emits an internal `tick` event every 60 seconds which the Health Monitor listens to, prompting it to ping all workers.
*   **Interfaces:**
    *   *Input:* System clock and configured task intervals.
    *   *Output:* Injects intents (e.g., `telemetry.pull`, `health.ping`) into the Dispatcher/Collector.
    *   *Functions:* `addJob(interval, intent)`, `removeJob(jobId)`
*   **State Machine:**
    ```mermaid
    stateDiagram-v2
        [*] --> Waiting
        Waiting --> Triggered : Interval Elapsed
        Triggered --> Waiting
    ```
*   **Crash Recovery:** Timers re-initialize from zero on startup. Tasks are strictly idempotent.
*   **Scalability:** Scales trivially. Requires basic distributed locking to avoid duplicate ticks in multi-process ORK deployments.

##### 6. Health Monitor
*   **Business Logic / Responsibility:** Continuously evaluates the liveness and readiness of every registered worker to prevent routing messages to dead nodes.
    *   *Example:* If the `health.ping` to a worker fails three times in a row, the Health Monitor marks the worker's status as `SICK` and tells the Registry to halt routing new commands there.
*   **Interfaces:**
    *   *Input:* Executes `health.ping` sequentially based on Scheduler ticks.
    *   *Output:* Pushes status updates to the Registry; escalates to Fault Supervisor if a worker dies.
    *   *Functions:* `pingWorker(workerId)`, `getHealth(workerId)`
*   **State Machine:**
    ```mermaid
    stateDiagram-v2
        [*] --> UNKNOWN
        UNKNOWN --> HEALTHY : Ping Success
        HEALTHY --> SICK : Ping Failed (1)
        SICK --> DEAD : Ping Failed (Threshold)
        SICK --> HEALTHY : Ping Success
        DEAD --> HEALTHY : Reconnected
    ```
*   **Crash Recovery:** Blank slate on startup; re-evaluates all known workers immediately via ping.
*   **Scalability:** Operates locally per ORK kernel or via independent lightweight ping agents.

##### 7. Fault Supervisor *(Deferred for v1)*
*   **Idea:** Implements circuit-breaker patterns to protect the overall system from cascading failures caused by bad hardware or software bugs (e.g., rejecting commands during a cooling period upon repeated errors).
*   **Status:** For the first cut, to keep the core orchestrator simple, we are going to skip the dedicated Fault Supervisor. Later on, if the use-case arises (such as complex retry backoffs or cluster destabilization), we will reintroduce it.

##### 8. Concurrency Manager *(Deferred for v1)*
*   **Idea:** Provides guaranteed lock management and queue limits to ensure mutually exclusive commands do not overlap on physical devices.
*   **Status:** For the first cut, to keep the system simple, we are skipping the centralized Concurrency Manager module and relying solely on the basic command queue. Later on, if the use-case arises for explicit global locks or backpressure limits, we will build out this module.

#### 4.3.2 System Recovery Overview

On a full system crash and restart, ORK modules orchestrate recovery without user intervention:
1. **Registry:** Loads last known worker and device states from Hyperbee.
2. **State Machine:** Sweeps the WAL for stranded `EXECUTING` tasks and forces them to timeout/retry.
3. **Health Monitor:** Begins firing immediate pings to verify which workers are still active.
4. **Connections:** Network layer awaits incoming HRPC reconnect storms from persistent workers.

### 4.4 Workers — Device Integration Handlers

**Responsibility:** Wraps device library and exposes via MDK protocol

- **Announce Only:** The *only* operations proactively initiated by a worker towards static channel are `announce`
- **Pull-Based Registration:** Upon hearing an announcement, ORK takes control and sequentially pulls the worker's identity (`identity.request`) and its capability schema (`capability.request`). This ensures ORK acts as the true orchestrator and protects it from incoming registration floods.

##### `capability.response` & Unified Contract Schema (`mdk-contract.json`)

When ORK requests capabilities, the payload is built via the direct application of the device's `mdk-contract.json`. 

The `mdk-contract.json` is the canonical source of truth for the worker's programmatic capabilities and AI context. MDK deliberately merges formal validations and semantic AI guidelines into this single JSON contract.

- **Unified Intelligence:** Prompt-injections (like thermal safety warnings) are woven organically into standard machine fields rather than isolated in separate documents.
  - `description` handles both human UI labeling and AI edge-case rules (e.g., *"Outlet temperature > 85C requires intervention"*).
  - `constraints` inherently governs orchestration limits.
  - `troubleshooting` provides if/then recovery behaviors directly alongside the payload it evaluates.

*The exhaustive JSON Validation Schema detailing exactly how this contract must be built currently exists at:* **[`mdk-worker-base/mdk-contract.schema.json`](../mdk-worker-base/mdk-contract.schema.json)**

- **Strict Top-Down Pull:** For all operational functions and telemetry loops, workers wait for ORK to pull data or issue commands downwards. Telemetry is never pushed.
- **Generic Interface Mapping:** Actions are processed using a generic MDK Protocol format, translating from the strict JSON Schema boundaries into specific hardware signals.
- **Base Command Contract:** Every worker must support a minimum baseline set of commands (e.g., `getConfig`, `setConfig`, `health`) regardless of device type, as documented in 3.5.
- **Capability Declaration (`mdk-contract.json`):** Declares capabilities via `mdk-contract.json` — a single JSON file that drives ORK command validation, MCP tool generation, and UI data binding simultaneously.
- **Subclassing `@mdk/worker-base`:** Built by subclassing `@mdk/worker-base` and implementing two methods: `onTelemetryPull` and `onCommand` — all HRPC plumbing is inherited.
- **Source of Truth:** ORK treats the Worker as the unyielding Source of Truth for the hardware; ORK itself operates purely as a synchronized state machine or cache of that truth.

### 4.5 `@mdk/client` SDK — The Universal Interface

The `@mdk/client` SDK is the transport abstraction layer used to connect to ORK's gateways safely and reliably. It provides the essential glue between ORK and whatever consumer layer developers choose to build on top.

**Responsibility:** Connects the MDK Protocol over native transports (HRPC or IPC) seamlessly.

- **Transport Abstraction:** It handles MDK Protocol message construction, auth token validation wrapping, and reconnection logic with exponential backoff.
- **Transport Auto-Selection:** The SDK auto-selects the transport mechanism based entirely on the URL scheme provided by the developer:
  - `hrpc://` connects over encrypted Hyperswarm streams for remote server-to-server production.
  - `ipc://` connects via direct local sockets for extremely low-latency local testing.
- **Un-opinionated Framework:** Developers import the client inside their preferred language and framework (Node.js, Python, Go, etc.) to dispatch commands, subscribe to live streams, or pull status snapshots.

---

## 5. Data Flow — End-to-End Examples

### Scenario A: Human UI via App Node
**Scenario:** User clicks "Reboot" on device `wm001` in the UI.

```mermaid
sequenceDiagram
    actor User
    participant UI as React UI
    participant Node as App Node
    participant ORK as ORK
    participant Worker as Generic Worker

    User->>UI: Click "Reboot" on wm001
    UI->>Node: POST / { deviceId: "wm001", action: "reboot", payload: {...} }

    rect rgb(40, 50, 70)
    Note over Node,ORK: Delegation
    Node->>ORK: dispatch generic protocol message
    ORK->>ORK: Verify against generic capabilities ✓
    ORK->>ORK: Resolve worker for deviceId (local index lookup) ✓
    end

    rect rgb(40, 60, 50)
    Note over ORK,Worker: execution
    ORK->>Worker: command.request (HRPC, routed by deviceId)
    Worker-->>ORK: Ack start
    Worker->>Worker: Hardware specific translation
    Worker-->>ORK: command.result
    end

    ORK-->>Node: result OK
    Node-->>UI: HTTP 200

    rect rgb(50, 50, 40)
    Note over Worker,ORK: State reflection
    ORK->>Worker: telemetry.pull (tick)
    Worker-->>ORK: Updated status (rebooting)
    end
```

### Scenario B: AI Agent via App Node MCP
**Scenario:** User prompts AI Agent: "Are there any miners overheating? If so, reboot them."

```mermaid
sequenceDiagram
    actor User
    participant AI as AI Agent (Claude)
    participant Node as App Node (MCP)
    participant ORK as ORK
    participant Worker as Generic Worker

    User->>AI: "Are there any miners overheating? If so, reboot them."
    
    rect rgb(70, 50, 40)
    Note over AI,ORK: Step 1: Fleet Discovery (Read)
    AI->>Node: Call MCP tool `get_fleet_alerts` (Token Auth)
    Node->>Node: Validate Agent Token & RBAC
    Node->>ORK: HRPC Query (via @mdk/client)
    ORK-->>Node: [Metrics]
    Node-->>AI: Tool Result (wm002 is overheating)
    end
    
    rect rgb(40, 50, 70)
    Note over AI,ORK: Step 2: Execution (Write)
    AI->>Node: Call MCP tool `reboot_device` (deviceId: wm002)
    Node->>Node: Validate Agent Token & 'device:write' RBAC
    Node->>ORK: dispatch generic protocol message
    ORK->>ORK: Resolve deviceId ✓
    ORK->>Worker: command.request (HRPC)
    Worker-->>ORK: command.result
    ORK-->>Node: result OK
    Node-->>AI: Tool Result (Success)
    end
    
    AI-->>User: "wm002 was overheating and has been rebooted."
```

---

## 6. External Integration Model

To build extensibility that is genuinely straightforward, MDK defines a **strict Device-Lib Contract**. External developers integrate new hardware by building a generic worker package conforming to this template.

### 6.1 The Device-Lib Template

A canonical device-lib worker package must follow this standard structure:

```text
@acme-corp/mdk-worker-acmeminer
├── src/
│   ├── index.js             ← Main HRPC worker entrypoint
│   ├── hardware.js          ← Hardware integration & protocol logic (REST/SSH/etc.)
│   └── mapping.js           ← Maps hardware responses to MDK schema
├── test/
│   ├── worker.spec.js       ← Unit tests for capability declarations & mapping
│   └── hardware.mock.js     ← Mock hardware responses
├── mdk-contract.json        ← Canonical capability schema (with embedded semantics)
└── package.json
```

### 6.2 Integration Workflow
1. Integrator references `mdk-contract.schema.json` to author the `mdk-contract.json`, validating strict data schemas while injecting explanations, constraints, and troubleshooting directly into the relevant nodes.
2. Integrator implements the `src/hardware.js` translation logic.
3. The worker instance boots, binds connects `devices`, and announces its presence on the static channel. ORK then pulls its identity and capabilities (see §3.3 and §4.4).

---

## 7. Scaling Model

As MDK deployments scale to large mining sites (e.g., 5,000+ devices), the system must explicitly manage parallel workers and parallel ORK instances. ORK is strictly an execution kernel; it does not perform application-level aggregation or cross-regional business logic.

### 7.1 Routing and Ownership (Parallel Workers)

**Scenario:** Multiple workers of the same type (e.g., `whatsminer-worker`) are active concurrently and connected to the same ORK kernel.

```mermaid
flowchart TD
    ORK[Single ORK Kernel]
    W1[Worker 1]
    W2[Worker 2]
    D1[Devices wm001 to wm500]
    D2[Devices wm501 to wm999]
    
    ORK -->|Routes cmds| W1
    ORK -->|Routes cmds| W2
    W1 --- D1
    W2 --- D2
```

**Device-Level Routing & Ownership:** Workers never share devices. When a worker connects, its `identity.register` payload explicitly lists the `deviceId`s it exclusively manages. ORK's `Worker Registry` maintains this strict mapping and deterministically routes arriving commands to the designated worker.

### 7.2 Multi-Site Centralization (Parallel ORKs)

**Scenario:** A deployment requires managing multiple massive physical boundaries (e.g., a Texas Site and an Iceland Site). Each location runs its own dedicated site-level ORK kernel, but all are overseen globally by a **single App Node and/or AI Agent**.

#### Architecture Flow

```mermaid
flowchart TD
    Global[Global App Node / AI Agent]
    
    Global <-->|MDK Protocol via HRPC| ORK_TX[Texas ORK]
    Global <-->|MDK Protocol via HRPC| ORK_IC[Iceland ORK]
    
    ORK_TX -->|Routes| W1_TX[Whatsminer Worker]
    ORK_TX -->|Routes| W2_TX[Antminer Worker]
    
    ORK_IC -->|Routes| W1_IC[Whatsminer Worker]
    ORK_IC -->|Routes| W2_IC[Avalon Worker]
    
    W1_TX --- D1_TX[Whatsminers]
    W2_TX --- D2_TX[Antminers]
    
    W1_IC --- D1_IC[Whatsminers]
    W2_IC --- D2_IC[Avalons]
```

The single App Node and AI Agent connect globally to all distributed ORK kernels via the native HRPC mesh (`Hyperswarm`). Parallel ORK instances remain entirely isolated from one another — they do not federate registries, share queues, or synchronize state. A crash at one site has zero impact on any other.

> **Cross-Site Aggregation:** Refer MDK App [hld-mdk-app.md](./hld-mdk-app.md) (To be finalized)

---

## 8. Extensibility & Business Logic Plugins

### 8.1 Plugin & Community Requirements
As MDK scales toward AI-driven autonomous farms, we want to empower the community to build domain-specific applications without needing deep knowledge of the MDK core.
1. **Community-Driven Business Logic:** MDK must provide a seamless extension point for third-party developers and the community to build custom dashboards, aggregate fleet telemetry, and implement domain-specific business logic.
2. **Plug & Play Architecture:** Adding a new device type or a custom business service must be plug-and-play, never requiring code changes from the core MDK team.

### 8.2 Proposed Solutions

#### 8.2.1 MDK Apps (The Extension Point)
To resolve the rigid coupling of App Node routes and keep ORK as a pure kernel, extensible business logic is elevated to the **MDK Apps** layer.

> **Read the Full Spec:** Refer to the **[MDK App High-Level Design](./hld-mdk-app.md)** for exhaustive details on this architecture.

MDK Apps act as the overarching "Plugin System" on top of the generic MDK foundation, effectively splitting the stack:
- **MDK Core (Infrastructure):** Delivers the standard MDK protocol, the HRPC mesh, the ORK execution kernel, and a generic App Node & App UI.
- **MDK Apps (Developer-built Plugins):** External integrators package an *MDK-App Server* (which registers its domain-specific REST/WS routes dynamically onto the App Node extension hooks), and an *MDK-App Widget* (which renders inside the MDK UI Shell).

When a third party connects a new device family (e.g., `acmeminer`), they ship a complete MDK Apps package along with a Device Worker. It dynamically mounts its routes and UI upon boot, ensuring **zero core team involvement** for all future platform extensions.
 
---

## 9. Next Steps

We will begin active development on the core platform to make MDK **AI-ready** immediately.

- **Core Infrastructure Priority**: We will be doing all the work to build the foundational MDK pieces right away:
  - ORK
  - Workers
  - MCP
  - Protocol
- **MDK Apps Deferred**: We will omit the MDK Apps part for now. We will come back to build the MDK Apps and extension points after the rest of the things are ready.


