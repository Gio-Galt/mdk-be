

## `04-ork.md`

# MDK Architecture Proposal — ORK (Orchestrator)

## What ORK Is

ORK is the **kernel** of MDK. It sits between the Node (API layer)
and the Workers (device communication layer). Every command, every
telemetry reading, every health check flows through ORK.

```text
         Node (API Gateway)
              │
              │  MDK Protocol
              ▼
    ┌───────────────────┐
    │        ORK        │  ← This document
    │   (Orchestrator)  │
    └────────┬──────────┘
             │  MDK Protocol
             ▼
         Workers (Device Libs)
```

Today ORK is described as an "orchestration/routing component."
This proposal redefines it as the **trusted coordination kernel**
of the entire system — with clearly separated internal modules,
explicit responsibilities, and a defined scaling path.

---

## Why ORK Needs to Change

The current ORK handles command routing and basic orchestration.
But as MDK scales to more devices, more workers, more plugins,
and more concurrent operations, ORK needs to be formalized around:

| Concern | Current state | Proposed |
|---|---|---|
| Command lifecycle | Implicit | Formal state machine with persistence |
| Concurrency | Not explicitly managed | Per-device locks, queue depth, backpressure |
| Fault handling | Relies on external supervisors (PM2/Docker) | Internal circuit breakers + external supervisors |
| Worker management | Registration exists | Full registry with capabilities + health tracking |
| Telemetry | Workers report, storage happens | Structured collection, compaction, streaming |
| Recovery | Crash-resilient storage | Explicit recovery protocol on startup |

---

## ORK Module Architecture

ORK is decomposed into **8 internal modules**. Each module has
a single responsibility, explicit interfaces with other modules,
and can be independently tested.

```text
┌─────────────────────────────────────────────────────────────────┐
│                          ORK KERNEL                              │
│                                                                  │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐    │
│  │    COMMAND      │  │   SCHEDULER    │  │    HEALTH      │    │
│  │   DISPATCHER    │  │                │  │   MONITOR      │    │
│  │                 │  │  • Tick loop   │  │                │    │
│  │  • Receive cmd  │  │  • Cron tasks  │  │  • Worker ping │    │
│  │  • Validate     │  │  • Poll sched. │  │  • Liveness    │    │
│  │  • Route        │  │  • Batch exec  │  │  • Readiness   │    │
│  └───────┬─────────┘  └───────┬────────┘  └───────┬────────┘   │
│          │                    │                     │            │
│          ▼                    ▼                     ▼            │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐    │
│  │    COMMAND      │  │  CONCURRENCY   │  │     FAULT      │    │
│  │  STATE MACHINE  │  │   MANAGER      │  │  SUPERVISOR    │    │
│  │                 │  │                │  │                │    │
│  │  • Transitions  │  │  • Device locks│  │  • Circuit     │    │
│  │  • Timeouts     │  │  • Queue depth │  │    breaker     │    │
│  │  • Retries      │  │  • Backpressure│  │  • Crash detect│    │
│  │  • WAL logging  │  │  • Worker slots│  │  • Escalation  │    │
│  └───────┬─────────┘  └────────────────┘  └───────┬────────┘   │
│          │                                         │            │
│          ▼                                         │            │
│  ┌────────────────┐  ┌────────────────────────────┴──────┐     │
│  │  PERSISTENCE   │  │         WORKER REGISTRY            │     │
│  │    LAYER       │  │                                    │     │
│  │                │  │  • Register / deregister workers   │     │
│  │  • Hyperbee    │  │  • Capability declarations        │     │
│  │  • WAL append  │  │  • Health status per worker       │     │
│  │  • State snap  │  │  • HRPC endpoint mapping          │     │
│  │  • Recovery    │  │  • Worker ↔ device assignment      │     │
│  └────────────────┘  └───────────────────────────────────┘     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  TELEMETRY COLLECTOR                      │   │
│  │                                                           │   │
│  │  • Aggregate worker metrics                              │   │
│  │  • Write time-series to Hyperbee                         │   │
│  │  • Push events to Node (HRPC stream)                     │   │
│  │  • Downsample / compact old data                         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Module 1: Command Dispatcher

The **entry point** for all commands into ORK.

### Responsibility

Receives commands from the Node (via HRPC or in-process call),
validates them, resolves the target worker, checks preconditions,
and hands them to the Command State Machine.

### Flow

```text
Command arrives from Node
        │
        ▼
