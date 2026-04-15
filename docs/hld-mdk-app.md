# MDK-App — High-Level Design

The fundamental ideology of the platform consists of three pillars: **MDK Core**, **MDK Apps**, and the **MDK Protocol**.

```mermaid
flowchart TD
    subgraph "MDK Platform"
        direction TB
        MDK_APP["MDK Apps<br/>(The Extension Point)"]
        MDK_CORE["MDK Core<br/>(Foundation & Infrastructure)"]
        
        MDK_APP -->|Communicates via<br/>MDK Protocol| MDK_CORE
    end
    
    style MDK_APP fill:#e1f5fe,stroke:#03a9f4,stroke-width:2px,color:#000
    style MDK_CORE fill:#f5f5f5,stroke:#9e9e9e,stroke-width:2px,color:#000
```

## 1. Purpose & Context

This document defines the **MDK-App** layer. While MDK Core provides the generic foundation, **MDK Apps** serves as the explicitly defined extension point for developers. It is the application framework that sits on top of the MDK-Core stack.

The MDK-Core is intentionally generic. It provides the protocol, routing, and hardware integration plumbing, but it deliberately ships **no business logic**. The **MDK-App** is the structured extension point where product-specific logic lives.

A developer building a mining dashboard, energy management system, or any hardware-facing application only needs to build:

1. **MDK-App Server** — Business logic, aggregation, and ORK interfacing.
2. **MDK-App Widget** — Domain-specific UI built using the `MDK-Core UI Kit`.

Everything else (ORK, Workers, MDK-Core UI shell, App Node infrastructure) is provided by MDK-Core as a pre-built, pre-wired foundation.

---

## 2. Design Rationale

> *MDK should be a platform, not a product.* The framework ships an "empty box" pre-equipped with standard infrastructure — auth, ORK communication, frontend/agent communication channels, and extension points. Developers fill the box.

This model prevents two common failure modes:

- **Pushing business logic into ORK:** ORK must remain a pure kernel — routing, concurrency, lifecycle. The moment product-specific aggregation logic bleeds into ORK, the kernel becomes tightly coupled to one application.
- **Forcing developers to rebuild aggregation layers:** Without a blessed extension point in the Node layer, every developer reinvents HTTP wrappers, ORK connectors, and auth middleware. The MDK-App layer absorbs this complexity once, generically.

---

## 3. Full Stack Overview

#### Diagram 1 — Simple Flow

```mermaid
graph LR
    APPS["MDK Apps 
    (Developer-Built: MDK-App Server + MDK-App Widget)"] -- MDK Protocol --> CORE["MDK Core 
    (MDK-Provided: App Node + ORK + UI)"]
    CORE -->|manages| HW["Hardware 
    (via Workers)"]
```

#### Diagram 2 — Component Internals

```mermaid
flowchart TD
    UIKIT["MDK UI Kit 
    (MDK Core)"]

    subgraph DEV_SCOPE["MDK Apps (Developer-Built)"]
        direction TB
        APPWIDGET["MDK-App Widget"]
        APPSVR["MDK-App Server"]
        APPWIDGET -.- |paired| APPSVR
    end

    UIKIT -->|uses| APPWIDGET
    UIKIT -->|uses| MDKUI["MDK UI 
    (MDK Core)"]

    APPWIDGET -->|registers| MDKUI
    MDKUI -->|calls| APPNODE["App Node 
    (MDK Core)"]

    APPSVR -->|registers| APPNODE
    APPSVR -->|reads data via MDK Protocol| ORK["ORK Kernel 
    (MDK Core)"]
    APPNODE -->|read/write via MDK Protocol| ORK
```

The dashed **MDK Apps** boundary represents what the developer owns and ships. Everything outside it is **MDK Core** generic infrastructure communicating via the **MDK Protocol**.

---

## 4. Layer Definitions

### 4.1 MDK UI Kit *(MDK Core)*

A component library and design system that all MDK-compatible frontends consume. It provides standard UI primitives but intentionally contains no application-specific logic.

### 4.2 MDK UI *(MDK Core — Extension Point)*

The generic MDK shell application — a thin, pre-built frontend that connects to the App Node. It uses the MDK UI Kit and is ready to use out of the box. Suitable for loading MDK-App Widgets for business logic.

### 4.3 MDK-App Widget *(MDK Apps: Developer-Built)*

A custom UI component built by the developer using the **MDK UI Kit**. This is where domain-specific screens, dashboards, and interaction flows are implemented.

It registers itself with the **MDK UI** to render its view inside the shell, driven by data served from a paired **MDK-App Server**.

### 4.4 App Node *(MDK Core — Extension Point)*

The app-facing API layer provided by MDK. It is pre-wired with:

- **Authentication & Authorization [TBD]** — token validation, session management.
- **ORK Communication** — MDK Protocol session management via HRPC to one or more ORK instances.
- **Frontend APIs** — HTTP/WebSocket endpoints for the MDK UI.
- **Extension Points** — clearly defined hooks where the developer's **MDK-App Server** registers business logic handlers.

The App Node ships as an "MDK Core empty box" — structurally complete, but containing no application-specific routes or aggregation by default.

### 4.5 MDK-App Server *(MDK Apps: Developer-Built)*

The business logic core of the developer's application. It plugs into the App Node extension points and implements:

