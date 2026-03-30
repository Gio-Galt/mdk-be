
## `07-open-questions.md`

# Open Questions for Team Discussion

These are the areas where we need your input before finalizing the
architecture. Nothing here is decided — these are genuine design
tensions we want to resolve together.

---

## 1. ORK Kernel Design

### Command State Machine

The proposal introduces a formal command lifecycle:
QUEUED → DISPATCHED → EXECUTING → SUCCESS/FAILED/TIMEOUT/DEAD

Every state transition is persisted to Hyperbee WAL for crash recovery.

- **Is this state machine complete?** Are there transitions or states
  we're missing for real-world device interactions?
- **Retry policy:** We propose max 3 retries with timeout-based
  re-queue. Is that sensible for all device types, or should retry
  policy be per-device/per-command configurable?
- **Timeout values:** 30s default timeout for command execution.
  Some firmware updates can take minutes. Should timeout be part of
  the command payload rather than a global default?

### Concurrency Manager

The proposal enforces:
- One command at a time per device (device-level lock)
- Max 50 active commands per worker
- Global queue depth limit of 500
- Backpressure signal at 80% capacity

- **Is one-command-per-device too restrictive?** Some devices might
  handle concurrent reads while a write is in progress.
  Should we distinguish read vs write locks?
- **Are these defaults reasonable for our scale?** What queue depths
  do we see in practice today?
- **Backpressure:** When the system is backpressured, what should
  the App Node tell consumers? HTTP 429? Queued response with
  estimated wait time?

### Fault Supervision

The proposal uses a circuit breaker pattern per worker:
CLOSED → OPEN (after 5 failures) → HALF-OPEN (after 30s cooldown)

- **When a circuit opens, what happens to queued commands for that
  worker's devices?** Options:
  1. Fail them immediately
  2. Hold them until circuit closes
  3. Re-route to a backup worker (if one exists)
- **Should circuit breaker thresholds be configurable per worker type?**
  A flaky power meter might need different tolerance than a miner.
- **Who triggers process restarts?** ORK directly, or do we always
  delegate to PM2/Docker/K8s?

### Health Monitor

Proposal: ping workers every 5s, 3s timeout, 3 missed pings = dead.

- **Is 5s ping interval too aggressive for large deployments?**
  At 1000 workers that's 200 pings/second.
- **Should health checks be pull-based (ORK pings workers) or
  push-based (workers send heartbeats)?** Push might scale better.


## 2. App Node Plugin Architecture

The proposal makes the App Node a generic plugin host. Each
integration ships a worker (for ORK) + a node plugin (for App Node).

### Plugin Interface

Each plugin declares:
- Name, version, route prefix
- Capabilities and supported actions
- Worker type it corresponds to

And implements a `register(app, context)` method that receives
the HTTP server instance and an ORK client.

- **Is this interface sufficient?** What else might a plugin need
  from the core? Access to storage? Event subscriptions? Other
  plugins?
- **Plugin-to-plugin communication:** Should plugins be able to
  discover and interact with each other? Example: a "site controller"
  plugin that reads from miner plugins and power meter plugins
  to make decisions.
- **Error handling contract:** When a plugin's route throws, what
  does the core do? Swallow it? Crash the request? Disable the
  plugin?

### Plugin Discovery and Loading

Proposal: config-driven loading from `mdk.config.json`:
```json
{
  "appNode": {
    "plugins": [
      "@tetherto/mdk-plugin-whatsminer",
      "@acme-corp/mdk-plugin-custom-sensor"
    ]
  }
}
```

- **Is config-driven loading sufficient, or do we also need
  directory-scan auto-discovery?**
- **Plugin validation on load:** How strict should we be?
  Validate manifest only? Run a health check? Reject plugins
  that declare capabilities their worker doesn't support?
- **Hot reloading:** Can plugins be added/removed without
  restarting the App Node? Or is restart acceptable?

### The "Two-Package" Integration Pattern

A company integrating a device ships one npm package with:
- Device lib (hardware communication)
- Worker (HRPC ↔ ORK)
- Node plugin (REST routes for App Node)
- Optional UI components

- **Is one npm package the right distribution unit, or should
  worker and node-plugin be separate packages?** Separate packages
  give more flexibility but more install complexity.
- **Versioning:** What happens when a plugin version is
  incompatible with the current MDK Core version? Do we need a
  plugin API version field?
