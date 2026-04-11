# MDK App — High-Level Design

## 1. Purpose & Context

This document defines the **MDK App** layer — the developer-facing application framework that sits on top of the MDK infrastructure stack.

The MDK backend (`mdk-be`) is intentionally generic. It provides the protocol, routing, and hardware integration plumbing, but it deliberately ships **no business logic**. The **MDK App** is the structured extension point where product-specific logic lives.

A developer building a mining dashboard, energy management system, or any hardware-facing application only needs to build:

1. **MDK App Plugin** — Business logic, aggregation, and ORK interfacing.
2. **MDK App Widget** — Domain-specific UI built using the MDK UI Kit.

Everything else (ORK, Workers, MDK UI shell, App Node infrastructure) is provided by MDK as a pre-built, pre-wired foundation.

---

## 2. Design Rationale

> *MDK should be a platform, not a product.* The framework ships an "empty box" pre-equipped with standard infrastructure — auth, ORK communication, frontend/agent communication channels, and extension points. Developers fill the box.

This model prevents two common failure modes:

- **Pushing business logic into ORK:** ORK must remain a pure kernel — routing, concurrency, lifecycle. The moment product-specific aggregation logic bleeds into ORK, the kernel becomes tightly coupled to one application.
- **Forcing developers to rebuild aggregation layers:** Without a blessed extension point in the Node layer, every developer reinvents HTTP wrappers, ORK connectors, and auth middleware. The MDK App layer absorbs this complexity once, generically.

---

## 3. Full Stack Overview

#### Diagram 1 — MDK App Layer

```mermaid
flowchart TD
    UIKIT[MDK UI Kit]

    subgraph MDK App
        direction TB
        WIDGET[MDK App Widget]
        PLUGIN[MDK App Plugin]
        WIDGET -.- |paired| PLUGIN
    end

    UIKIT -->|uses| WIDGET
    UIKIT -->|uses| MDKUI[MDK UI]

    WIDGET -->|registers| MDKUI
    MDKUI -->|calls| APPNODE[App Node]

    PLUGIN -->|registers| APPNODE
    PLUGIN -->|reads data| ORK[ORK ...]
    APPNODE -->|read/write| ORK
```


The dashed **MDK App** boundary is what the developer owns and ships. Everything outside it is generic MDK infrastructure.

---

## 4. Layer Definitions

### 4.1 MDK UI Kit *(Provided by MDK)*

A component library and design system that all MDK-compatible frontends consume. It provides standard UI primitives but intentionally contains no application-specific logic.

### 4.2 MDK UI *(Provided by MDK — Extension Point)*

The generic MDK shell application — a thin, pre-built frontend that connects to the App Node. It uses the MDK UI Kit and is ready to use out of the box. Suitable for loading MDK App Widgets for business logic.

### 4.3 MDK App Widget *(Developer-Built)*

A custom UI component built by the developer using the **MDK UI Kit**. This is where domain-specific screens, dashboards, and interaction flows are implemented.

It registers itself with the **MDK UI** to render its view inside the shell, driven by data served from a paired **MDK App Plugin**.

### 4.4 App Node *(Provided by MDK — Extension Point)*

The app-facing API layer provided by MDK. It is pre-wired with:

- **Authentication & Authorization [TBD]** — token validation, session management.
- **ORK Communication** — HRPC session management to one or more ORK instances.
- **Frontend APIs** — HTTP/WebSocket endpoints for the MDK UI.
- **Extension Points** — clearly defined hooks where the developer's **MDK App Plugin** registers business logic handlers.

The App Node ships as an "empty box" — structurally complete, but containing no application-specific routes or aggregation by default.

### 4.5 MDK App Plugin *(Developer-Built)*

The business logic core of the developer's application. It plugs into the App Node extension points and implements:

- **Cross-ORK data aggregation** — pulling telemetry from multiple ORK instances and computing application-level metrics (e.g., site-wide hashrate, fleet-level efficiency).
- **Business rules** — alert thresholds, rebalancing strategies, SLA enforcement.
- **Custom API routes** — domain-specific endpoints exposed through the App Node to the UI or agents.
- **Scheduler logic** — periodic tasks like reporting, anomaly detection, or predictive maintenance triggers.