┌─────────────────┐
│  Validate schema │ ← Is this a well-formed command?
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Lookup worker   │ ← Worker Registry: which worker owns this device?
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Check concurrency│ ← Concurrency Manager: is the device locked?
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Check circuit   │ ← Fault Supervisor: is the worker circuit-broken?
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Create command  │ ← Hand to Command State Machine
│  entry           │
└─────────────────┘
```

### Interacts with

- Worker Registry (lookup)
- Concurrency Manager (precondition check)
- Fault Supervisor (precondition check)
- Command State Machine (handoff)

---

## Module 2: Command State Machine

The **core of command lifecycle management**. Every command that
enters ORK goes through this state machine. Every state transition
is persisted to Hyperbee.

### State Diagram

```text
                ┌──────────────────────────────┐
                │                              │
                ▼                              │ retry < maxRetries
          ┌──────────┐                         │
          │  QUEUED   │                         │
          └────┬─────┘                         │
               │ dispatch()                    │
               ▼                               │
          ┌──────────┐                         │
          │DISPATCHED│                         │
          └────┬─────┘                         │
               │ ack()                         │
               ▼                               │
          ┌──────────┐    timeout()      ┌─────┴─────┐
          │EXECUTING │──────────────────►│  TIMEOUT   │
          └────┬─────┘                   └─────┬─────┘
               │                               │
        ┌──────┴──────┐                        │ retry >= maxRetries
        │             │                        ▼
   succeed()      fail()                ┌──────────┐
        │             │                 │   DEAD    │
        ▼             ▼                 └──────────┘
   ┌─────────┐  ┌─────────┐
   │ SUCCESS │  │ FAILED  │
   └─────────┘  └─────────┘
```

### Key properties

- **Every transition is persisted** — if ORK crashes, the state
  can be recovered from Hyperbee
- **Terminal states** are SUCCESS, FAILED, and DEAD — once reached,
  no further transitions are possible
- **Retry logic** — on TIMEOUT, the command can be re-queued up to
  `maxRetries` times before being marked DEAD
- **Full transition history** — every command stores its complete
  transition log for debugging and auditing

### Persistence contract

```text
Key:   cmd/{commandId}
Value: {
  id,
  state,
  payload: { deviceId, action, params },
  retries,
  maxRetries,
  timeoutMs,
  transitions: [
    { from: null, to: 'QUEUED', at: timestamp },
    { from: 'QUEUED', to: 'DISPATCHED', at: timestamp },
    ...
  ],
  createdAt,
  updatedAt,
  result,
  error
}

Index: cmd/pending/{commandId}     ← fast lookup of non-terminal commands
Index: cmd/device/{deviceId}/{ts}  ← command history per device
```

### Crash recovery

On ORK startup, the State Machine runs a **recovery sweep**:

```text
1. Read all entries from cmd/pending/ index
2. For each non-terminal command:
   - If DISPATCHED or EXECUTING:
     → Transition to TIMEOUT (reason: 'ork_crash_recovery')
     → If retries < maxRetries: re-queue (TIMEOUT → QUEUED)
     → If retries >= maxRetries: mark DEAD
   - If QUEUED:
     → Leave as-is (scheduler will pick it up)
