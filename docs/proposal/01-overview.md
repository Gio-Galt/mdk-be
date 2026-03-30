

## `01-overview.md`

# MDK Architecture Proposal — Overview

## The Vision

MDK becomes the **industry-standard integration layer for Bitcoin mining
infrastructure** — a platform where:

- Any company can build and maintain integrations for their devices
- AI agents can monitor, reason about, and control entire mining farms
- Thousands of heterogeneous machines communicate every second
- The system scales without architectural rewrites

## Why We Need These Changes

Today MDK has a solid foundation: device libraries, flexible deployment
modes, and persistent storage. But as we push toward AI-driven autonomous
mining farms and third-party ecosystem growth, we hit three limits:

### 1. No formal system contract

ORK and workers communicate through implicit conventions. There's no
defined protocol — no standard message format, no lifecycle rules, no
versioning. Every new device integration requires understanding MDK
internals, not just a spec.

**Impact:** External companies can't build integrations independently.
AI agents can't interact safely without a structured contract.

### 2. ORK is underspecified

ORK orchestrates devices but its internal responsibilities aren't
formally defined. There's no explicit command lifecycle, no concurrency
control, no fault supervision model. As we scale to thousands of
devices sending messages every second, this becomes a bottleneck.

**Impact:** Logic leaks into workers and nodes. Failure recovery is
ad hoc. Scaling behavior is unpredictable.

### 3. The Node is monolithic

App Node serves REST endpoints but has built-in knowledge of device
types. Adding a new device means modifying the Node itself.

**Impact:** Third-party integrations require core team involvement.
The API surface can't grow without growing the core.

---

## What We're Proposing

Three interconnected architectural changes across the three layers
of MDK:

```text
┌─────────────────────────────────────────────┐
│                   NODE                       │
│                                              │
│  Generic API gateway with plugin slots       │
│  Any company adds their routes as a plugin   │
│  AI agents, UIs, CLIs discover capabilities  │
│  dynamically via GET /plugins                │
├──────────────────────┬──────────────────────┤
│               MDK Protocol                   │
│         (standard message format)            │
├──────────────────────┴──────────────────────┤
│                   ORK                        │
│                                              │
│  Hardened orchestration kernel               │
│  Command lifecycle state machine             │
│  Concurrency control, fault supervision      │
│  Capability registry, health monitoring      │
├──────────────────────┬──────────────────────┤
│               MDK Protocol                   │
│         (same messages, same rules)          │
├──────────────────────┴──────────────────────┤
│                 WORKERS                      │
│                                              │
│  One per device type                         │
│  Speaks MDK Protocol to ORK                  │
│  Wraps device-specific libraries             │
│  Declares capabilities on registration       │
└─────────────────────────────────────────────┘
```

### Change 1: MDK Protocol

A formal message specification that governs **all** communication
between Node ↔ ORK ↔ Workers. Standard envelope, typed actions,
lifecycle semantics. Transport-agnostic — works over in-process
calls and HRPC identically.

### Change 2: ORK Kernel

ORK becomes a properly defined orchestration kernel with separated
internal modules: command dispatcher, command state machine,
concurrency manager, fault supervisor, health monitor, scheduler,
telemetry collector, persistence layer, and worker registry.

### Change 3: Node Plugin System

App Node becomes a thin, generic API gateway. Device-specific
knowledge lives in **plugins** that register their own routes,
capabilities, and worker bindings. Core Node never changes when
a new device type is added.

---

## How a New Integration Works (Before vs After)

### Before (current)

```text
1. Write device lib                    ← Your code
2. Modify ORK to handle new type       ← Core team code
3. Modify Node to add routes           ← Core team code
4. Test across deployment modes        ← Core team effort
5. Release new MDK version             ← Core team release
```

### After (proposed)

```text
1. Write device lib                    ← Your code
2. Write worker (implements protocol)  ← Your code
3. Write node plugin (registers routes)← Your code
4. Publish as npm package              ← Your release
5. Consumer installs, restarts MDK     ← Done
```

**ORK and Node never change. Zero core team involvement.**

---

## How AI Agents Fit

The proposed architecture is designed to be AI-native:

```text
┌─────────────┐
│  AI Agent   │
└──────┬──────┘
       │
       │ 1. GET /plugins        → discovers all capabilities
       │ 2. GET /devices        → sees all devices + their state
       │ 3. POST /wm/WM001/... → sends commands through protocol
       │ 4. WS /events          → subscribes to real-time telemetry
       │
       ▼
┌─────────────┐
│    NODE     │  Self-describing API — agent learns what's possible
├─────────────┤
│    ORK      │  Enforces concurrency, validates commands, manages state
├─────────────┤
│  WORKERS    │  Execute on physical devices
└─────────────┘
```

Because every capability is declared, every command follows a
lifecycle, and every device is discoverable — an AI agent can
safely operate across an entire farm without hardcoded knowledge
of any specific device type.

---

## What Stays the Same

- Single-process and multi-process deployment flexibility
- Hyperbee as the default storage layer
- HRPC as the multi-process transport
- Device libraries organized by brand and model
- Config-driven deployment via `mdk.config.json`
- The general topology: Node → ORK → Workers → Devices

We're not replacing the architecture. We're **hardening and
formalizing** what's already there so it can support:

- Thousands of devices per site
- Messages every second per device
- Third-party integrations without core changes
- AI agents as first-class consumers

---

## Document Structure

This proposal is organized into focused sections:

| Document | What It Covers |
|---|---|
| **01-overview.md** | This document — why and what (you are here) |
| **02-node.md** | Node as plugin host, plugin interface, discovery |
| **03-ork.md** | ORK kernel modules, command lifecycle, concurrency, faults |
| **04-workers.md** | Worker contract, capability declaration, device lib wrapping |
| **05-protocol.md** | MDK Protocol spec — message format, actions, lifecycle |
| **06-integration-guide.md** | How third parties build, ship, and maintain integrations |

Each document includes diagrams and specific design decisions
marked for feedback.

---

## How to Review

1. Read this overview first (5 min)
2. Pick the sections most relevant to your expertise
3. Comment directly on the PR — on any line, diagram, or decision
4. Use these markers:

   - ✅ **Agree** — "This works because..."
   - ❌ **Disagree** — "I'd do X instead because..."
   - ❓ **Unsure** — "Can we spike this?"
   - 💡 **Idea** — "What about..."

Deadline for comments: **[DATE]**
Live discussion: **[DATE + 2-3 days]**