- **Testing:** Should MDK provide a test harness for plugin
  authors? Something like `mdk test-plugin ./my-plugin` that
  validates the contract?

---

## 3. Storage — Hyperbee

### Scale Concerns

At 1000 devices × 10 metrics × 1 read/30s = ~28.8M data points/day.

The proposal includes a tiered compaction strategy:
- Raw data: 0–24h
- 1-min averages: 1–7 days
- 5-min averages: 7–30 days
- 1-hour averages: 30–365 days

- **Is this compaction strategy aggressive enough?** What's the
  expected disk footprint per day at our target scale?
- **Who runs compaction?** A dedicated ORK module? A separate
  process? A cron job?
- **Data export:** Do we need to ship telemetry to external
  systems (Prometheus, ClickHouse, data warehouse)? If yes,
  should that be a built-in capability or a plugin?

### Pluggable Storage Backend

The proposal suggests a `StorageBackend` interface so Hyperbee
can be swapped for Postgres, ClickHouse, etc. in enterprise
deployments.

- **Do we need this from day one, or is Hyperbee-only acceptable
  for v1?**
- **If pluggable, should it be all-or-nothing (entire storage
  layer swapped) or per-namespace (e.g., telemetry in ClickHouse,
  commands in Hyperbee)?**

### WAL and Crash Recovery

Every command state transition is written to Hyperbee WAL.
On ORK restart, pending commands are recovered and re-queued.

- **What's the performance cost of WAL writes per command
  transition?** At high command throughput, is this a bottleneck?
- **Should WAL writes be synchronous (safer, slower) or
  batched (faster, small data loss window)?**

---

## 4. Protocol and Communication

### Message Format

The proposal uses a JSON message format for all ORK ↔ Worker
communication:

```json
{
  "id": "msg-uuid",
  "type": "request | response | event",
  "action": "getStats | performAction | ...",
  "deviceId": "device-uuid",
  "payload": {},
  "timestamp": 1711640000000
}
```

- **Is JSON sufficient, or should we define a stricter schema
  (JSON Schema, Protobuf, etc.)?**
- **Should the message format include a protocol version field
  for future compatibility?**
- **Error responses:** What's the standard error envelope?
  Do we need error codes, categories, retry hints?

### Transport Independence

The protocol is transport-agnostic: direct in-process calls in
single-process mode, HRPC in multi-process mode.

- **Are there scenarios where we need mixed transports?**
  E.g., some workers on HRPC, others on a different protocol?
- **WebSocket for real-time events from ORK → App Node:**
  Is HRPC streaming sufficient, or do we need a dedicated
  event bus (e.g., NATS, Redis pub/sub)?

---

## 5. Capability Model

Workers declare capabilities on registration (e.g.,
`readHashrate`, `reboot`, `setFanSpeed`).

- **Who defines the canonical capability list?** MDK Core
  defines a base set — but can plugins define arbitrary
  capabilities?
- **Capability negotiation:** What if a device advertises
  a capability but fails every time it's invoked? Should
  ORK automatically de-register unreliable capabilities?
- **Capability versioning:** If the meaning of `getStats`
  changes (new fields, different schema), how do we handle
  backward compatibility?

---

## 6. Operational Concerns

- **Observability:** How do we monitor MDK itself? What
  metrics does ORK expose about its own health (queue depth,
  command latency, worker status)?
- **Logging:** Structured logging standard? Log levels?
  Where do logs go?
- **Configuration management:** Is `mdk.config.json` the
  single source of truth? Environment variable overrides?
  Config hot-reload?
- **Upgrade path:** How do we handle rolling upgrades when
  ORK, workers, and plugins might be at different versions?

---

## 7. What Should We Tackle First?

Given everything above, what do you think the priority order
should be?

The proposal suggests:
1. Protocol + message format (defines the system contract)
2. ORK kernel modules (command lifecycle, concurrency, faults)
3. Plugin system (App Node becomes a plugin host)
4. Storage optimization (compaction, pluggable backends)

- **Does this order make sense?**
- **What would you change?**
- **What's the riskiest part that needs spiking first?**

---

## How to Give Feedback

Comment directly on any section in the PR. If you have a strong
opinion, propose an alternative — not just a concern.

Format:
- ✅ "I agree with X because..."
- ❌ "I disagree with X because... I'd suggest Y instead"
- ❓ "I'm unsure about X — can we spike it?"
```