# MDK App Toolkit — High-Level Design

> **Version:** 0.2.0 &nbsp;|&nbsp; **Date:** 2026-04-18 &nbsp;|&nbsp; **Status:** In Review

> **The MDK App Toolkit** is an open-source, reusable package consisting of UI primitives, framework adapters, and a plug-and-play architecture for building applications on top of the MDK.

While the core MDK orchestration engine (ORK) is entirely un-opinionated and generic (see [`hld.md`](./hld.md)), the **MDK App Toolkit** provides a "batteries-included" application layer. 

It is designed to be extracted as a reusable open-source package that developers can plug into their own Node.js + Fastify + React stacks (leveraging the low-level **`@tetherto/mdk-client`** for ORK connectivity) to get a dashboard running immediately.

## 1. Problem Statement & Motivation

Building an application on top of hardware infrastructure historically forces developers to face three massive friction points:

1. **The Repeated Logic Problem:** Every frontend developer integrating with backend APIs ends up reinventing the exact same boilerplate: throttling fast-moving telemetry streams, managing optimistic UI state transitions, and detecting silent communication timeouts. 

2. **The UI Rigidity Trap:** Platforms try to solve Problem #1 by shipping a "UI component library." However, UI is inherently subjective. When external developers are forced to use generic components, they inevitably get locked out of customizing the CSS to match their brand, leading to abandoned toolkits and identical dashboards.

3. **The Extension Bottleneck:** If an external manufacturer builds a brand new miner/device, how do they inject a custom "Dashboard Widget" and "Custom Aggregator" into an existing MDK deployment? 

### 1.1 The Solution: A Layered Toolkit

The MDK App Toolkit solves these problems by decoupling logic from styling, and providing an explicit plug-and-play extension architecture:

1. It extracts all complex API state and caching logic (e.g., handling server disconnects and buffering data from the App Node Gateway) into a purely **Headless Layer** (`@tetherto/mdk-ui-core`).

2. It embraces the *shadcn/ui* pattern by providing reference UI components that developers can copy and paste, giving them full control over CSS and layout while still leveraging the underlying data hooks. Alternatively, it can also be installed via NPM.

3. It provides the **MDK-App Plugin Architecture** — an out-of-the-box, extensible shell framework where 3rd-party frontend widgets and backend routes can be injected dynamically at runtime.


## 2. The Frontend Toolkit (`@tetherto/mdk-ui-core` & Adapters)

Rather than enforcing a monolithic UI framework, the frontend toolkit decomposes the UI SDK into three distinct layers, ensuring that business logic is never reinvented while leaving UI styling entirely under developer control.

### 2.1 Headless Core (`@tetherto/mdk-ui-core`)
The headless brain connects to the developer's **App Node API**. It manages stateful logic that every UI needs but renders nothing.


- **Subscriptions:** Buffers rapid backend telemetry streams (e.g., max 2 renders/sec).
- **Stale Detection:** Emits stale events if the connection drops for 30s.
- **History:** Maintains an internal ring buffer tailored for sparkline charts.
- **Optimistic UI:** Manages command states (`pending`, `confirmed`, `failed`, `timeout`) locally before the server responds.

> **Why headless:** The same subscription logic needs to work in React, Vue, Svelte, and plain JS. By keeping the core framework-agnostic, all framework adapters share the same battle-tested implementation. A bug fix in stale detection benefits every framework simultaneously.


### 2.2 Framework Adapters
The `@tetherto/mdk-ui-core` generates raw JavaScript state objects, which do not automatically trigger UI re-renders. To bridge this gap, the toolkit provides thin framework adapters that seamlessly translate the headless state machine into framework-native reactive lifecycles (e.g., React `useState`, Vue `ref`, Svelte stores). 

By calling standardized hooks like `useTelemetry(deviceId)` or `useCommand`, a UI component automatically receives perfectly buffered, reactive data, without the developer ever touching the underlying connection or state manager.

**Available Adapters:** `@tetherto/mdk-react-adapter`, `@tetherto/mdk-vue`, `@tetherto/mdk-svelte`, `@tetherto/mdk-wc` (Web Components).

### 2.3 Reference UI

The toolkit optionally ships styled reference components (e.g., `<DeviceTile />`). Developers own the styling completely, with **no Tailwind dependency** required in the host application.

#### 2.3.1 `@tetherto/mdk-react-devkit`
For React, **`@tetherto/mdk-react-devkit`** — a production-tested component library available as a standard NPM package. Key highlights:
- Production-tested MDK-specific components (e.g., `<DeviceTile />`, `<TelemetryChart />`, `<CommandButton />`)
- Built on React 19 + Radix UI primitives; ships pre-compiled CSS
- Zero CSS-in-JS runtime overhead — host app does not need Tailwind

UI kits for other frameworks (Vue, Svelte, etc.) may be built in the future as demand arises.

#### 2.3.2 CSS Customization Model

All `@tetherto/mdk-react-devkit` components support **three progressive levels** of style override, so developers can customize as much or as little as needed:

**Level 1 — Global Theme (CSS Custom Properties)**

All visual design tokens are exposed as CSS Custom Properties. Overriding your brand colors or spacing globally is a one-liner:

```css
/* In your app's global CSS */
:root {
  --mdk-color-primary: #7c3aed;
  --mdk-color-danger:  #dc2626;
  --mdk-radius-tile:   12px;
  --mdk-font-mono:     'JetBrains Mono', monospace;
}
```

**Level 2 — Per-Instance Override (`className` prop)**