It reads data directly from ORK instances and writes commands back through the App Node's dispatch interface.

#### Registration & Route Loading

The MDK App Plugin **registers itself** with the App Node on startup, declaring the routes it owns. Each registered route serves data that is consumed by a paired **MDK App Widget**. The route configuration is the binding contract between the plugin logic and the widget — the Widget is configured with the matching route, and the App Node ensures the data is wired through automatically.

This means:
- The Plugin declares `POST /mining/stats` → serves aggregated fleet data.
- The MDK App Widget is configured with `/mining/stats` as its data source.
- The MDK UI loads the Widget and the data flows end-to-end without any custom glue code.

### 4.6 ORK *(Provided by MDK)*

The hardware orchestration kernel. Manages routing, worker lifecycle, command dispatch, and telemetry collection. Entirely generic — has no awareness of the application built on top.

See [`hld.md`](./hld.md) for the full ORK specification.

### 4.7 Workers *(Device-Specific — Provided by MDK / Community)*

Runtime hardware integration modules. Each worker implements the `mdk-contract.json` for a specific device family.

---

## 5. Developer Responsibilities

Under this model, a developer building a mining application needs to provide:

| Component | Owner | What to build |
|---|---|---|
| MDK App Widget | Developer | Domain-specific dashboards, screens, UX flows using MDK UI Kit |
| MDK App Plugin | Developer | Business logic, aggregation, custom API routes, schedulers |
| MDK UI Kit | MDK (provided) | — |
| MDK UI | MDK (provided) | — |
| App Node | MDK (provided) | Register routes and logic via extension hooks only |
| ORK | MDK (provided) | — |
| Workers | MDK / Community | Implement `mdk-contract.json` for new device types only |

---

## 6. Extension Points (App Node & MDK UI Hooks)

The binding between the MDK App Plugin and the MDK App Widget is defined via a simple route-based contract:

| Step | Who | Action |
|---|---|---|
| 1 | MDK App Plugin | Registers itself with App Node, declaring its routes |
| 2 | App Node | Mounts the declared routes into its API surface |
| 3 | MDK UI | Loads the MDK App Widget at its registered path |
| 4 | MDK App Widget | Calls its configured route to fetch data from the Plugin |
| 5 | App Node | Proxies the request to the Plugin, which queries ORK and returns results |

The specific registration API (e.g., how routes are declared, how the Widget manifest is registered) is to be defined during the App Node implementation phase.

---

## 7. AI Agent Integration

An AI Agent communicates with the MDK stack via **two distinct paths**, depending on the nature of the request:

### Path A — Business Logic & Aggregated Data (via App Node)

For high-level queries — fleet-level metrics, business summaries, cross-site aggregations — the AI agent calls the **App Node**, exactly as the MDK UI does. The App Node exposes an **MCP-compatible tool interface** alongside its HTTP API, allowing AI agents to discover and call registered Plugin routes as named tools.

```mermaid
flowchart LR
    AI[AI Agent]
    AI -->|MCP Tool Call| AppNode[App Node]
    AppNode -->|Calls| Plugin[MDK App Plugin]
    Plugin -->|Queries| ORK[ORK]
```

This path gives the AI access to **business-level context** — the same aggregated, meaningful data the Widget displays. The MDK App Plugin's registered routes automatically become AI-callable tools via the MCP layer.

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
| "What is the fleet hashrate?" | Path A | App Node → Plugin → ORK |
| "Reboot device wm042" | Path B | ORK → Worker → Hardware |
| "Show devices with temp > 80°C" | Path A | App Node → Plugin → ORK |
| "Fetch raw telemetry for wm001" | Path B | ORK → Worker |

> **AI Agent integration via MCP (Model Context Protocol)** is the recommended interface for Path A. The exact MCP tool schema and discovery mechanism is to be defined during the App Node implementation phase.