3. Terminal commands (SUCCESS, FAILED, DEAD) are not touched
```

This guarantees that **no command is lost** across ORK restarts.

### Interacts with

- Command Dispatcher (receives new commands)
- Persistence Layer (reads/writes every transition)
- Concurrency Manager (acquire/release device locks)

---

## Module 3: Scheduler

The **tick loop** that drives periodic operations.

### Responsibility

Runs on a configurable interval (default: 1 second). Evaluates
registered tasks and feeds commands into the Dispatcher when
their interval has elapsed.

### Use cases

| Task | Interval | What it does |
|---|---|---|
| Poll miner stats | 30s | Generates `getStats` commands for all miners |
| Health check | 5s | Triggers worker liveness pings (via Health Monitor) |
| Telemetry compaction | 1h | Triggers downsampling of old time-series data |
| State snapshots | 5m | Snapshots current device state to Hyperbee |

### Design

```text
Every tick (1s):
  for each registered task:
    if (now - task.lastRunAt >= task.intervalMs):
      commands[] = task.fn()
      for each command:
        dispatcher.enqueue(command)
      task.lastRunAt = now
```

Tasks are registered at startup. Plugins can register additional
tasks through the ORK configuration.

### Interacts with

- Command Dispatcher (feeds commands)
- Worker Registry (queries available workers/devices)

---

## Module 4: Concurrency Manager

Prevents overwhelming devices and workers.

### Three levels of concurrency control

```text
┌──────────────────────────────────────────────────┐
│              CONCURRENCY MANAGER                  │
│                                                   │
│  Level 1: Per-Device Locks                       │
│  ┌────────────────────────────────────────────┐  │
│  │  WM001: 🔒 (cmd-042 executing)             │  │
│  │  WM002: 🔓 (available)                     │  │
│  │  WM003: 🔒 (cmd-043 executing)             │  │
│  └────────────────────────────────────────────┘  │
│                                                   │
│  Level 2: Per-Worker Capacity                    │
│  ┌────────────────────────────────────────────┐  │
│  │  whatsminer-worker-01: 12/50 active cmds   │  │
│  │  antminer-worker-01:   8/50 active cmds   │  │
│  └────────────────────────────────────────────┘  │
│                                                   │
│  Level 3: Global Queue                           │
│  ┌────────────────────────────────────────────┐  │
│  │  Queue depth: 47 / 500 (max)              │  │
│  │  Backpressure: OFF (triggers at 80%)      │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### How it works

1. **Per-device lock** — Only one command can execute on a device
   at a time. Physical mining hardware typically can't handle
   concurrent control commands safely.

2. **Per-worker capacity** — Each worker has a max number of
   concurrent commands (default: 50). Prevents a single worker
   process from being overwhelmed.

3. **Global queue depth** — Total system-wide command limit
   (default: 500). When the queue reaches 80%, ORK signals
   **backpressure** to the Node, which can throttle incoming
   requests.

### Interface

```text
canAcceptCommand(deviceId, workerId) → { allowed, reason }
acquire(deviceId, workerId, commandId) → void
release(deviceId, workerId) → void
isBackpressured() → boolean
getStats() → { queueDepth, lockedDevices, workerLoads }
```

### Interacts with

- Command Dispatcher (precondition checks)
- Command State Machine (acquire on dispatch, release on terminal)

---

## Module 5: Health Monitor

Tracks worker liveness and readiness.

### How it works

```text
Every pingInterval (default 5s):
  for each registered worker:
    try:
      ping worker (HRPC or in-process)
      record latency
      reset missed ping counter
      mark worker: HEALTHY
    catch:
      increment missed ping counter
      if missed >= threshold (default 3):
        mark worker: DEAD
        notify Fault Supervisor
      else:
        mark worker: SICK
```

### Worker health states

```text
  ┌─────────┐
  │ HEALTHY │◄──── ping succeeds
  └────┬────┘
       │ ping fails
       ▼
  ┌─────────┐
  │  SICK   │◄──── missed < threshold
  └────┬────┘
       │ missed >= threshold
       ▼
  ┌─────────┐
  │  DEAD   │───── Fault Supervisor notified
  └─────────┘
```

### Interacts with

- Worker Registry (reads worker list, updates health status)
- Fault Supervisor (escalates DEAD workers)