Every component accepts a standard `className` prop merged onto its root element. Use your own CSS class or inline CSS Modules:

```tsx
// Your CSS: .my-tile { border: 2px solid gold; }
<DeviceTile deviceId="wm001" className="my-tile" />
```

**Level 3 — Sub-Part Targeting (`classNames` prop)**

Complex components expose named slots via a `classNames` prop, following the Radix UI pattern. This allows scoped overrides of internal parts without fighting specificity:

```tsx
<DeviceTile
  deviceId="wm001"
  classNames={{
    root:   'my-tile-root',
    header: 'my-tile-header',
    metric: 'my-tile-metric',
  }}
/>
```

**CSS `@layer` — Host Styles Always Win**

All MDK component default styles are declared inside a `@layer mdk` block. This guarantees that any unlayered style in the host application automatically wins, with no need for `!important`:

```css
/* MDK internals (inside the package) */
@layer mdk {
  .mdk-tile { background: #1e1e2e; }
}

/* Host app — this automatically overrides, no !important needed */
.mdk-tile { background: white; }
```

### 2.4 Developer Entry Points Matrix
| Option | Entry Point | You Control |
|---|---|---|
| **A — Convenient** | Reference UI | Very little. Copy-paste standard tiles and wire up data. |
| **B — Hooks** | Framework Adapters | Your rendering. Use MDK hooks for complex state but write your own layout. |
| **C — Headless** | `@tetherto/mdk-ui-core` | Complete state integration. Wire logic into Zustand, Redux, Pinia, etc. |
| **D — Raw SDK** | `@tetherto/mdk-client` | Everything. Bypass the App Toolkit entirely and build your own backend + UI using `@tetherto/mdk-client` for ORK connectivity. |

---

## 3. The Backend Toolkit (App Node Middleware)

To ensure developers do not have to write the App Node gateway from scratch, the toolkit ships with **Backend Node Middleware** that drops directly into Fastify or Express.

### 3.1 Generic App Node Router
This pre-built middleware handles:
- Exposing standard `/auth` endpoints.
- Validating incoming user JWTs.
- Proxying commands securely down to ORK over HRPC using the `@tetherto/mdk-client`.

### 3.2 Route Extension Aggregation
The middleware provides hooks allowing developers to easily bind new REST or WebSocket endpoints (e.g., `POST /mining/stats`) that perform complex aggregations using ORK capabilities via **`@tetherto/mdk-client`**.

> The detailed design for this extension layer — a config‑driven, framework‑agnostic plugin system with first‑class AI/agent metadata — is captured in [`hld-app-node-plugins.md`](./hld-app-node-plugins.md).

---

## 4. Full-Stack Plugins (The "MDK-App" Architecture)

For developers looking for an absolute out-of-the-box solution, the toolkit pairs the Frontend and Backend into the **MDK-App Plugin Architecture** — an extensible, multi-tenant shell.

### 4.1 The Pre-Built Shell
Instead of building a custom React layout and a custom Fastify server, developers spin up the **App Shell** and **MDK Generic App Node**. These are ready-to-use binaries fully wired together.

### 4.2 Writing a Plugin
External developers then write "Plugins" consisting of two tightly-coupled pieces of code that register dynamically into the shell at runtime:
1. **MDK-App Server:** A package of business logic that registers custom backend routes (e.g., `/mining/stats`) into the Backend Toolkit's middleware hooks.
2. **MDK-App Widget:** A custom frontend React component that mounts into the App Shell's grid layout and natively queries `/mining/stats`.

**Plug-and-Play Reusability:** This explicit convention ensures that an external company can build a completely new dashboard widget and backend aggregator for a new device type, publish it as a single NPM package, and allow any user to drop it into their existing MDK deployment without modifying core source code.

---

## 5. Full-Stack Architecture Overview

```mermaid
flowchart TD
    subgraph "Frontend Layer (Browser Toolkit)"
        direction TB
        UI_COMPS["Reference UI / Shell<br/>(@tetherto/mdk-react-devkit)"]
        FRAMEWORKS["Framework Adapters<br/>(@tetherto/mdk-react-adapter, @tetherto/mdk-vue)"]
        UI_CORE["@tetherto/mdk-ui-core<br/>(Headless Buffer & API Client)"]
        
        UI_COMPS -->|"consumes reactive hooks"| FRAMEWORKS
        FRAMEWORKS -->|"wraps JS state logic"| UI_CORE
    end

    subgraph "Backend Layer (App Node Toolkit)"
        direction TB
        ROUTER["App Node Router & Middleware<br/>(Express/Fastify, JWT Auth, API Plugins)"]
        CLIENT["@tetherto/mdk-client<br/>(Isolated Native SDK)"]
        
        ROUTER -->|"translates REST to HRPC via"| CLIENT
    end
    
    UI_CORE <-->|"HTTP"| ROUTER
    CLIENT -->|"MDK Protocol"| ORK[MDK Core ORK]
    
    style UI_COMPS fill:#f3e5f5,stroke:#9c27b0,stroke-width:2px,color:#000
    style FRAMEWORKS fill:#e8f5e9,stroke:#4caf50,stroke-width:2px,color:#000
    style UI_CORE fill:#e3f2fd,stroke:#2196f3,stroke-width:2px,color:#000
    style ROUTER fill:#fff3e0,stroke:#ff9800,stroke-width:2px,color:#000
    style CLIENT fill:#e0f7fa,stroke:#00bcd4,stroke-width:2px,color:#000
```