- **Cross-ORK data aggregation** — pulling telemetry from multiple ORK instances and computing application-level metrics (e.g., site-wide hashrate, fleet-level efficiency).
- **Business rules** — alert thresholds, rebalancing strategies, SLA enforcement.
- **Custom API routes** — domain-specific endpoints exposed through the App Node to the UI or agents.
- **Scheduler logic** — periodic tasks like reporting, anomaly detection, or predictive maintenance triggers.

It reads data directly from ORK instances via the MDK Protocol and writes commands back through the App Node's dispatch interface.

#### Registration & Route Loading

The MDK-App Server **registers itself** with the App Node on startup, declaring the routes it owns. Each registered route serves data that is consumed by a paired **MDK-App Widget**. The route configuration is the binding contract between the MDK-App Server logic and the MDK-App Widget — the MDK-App Widget is configured with the matching route, and the App Node ensures the data is wired through automatically.

This means:
- The MDK-App Server declares `POST /mining/stats` → serves aggregated fleet data.
- The MDK-App Widget is configured with `/mining/stats` as its data source.
- The MDK UI loads the MDK-App Widget and the data flows end-to-end without any custom glue code.

### 4.6 ORK *(MDK Core)*

The hardware orchestration kernel. Manages routing, worker lifecycle, command dispatch, and telemetry collection. Entirely generic — has no awareness of the application built on top.

See [`hld.md`](./hld.md) for the full ORK specification.

### 4.7 Workers *(MDK Core / Community / Developer-Built)*

Runtime hardware integration modules. Each worker implements the `mdk-contract.json` for a specific device family. MDK ships a **Worker Base Class** containing all protocol boilerplate; the developer only implements hardware translation.

### 4.8 MDK Protocol *(MDK Platform Glue)*

The universal communication language of the MDK Platform. It strongly types and standardizes all data exchange between the MDK Core infrastructure (ORK, App Node, Workers) and the MDK Apps (MDK-App Server).

---

## 5. Developer Responsibilities

Under this model, a developer building a mining application needs to provide:

| Component | Owner | What to build |
|---|---|---|
| MDK-App Widget | **MDK Apps (Developer-Built)** | Domain-specific dashboards, screens, UX flows using MDK UI Kit |
| MDK-App Server | **MDK Apps (Developer-Built)** | Business logic, aggregation, custom API routes, schedulers |
| MDK Protocol| **MDK Platform Standard** | Standard communication definitions and schemas |
| MDK UI Kit | MDK Core | — |
| MDK UI | MDK Core (Extension Point) | — |
| App Node | MDK Core (Extension Point) | Register routes and logic via extension hooks only |
| ORK | MDK Core | — |
| Device Workers | **Developer-Built / Community** | Implement `mdk-contract.json` for new device types only |

---

## 6. Extension Points (App Node & MDK UI Hooks)

The binding between the MDK-App Server and the MDK-App Widget is defined via a simple route-based contract:

| Step | Who | Action |
|---|---|---|
| 1 | MDK-App Server | Registers itself with App Node, declaring its routes |
| 2 | App Node | Mounts the declared routes into its API surface |
| 3 | MDK UI | Loads the MDK-App Widget at its registered path |
| 4 | MDK-App Widget | Calls its configured route to fetch data from the MDK-App Server |
| 5 | App Node | Proxies the request to the MDK-App Server, which queries ORK and returns results |

The specific registration API (e.g., how routes are declared, how the MDK-App Widget manifest is registered) is to be defined during the App Node implementation phase.

---

## 7. AI Agent Integration

An AI Agent communicates with the MDK stack via **two distinct paths**, depending on the nature of the request:

### Path A — Business Logic & Aggregated Data (via App Node)

For high-level queries — fleet-level metrics, business summaries, cross-site aggregations — the AI agent calls the **App Node**, exactly as the MDK UI does. The App Node exposes an **MCP-compatible tool interface** alongside its HTTP API, allowing AI agents to discover and call registered MDK-App Server routes as named tools.

```mermaid
flowchart LR
    AI[AI Agent]
    AI -->|MCP Tool Call| AppNode[App Node]
    AppNode -->|Calls| AppServer[MDK-App Server]
    AppServer -->|Queries| ORK[ORK]
```

This path gives the AI access to **business-level context** — the same aggregated, meaningful data the MDK-App Widget displays. The MDK-App Server's registered routes automatically become AI-callable tools via the MCP layer.

### Path B — Low-Level Hardware Commands (via ORK directly)

For direct hardware operations — rebooting a specific device, fetching raw telemetry, issuing a config change — the AI agent connects **directly to ORK** via the MDK Protocol over HRPC. This bypasses the App layer entirely and operates at the hardware kernel level.

```mermaid
flowchart LR
    AI[AI Agent]
    AI -->|MDK Protocol via HRPC| ORK[ORK]
    ORK -->|command.request| Worker[Worker]
    Worker -->|Hardware| Device[Device]
```

This path gives the AI direct, low-latency access to the hardware control plane — the same interface ORK exposes to any MDK-protocol-compatible consumer.

### Summary

| Use Case | Path | Entry Point |
|---|---|---|
| "What is the fleet hashrate?" | Path A | App Node → MDK-App Server → ORK |
| "Reboot device wm042" | Path B | ORK → Worker → Hardware |
| "Show devices with temp > 80°C" | Path A | App Node → MDK-App Server → ORK |
| "Fetch raw telemetry for wm001" | Path B | ORK → Worker |

> **AI Agent integration via MCP (Model Context Protocol)** is the recommended interface for Path A. The exact MCP tool schema and discovery mechanism is to be defined during the App Node implementation phase.