---

## Module 6: Fault Supervisor

Handles worker failures using the **circuit breaker pattern**.

### Circuit breaker per worker

```text
  ┌──────────┐     failures >= threshold     ┌──────────┐
  │  CLOSED  │──────────────────────────────►│   OPEN   │
  │ (normal) │                               │(blocked) │
  └────┬─────┘                               └─────┬────┘
       ▲                                           │
       │ probe succeeds                            │ cooldown expires
       │                                           ▼
       │                                     ┌───────────┐
       └─────────────────────────────────────│ HALF-OPEN │
                                             │ (probing) │
                                             └───────────┘
```

### How it works

- **CLOSED** — Normal operation. Commands flow to the worker.
  Failures are counted.
- **OPEN** — Worker is blocked. No commands are sent. After a
  cooldown period (default: 30s), circuit moves to HALF-OPEN.
- **HALF-OPEN** — One probe command is allowed through. If it
  succeeds → CLOSED. If it fails → back to OPEN.

### What happens when a circuit opens

Options (configurable per deployment):

1. **Queue commands** — Hold them until the circuit closes
2. **Reject immediately** — Return error to Node
3. **Re-route** — Send to a backup worker (if available)
4. **Trigger restart** — Signal PM2/Docker to restart the worker process

### Interacts with

- Health Monitor (receives failure reports)
- Command Dispatcher (checked before dispatching)
- Worker Registry (reads worker state)

---

## Module 7: Worker Registry

The **directory of all active workers** in the system.

### What it stores per worker

```text
┌─────────────────────────────────────────────┐
│  Worker: whatsminer-worker-01               │
│                                              │
│  type:          whatsminer-worker            │
│  endpoint:      hrpc://localhost:9001        │
│  capabilities:  [getStats, reboot, setFan]  │
│  devices:       [WM001, WM002, WM003]       │
│  health:        HEALTHY                      │
│  latency:       12ms                         │
│  registeredAt:  2026-03-28T10:00:00Z        │
│  lastPing:      2026-03-28T16:15:00Z        │
└─────────────────────────────────────────────┘
```

### Worker lifecycle

```text
  ┌─────────┐
  │  INIT   │  Worker process starts
  └────┬────┘
       │ load device lib, open HRPC channel
       ▼
  ┌─────────┐
  │REGISTER │  Self-register with ORK Worker Registry
  └────┬────┘
       │ registration ack'd
       ▼
  ┌─────────┐
  │  READY  │◄──────────────────────────┐
  └────┬────┘                           │
       │ receive command                │ command complete
       ▼                                │
  ┌─────────┐                           │
  │  BUSY   │───────────────────────────┘
  └────┬────┘
       │ health check fails / crash
       ▼
  ┌─────────┐
  │  SICK   │  Health Monitor marks unhealthy
  └────┬────┘
       │ timeout / unresponsive
       ▼
  ┌─────────┐
  │  DEAD   │  Fault Supervisor triggers restart
  └────┬────┘
       │ process restarted (PM2/Docker/ORK)
       ▼
  ┌─────────┐
  │  INIT   │  (cycle repeats)
  └─────────┘
```

### Capability-based routing

When a command arrives, the Dispatcher asks the Registry:

```text
"Which worker handles device WM001?"
  → whatsminer-worker-01

"Does whatsminer-worker-01 support 'setFanSpeed'?"
  → Yes (declared in capabilities)

"Is whatsminer-worker-01 healthy?"
  → Yes (HEALTHY, latency 12ms)
```

This is what makes ORK **device-agnostic**. It doesn't know
what a Whatsminer is. It only knows that worker X declared
capabilities Y and manages devices Z.

### Persistence

Worker registry is persisted to Hyperbee:

```text
Key:   worker/{workerId}
Value: { type, capabilities, endpoint, devices, registeredAt }
```

On ORK restart, the registry is rebuilt as workers re-register.
The persisted data serves as a reference for detecting workers
that were registered before the crash but haven't re-registered
yet (indicating they're also down).

### Interacts with

- Every other module (central lookup)
- Workers directly (registration/deregistration via HRPC)
- Persistence Layer (backup/recovery)

---

## Module 8: Telemetry Collector

Handles the **data pipeline** — collecting metrics from workers,
storing them, streaming them to the Node, and managing data
lifecycle.

### Responsibilities

```text
Workers ──telemetry──► Telemetry Collector ──► Hyperbee (storage)
                              │
                              ├──► Node (real-time push via HRPC stream)
                              │
                              └──► Compaction (scheduled downsampling)
```

### Storage schema

```text
Key:   ts/{deviceId}/{metricName}/{timestamp}
Value: { value, unit }

Examples:
  ts/WM001/hashrate/1711640000     → { value: 210, unit: "TH/s" }
  ts/WM001/temperature/1711640000  → { value: 65, unit: "celsius" }
  ts/WM001/fanSpeed/1711640000     → { value: 4200, unit: "rpm" }
```

Lexicographic key ordering gives us **natural time-range queries**:

```text
"Give me all hashrate readings for WM001 in the last hour"
→ Range scan: ts/WM001/hashrate/{now-3600} to ts/WM001/hashrate/{now}
```

### Data lifecycle — compaction tiers

At 1000 devices × 10 metrics × 1 reading/30s = **~28.8M data
points/day**. We can't keep raw data forever.

```text
Data Age           Resolution          Tier
──────────────────────────────────────────────
0 - 24 hours       Raw (every 30s)     Hot
1 - 7 days         1-minute averages   Warm
7 - 30 days        5-minute averages   Warm
30 - 365 days      1-hour averages     Cold
365+ days          1-day averages      Archive (optional export)
```

Compaction runs on a schedule (via Scheduler). It reads raw entries
in a time range, buckets them into the target resolution window,
writes averaged values as new keys, and tombstones the raw entries.

### Interacts with

- Workers (receives telemetry via HRPC)
- Persistence Layer (writes time-series data)
- Node (pushes real-time events via HRPC stream)
- Scheduler (compaction tasks)

---

## Persistence Layer (Hyperbee)

Not a module in the ORK kernel sense — it's the **storage
foundation** that multiple modules depend on.

### Namespaces

```text
┌─────────────────────────────────────────────────────────┐
│                    HYPERBEE STORE                         │
│                                                          │
│  cmd/          Command WAL (state machine persistence)  │
│  cmd/pending/  Index of non-terminal commands            │
│  cmd/device/   Command history per device                │
│                                                          │
│  ts/           Time-series telemetry                     │
│                                                          │
│  state/        Device state / config snapshots           │
│  state/{id}/history/  Historical state changes           │
│                                                          │
│  event/        Audit log / event stream                  │
│                                                          │
│  worker/       Worker registry persistence               │
│                                                          │
│  Append-only │ Crash-resilient │ B-tree indexed          │
└─────────────────────────────────────────────────────────┘
```

### Why Hyperbee

| Concern | Hyperbee answer |
|---|---|
| Crash safety | Append-only — no partial writes |
| No external deps | Embedded — no Postgres/Redis/Mongo to operate |
| Time-series queries | Lexicographic key ordering = natural range scans |
| Replication | Built-in Hypercore replication for multi-node |
| Portability | Files on disk — copy directory = copy database |

### Pluggable storage backend

For truly massive deployments (10k+ devices), the storage layer
is designed with a **pluggable interface**:

```text
StorageBackend (interface)
  ├── HyperbeeBackend   ← default, zero-config
  ├── PostgresBackend   ← enterprise option
  └── ClickHouseBackend ← analytics-heavy deployments
```

Hyperbee remains the default. Swapping backends requires no
changes to ORK modules — only a configuration change.

---

## Scaling ORK

This is how the architecture scales from a single miner to
thousands of devices.

### Scale level 1: Single-process (1–100 devices)

```text
┌──────────────────────────────────┐
│         Single Process            │
│                                   │
│  Node ──► ORK ──► Workers         │
│     (all in-process calls)        │
│                                   │
│  Hyperbee on local disk           │
└──────────────────────────────────┘
```

- All modules run in the same process
- Direct function calls between modules
- Zero network overhead
- One `npm install`, one `node index.js`

### Scale level 2: Multi-process (100–5,000 devices)

```text
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│    Node     │   │     ORK     │   │  Worker 1   │
│  (process)  │──►│  (process)  │──►│  (process)  │
└─────────────┘   └──────┬──────┘   └─────────────┘
                         │
                         ├──────────►┌─────────────┐
                         │           │  Worker 2   │
                         │           │  (process)  │
                         │           └─────────────┘
                         │
                         └──────────►┌─────────────┐
                                     │  Worker N   │
                                     │  (process)  │
                                     └─────────────┘
```

- Each component is a separate process
- Communication via HRPC
- PM2 or Docker manages process lifecycle
- Workers can be scaled independently per device type
- ORK remains a single process — the kernel

### Scale level 3: Multiple ORK workers (5,000+ devices)

If ORK becomes a bottleneck, the **modular architecture** enables
splitting without redesign:

```text
┌─────────────┐   ┌──────────────────────────────────┐
│    Node     │   │         ORK CLUSTER                │
│             │──►│                                    │
└─────────────┘   │  ┌──────────┐   ┌──────────┐     │
                  │  │  ORK     │   │  ORK     │     │
                  │  │ (rack 1) │   │ (rack 2) │     │
                  │  └────┬─────┘   └────┬─────┘     │
                  │       │              │            │
                  └───────┼──────────────┼────────────┘
                          │              │
               ┌──────────┴──┐   ┌──────┴──────────┐
               │ Workers     │   │ Workers          │
               │ (rack 1)   │   │ (rack 2)         │
               └─────────────┘   └─────────────────┘
```

**Sharding options** (not implemented in v1, but the modular
architecture preserves them):

| Strategy | How | When |
|---|---|---|
| **Shard by rack/site** | Each ORK instance owns a subset of workers grouped by physical location | Geographically distributed sites |
| **Shard by device type** | One ORK for miners, one for power meters | Very different polling/command patterns |
| **Module extraction** | Pull Telemetry Collector into its own process | Telemetry volume overwhelms main ORK loop |
| **Read replicas** | Worker Registry and state queries served from read-only ORK instances | Heavy query load from multiple Nodes |

### Why single ORK is fine for v1

At the expected message rates:

```text
1,000 devices × 1 stats poll / 30s = ~33 commands/second
1,000 devices × 10 metrics / 30s  = ~333 telemetry writes/second

ORK kernel loop at 1s tick:
  - 33 command dispatches
  - 333 Hyperbee puts
  - Health pings (staggered, not all at once)
```

A single Node.js process handles this comfortably. The scaling
strategies above become relevant at **5,000–10,000+ devices**.

### Key scaling principle

> **Every ORK module has explicit interfaces. Modules can be
> extracted into separate processes without changing their
> internal logic — only their communication transport changes
> (in-process call → HRPC).**

This is the same principle that lets MDK switch between
single-process and multi-process mode for the whole system.
The same principle applies *inside* ORK itself.

---

## End-to-End Command Flow

Tracing a single command from UI to device and back:

```text
 1. User clicks "Reboot" on WM001 in the React UI

 2. UI → Node
    POST /wm/WM001/reboot
    Authorization: Bearer <token>

 3. Node (Whatsminer Plugin)
    Auth middleware validates token
    Plugin calls orkClient.sendCommand({
      workerType: 'whatsminer-worker',
      deviceId: 'WM001',
      action: 'reboot'
    })

 4. Node → ORK (MDK Protocol via HRPC)

 5. ORK: Command Dispatcher
    • Validate command schema               ✓
    • Worker Registry: WM001 → wm-worker-01 ✓
    • Concurrency Manager: WM001 not locked  ✓
    • Fault Supervisor: wm-worker-01 CLOSED  ✓
    • Create command → State Machine

 6. ORK: Command State Machine
    • QUEUED → Hyperbee WAL write
    • DISPATCHED → send to worker via HRPC
    • Concurrency Manager: acquire(WM001)

 7. ORK → Worker (MDK Protocol via HRPC)

 8. Worker
    • Ack → State Machine: EXECUTING → WAL write
    • Device lib calls physical miner at 192.168.1.100
    • Miner responds OK

 9. Worker → ORK
    • Result → State Machine: SUCCESS → WAL write
    • Concurrency Manager: release(WM001)
    • Fault Supervisor: recordSuccess(wm-worker-01)

10. ORK → Node (HRPC response)

11. Node → UI
    HTTP 200 { status: 'success', commandId: '...' }

12. Telemetry (parallel)
    • Worker emits status event
    • Telemetry Collector → Hyperbee:
      ts/WM001/status/1711640000 → { value: 'rebooting' }
    • Event pushed to Node via HRPC stream
    • Node pushes to UI via WebSocket
    • UI updates device status in real-time
```

---

## ORK Recovery on Startup

When ORK starts (or restarts after a crash):

```text
1. Load configuration

2. Initialize Hyperbee storage

3. Command State Machine: recovery sweep
   • Read cmd/pending/ index
   • DISPATCHED/EXECUTING → TIMEOUT → retry or DEAD
   • QUEUED → leave (scheduler will pick up)

4. Worker Registry: load persisted registry
   • Mark all workers as UNKNOWN
   • Wait for workers to re-register
   • Workers that don't re-register within timeout → DEAD

5. Start Scheduler (tick loop)

6. Start Health Monitor (ping loop)

7. Accept commands from Node
```

### Recovery guarantees

| Scenario | What happens |
|---|---|
| ORK crashes mid-command | Command recovered from WAL, retried or marked DEAD |
| Worker crashes during command | Health Monitor detects, Fault Supervisor opens circuit, command times out and retries |
| Both ORK + Worker crash | ORK recovers commands from WAL, waits for worker to re-register, then retries |
| Hyperbee data on disk | Append-only log — always consistent, no corruption from crashes |

---

## Open Questions — Leave Your Feedback

> Comment directly on the PR:
> ✅ Agree  ❌ Disagree  ❓ Unsure  💡 Idea

1. **Command timeout defaults** — 30 seconds feels right for
   most device operations. But firmware updates can take minutes.
   Should timeouts be per-action configurable?

2. **Per-device lock strictness** — One command per device at a
   time is safe but conservative. Some devices can handle
   concurrent reads (getStats) while blocking concurrent writes.
   Should we distinguish read vs write locks?

3. **Circuit breaker thresholds** — 5 failures before opening,
   30s cooldown. Are these right? Should they be configurable
   per worker type?

4. **Telemetry compaction** — The tiered approach (raw → 1min →
   5min → 1hr → 1day) is standard. But should compaction be
   configurable per deployment? Some sites may want raw data
   for longer periods.

5. **ORK as single process in v1** — The math says a single
   Node.js process handles 1,000+ devices comfortably. But
   should we design the module interfaces for extraction from
   day one, or accept the coupling and refactor when needed?

6. **Scheduler extensibility** — Should plugins be able to
   register their own scheduled tasks via the Node plugin
   interface? Or should all scheduling be managed through
   ORK configuration only?

7. **Worker re-registration timeout** — When ORK restarts, how
   long should it wait for workers to re-register before
   marking them DEAD? 30s? 60s? Configurable?

8. **Backpressure signaling** — When the global queue hits 80%,
   ORK signals backpressure to the Node. How should the Node
   respond? HTTP 429? Slow down poll frequency? Queue
   client-side?

9. **Event loss during ORK downtime** — Events produced by
   workers while ORK is down are currently lost. Is this
   acceptable for v1? Or should workers buffer events and
   replay them on ORK reconnection?
```