

## `03-protocol.md`

# MDK Protocol Specification v0.0.1

## 1. Purpose

This document defines the communication protocol between all MDK Core
components. It is the formal contract that governs how ORK, Workers,
and the App Node exchange messages.

The protocol is **transport-agnostic**:

| Mode             | Transport                    | Serialization     |
|------------------|------------------------------|-------------------|
| Single-process   | Direct function calls        | Plain JS objects  |
| Multi-process    | HRPC                         | Same message format, serialized |

Same messages. Same semantics. Same contract. Only the transport changes.
A worker does not know (or care) whether it's running in-process or as
a separate container.

---

## 2. Message Envelope

Every MDK protocol message uses this envelope:

```json
{
  "id": "uuid-v4",
  "version": "0.0.1",
  "type": "request | response | event",
  "action": "string",
  "sender": "string",
  "target": "string",
  "deviceId": "string | null",
  "correlationId": "uuid-v4 | null",
  "timestamp": 1711640000000,
  "payload": {}
}
```

### Field definitions

| Field           | Type              | Required | Purpose                                              |
|-----------------|-------------------|----------|------------------------------------------------------|
| `id`            | string (UUID v4)  | yes      | Unique message identifier                            |
| `version`       | string            | yes      | Protocol version (`"0.0.1"`)                         |
| `type`          | enum              | yes      | `"request"`, `"response"`, or `"event"`              |
| `action`        | string            | yes      | The protocol action being performed                  |
| `sender`        | string            | yes      | Identity of the originating component                |
| `target`        | string            | yes      | Identity of the intended recipient                   |
| `deviceId`      | string or null    | no       | Target device (null for system-level messages)       |
| `correlationId` | string (UUID) or null | no   | Links a response to its original request             |
| `timestamp`     | integer (epoch ms)| yes      | Message creation time                                |
| `payload`       | object            | yes      | Action-specific content (may be empty `{}`)          |

### Envelope rules

- `id` MUST be unique per message
- `version` MUST match the protocol version the sender implements
- `correlationId` MUST be set on `response` messages and MUST match
  the `id` of the originating `request`
- `timestamp` MUST be set by the sender at message creation time
- `payload` schema is defined per action (see Section 4)

---

## 3. Message Types

### 3.1 `request`

Sent by a component that expects a `response`. Used for commands,
queries, and registration.

Flow: sender → target → sender (via correlated `response`)

### 3.2 `response`

Sent in reply to a `request`. Always carries a `correlationId`
matching the original request's `id`.

Must include a `status` field in the payload:

```json
{
  "payload": {
    "status": "ok | error",
    "data": {},
    "error": "string | null"
  }
}
```

### 3.3 `event`

Sent by a component to announce something that happened. Events are
fire-and-forget — no response is expected.

Flow: sender → target (one-way)

---

## 4. Protocol Actions

### 4.1 Core Actions (v0.0.1)

v0.0.1 defines the minimum set of actions required to support device
registration, telemetry flow, command execution, and health monitoring.

| Action              | Type      | Direction        | Purpose                                    |
|---------------------|-----------|------------------|--------------------------------------------|
| `register`          | request   | Worker → ORK     | Worker announces itself and its capabilities |
| `register.ack`      | response  | ORK → Worker     | ORK confirms registration                  |
| `deregister`        | request   | Worker → ORK     | Worker announces graceful shutdown          |
| `capabilities`      | request   | ORK → Worker     | ORK queries worker capabilities             |
| `telemetry.publish` | event     | Worker → ORK     | Worker pushes device telemetry              |
| `event.publish`     | event     | Worker → ORK     | Worker pushes a system event (alert, state change) |
| `command.request`   | request   | ORK → Worker     | ORK sends a command to execute on a device  |
| `command.result`    | response  | Worker → ORK     | Worker reports command outcome              |
| `health.ping`       | request   | ORK → Worker     | Liveness probe                              |
| `health.pong`       | response  | Worker → ORK     | Liveness response                           |

### Actions deferred to v0.1

These will be added once v0.0.1 is validated against real workers:

- `subscription.open` / `subscription.close`
- `query.request` / `query.response`
- `state.sync`
- `config.read` / `config.write`

## 5. Action Specifications

### 5.1 `register`

Sent by a Worker on startup. Declares what the worker manages and
what it can do.

**Direction:** Worker → ORK
**Type:** request

```json
{
  "id": "msg-001",
  "version": "0.0.1",
  "type": "request",
  "action": "register",
  "sender": "worker:whatsminer-m56s:rack-04",
  "target": "ork",
  "deviceId": null,
  "correlationId": null,
  "timestamp": 1711640000000,
  "payload": {
    "workerType": "whatsminer-worker",
    "devices": [
      {
        "deviceId": "WM001",
        "ip": "192.168.1.100",
        "port": 8080,
        "serialNumber": "WM001"
      },
      {
        "deviceId": "WM002",
        "ip": "192.168.1.101",
        "port": 8080,
        "serialNumber": "WM002"
      }
    ],
    "capabilities": {
      "telemetry": [
        { "name": "hashrate", "unit": "TH/s", "type": "number" },
        { "name": "temperature", "unit": "celsius", "type": "number" },
        { "name": "fanSpeed", "unit": "rpm", "type": "number" },
        { "name": "powerConsumption", "unit": "watts", "type": "number" },
        { "name": "chipFrequency", "unit": "MHz", "type": "number" }
      ],
      "commands": [
        { "name": "reboot", "params": [] },
        { "name": "setFanSpeed", "params": [{ "name": "speed", "type": "number", "unit": "rpm" }] },
        { "name": "setFrequency", "params": [{ "name": "frequency", "type": "number", "unit": "MHz" }] },
        { "name": "setPowerLimit", "params": [{ "name": "limit", "type": "number", "unit": "watts" }] },
        { "name": "switchPool", "params": [{ "name": "pool", "type": "string" }] }
      ],
      "events": ["alert", "stateChange", "error"],
      "config": {
        "readable": true,
        "writable": true
      },
      "health": true
    },
    "metadata": {
      "brand": "Whatsminer",
      "model": "M56S",
      "deviceType": "miner"
    }
  }
}
```

### 5.2 `register.ack`

**Direction:** ORK → Worker
**Type:** response

```json
{
  "id": "msg-002",
  "version": "0.0.1",
  "type": "response",
  "action": "register.ack",
  "sender": "ork",
  "target": "worker:whatsminer-m56s:rack-04",
  "deviceId": null,
  "correlationId": "msg-001",
  "timestamp": 1711640000100,
  "payload": {
    "status": "ok",
    "workerId": "wm-worker-01",
    "registeredDevices": ["WM001", "WM002"]
  }
}
```

### 5.3 `telemetry.publish`

Sent by a Worker periodically with device metrics.

**Direction:** Worker → ORK
**Type:** event (no response expected)

```json
{
  "id": "msg-010",
  "version": "0.0.1",
  "type": "event",
  "action": "telemetry.publish",
  "sender": "worker:whatsminer-m56s:rack-04",
  "target": "ork",
  "deviceId": "WM001",
  "correlationId": null,
  "timestamp": 1711640030000,
  "payload": {
    "metrics": {
      "hashrate": 210.5,
      "temperature": 62,
      "fanSpeed": 4200,
      "powerConsumption": 3420,
      "chipFrequency": 580
    }
  }
}
```

### 5.4 `event.publish`

Sent by a Worker when something notable happens on a device.

**Direction:** Worker → ORK
**Type:** event

```json
{
  "id": "msg-020",
  "version": "0.0.1",
  "type": "event",
  "action": "event.publish",
  "sender": "worker:whatsminer-m56s:rack-04",
  "target": "ork",
  "deviceId": "WM001",
  "correlationId": null,
  "timestamp": 1711640035000,
  "payload": {
    "eventType": "alert",
    "severity": "warning",
    "message": "Temperature exceeding threshold",
    "details": {
      "metric": "temperature",
      "value": 85,
      "threshold": 80
    }
  }
}
```

### 5.5 `command.request`

Sent by ORK to a Worker to execute an action on a device.

**Direction:** ORK → Worker
**Type:** request

```json
{
  "id": "msg-030",
  "version": "0.0.1",
  "type": "request",
  "action": "command.request",
  "sender": "ork",
  "target": "worker:whatsminer-m56s:rack-04",
  "deviceId": "WM001",
  "correlationId": null,
  "timestamp": 1711640040000,
  "payload": {
    "command": "setFanSpeed",
    "params": {
      "speed": 5000
    },
    "timeout": 30000
  }
}
```

### 5.6 `command.result`

Sent by a Worker back to ORK after executing a command.

**Direction:** Worker → ORK
**Type:** response

```json
{
  "id": "msg-031",
  "version": "0.0.1",
  "type": "response",
  "action": "command.result",
  "sender": "worker:whatsminer-m56s:rack-04",
  "target": "ork",
  "deviceId": "WM001",
  "correlationId": "msg-030",
  "timestamp": 1711640041200,
  "payload": {
    "status": "ok",
    "data": {
      "fanSpeed": 5000,
      "applied": true
    },
    "error": null
  }
}
```

**On failure:**

```json
{
  "id": "msg-031",
  "version": "0.0.1",
  "type": "response",
  "action": "command.result",
  "sender": "worker:whatsminer-m56s:rack-04",
  "target": "ork",
  "deviceId": "WM001",
  "correlationId": "msg-030",
  "timestamp": 1711640041200,
  "payload": {
    "status": "error",
    "data": null,
    "error": "Device unreachable: connection timeout after 30000ms"
  }
}
```

### 5.7 `health.ping` / `health.pong`

Used by ORK Health Monitor for liveness checks.

**Ping — Direction:** ORK → Worker

```json
{
  "id": "msg-040",
  "version": "0.0.1",
  "type": "request",
  "action": "health.ping",
  "sender": "ork",
  "target": "worker:whatsminer-m56s:rack-04",
  "deviceId": null,
  "correlationId": null,
  "timestamp": 1711640050000,
  "payload": {}
}
```

**Pong — Direction:** Worker → ORK

```json
{
  "id": "msg-041",
  "version": "0.0.1",
  "type": "response",
  "action": "health.pong",
  "sender": "worker:whatsminer-m56s:rack-04",
  "target": "ork",
  "deviceId": null,
  "correlationId": "msg-040",
  "timestamp": 1711640050012,
  "payload": {
    "status": "ok",
    "uptime": 3600000,
    "activeDevices": 2,
    "queueDepth": 0
  }
}
```

---

## 6. Command Lifecycle

Commands follow a strict lifecycle managed by the ORK Command State
Machine. Every state transition is persisted to the Hyperbee WAL.

```text
                    ┌──────────────────────────────┐
                    │                              │
                    ▼                              │ (retry < maxRetries)
              ┌──────────┐                         │
              │  QUEUED   │                         │
              └────┬─────┘                         │
                   │ dispatch()                    │
                   ▼                               │
              ┌──────────┐                         │
              │DISPATCHED│                         │
              └────┬─────┘                         │
                   │ ack() (worker received it)    │
                   ▼                               │
              ┌──────────┐     timeout()     ┌─────┴─────┐
              │EXECUTING │────────────────►  │  TIMEOUT   │
              └────┬─────┘                   └─────┬─────┘
                   │                               │
            ┌──────┴──────┐                        │ (retry >= maxRetries)
            │             │                        ▼
       succeed()      fail()                 ┌──────────┐
            │             │                  │   DEAD    │
            ▼             ▼                  └──────────┘
       ┌─────────┐  ┌─────────┐
       │ SUCCESS │  │ FAILED  │
       └─────────┘  └─────────┘
```

### State definitions

| State        | Meaning                                                  |
|--------------|----------------------------------------------------------|
| `QUEUED`     | Command created, waiting to be dispatched                |
| `DISPATCHED` | Sent to worker via HRPC, waiting for acknowledgment      |
| `EXECUTING`  | Worker acknowledged receipt, executing on device         |
| `SUCCESS`    | Command completed successfully                           |
| `FAILED`     | Command failed (device error, validation error, etc.)    |
| `TIMEOUT`    | No response within timeout window                        |
| `DEAD`       | Retries exhausted — command permanently failed           |

### Valid transitions

| From         | To                        |
|--------------|---------------------------|
| `QUEUED`     | `DISPATCHED`              |
| `DISPATCHED` | `EXECUTING`, `TIMEOUT`    |
| `EXECUTING`  | `SUCCESS`, `FAILED`, `TIMEOUT` |
| `TIMEOUT`    | `QUEUED` (retry), `DEAD`  |

### Crash recovery

On ORK startup, the Command State Machine runs a recovery pass:

1. Read all non-terminal commands from Hyperbee (`cmd/pending/` index)
2. Commands in `DISPATCHED` or `EXECUTING` state → transition to `TIMEOUT`
   with `reason: "ork_crash_recovery"`
3. If `retries < maxRetries` → transition to `QUEUED` for re-dispatch
4. If `retries >= maxRetries` → transition to `DEAD`
5. Commands in `QUEUED` state → remain queued, picked up by Scheduler

Every transition (including crash recovery) is logged to the WAL
with full transition history preserved.

---

## 7. Capability Declaration

### 7.1 Structure

Capabilities are declared inside the `register` action payload.
They describe what a worker's devices can do.

```json
{
  "capabilities": {
    "telemetry": [
      { "name": "metric_name", "unit": "unit", "type": "number | string | boolean" }
    ],
    "commands": [
      { "name": "command_name", "params": [
        { "name": "param_name", "type": "type", "unit": "unit" }
      ]}
    ],
    "events": ["eventType1", "eventType2"],
    "config": {
      "readable": true,
      "writable": false
    },
    "health": true
  }
}
```

### 7.2 How ORK uses capabilities

- **Route validation:** ORK rejects `command.request` messages for
  commands the worker did not declare
- **Capability registry:** ORK maintains a live map of all capabilities
  across all registered workers
- **Discovery:** App Node can query the registry to learn what's
  available (`GET /devices`, `GET /plugins`)
- **UI rendering:** UI can dynamically render controls based on
  declared commands and telemetry fields

### 7.3 Example — read-only device (power meter)

A power meter that only publishes telemetry, no commands:

```json
{
  "capabilities": {
    "telemetry": [
      { "name": "voltage", "unit": "volts", "type": "number" },
      { "name": "current", "unit": "amps", "type": "number" },
      { "name": "activePower", "unit": "watts", "type": "number" },
      { "name": "powerFactor", "unit": "ratio", "type": "number" }
    ],
    "commands": [],
    "events": ["alert"],
    "config": {
      "readable": true,
      "writable": false
    },
    "health": true
  }
}
```

ORK will never send `command.request` to this worker because it
declared no commands. A generic dashboard consuming this worker
will render telemetry charts without offering control buttons.

---

## 8. Error Model

All error responses use this structure in the payload:

```json
{
  "status": "error",
  "data": null,
  "error": "Human-readable error message",
  "errorCode": "DEVICE_UNREACHABLE | COMMAND_NOT_SUPPORTED | VALIDATION_FAILED | TIMEOUT | INTERNAL_ERROR"
}
```

### Error codes (v0.0.1)

| Code                    | Meaning                                           |
|-------------------------|---------------------------------------------------|
| `DEVICE_UNREACHABLE`    | Worker cannot reach the physical device            |
| `COMMAND_NOT_SUPPORTED` | Command not in worker's declared capabilities      |
| `VALIDATION_FAILED`     | Payload failed schema validation                   |
| `TIMEOUT`               | Operation exceeded timeout window                  |
| `INTERNAL_ERROR`        | Unexpected error in worker or ORK                  |
| `WORKER_NOT_FOUND`      | Target worker not registered                       |
| `DEVICE_LOCKED`         | Device has an in-flight command (concurrency lock) |
| `QUEUE_FULL`            | Global command queue at capacity (backpressure)    |

---

## 9. Versioning and Compatibility

### Version format

Protocol versions follow `MAJOR.MINOR.PATCH`:

- **MAJOR:** Breaking changes to the envelope or core action semantics
- **MINOR:** New actions added, backward-compatible
- **PATCH:** Clarifications, documentation fixes, no behavioral change

### Compatibility rules

- A component implementing v0.0.1 MUST accept messages with
  `version: "0.0.1"`
- A component MAY accept messages with a higher MINOR version
  by ignoring unknown fields
- A component MUST reject messages with a different MAJOR version
- New actions added in MINOR versions MUST be optional — a worker
  that does not implement them simply never receives them

### Version negotiation

During `register`, the worker declares its protocol version.
ORK responds with its own version in `register.ack`.

If versions are incompatible (different MAJOR), ORK rejects the
registration with error code `PROTOCOL_VERSION_MISMATCH`.

---

## 10. Sender Identity Format

Sender and target identities follow this convention:

```text
{component}:{type}:{instance}

Examples:
  ork                                    — the orchestrator
  worker:whatsminer-m56s:rack-04         — a specific worker instance
  worker:antminer-s21:floor-2            — another worker
  worker:powermeter:main-panel           — a power meter worker
  appnode                                — the API gateway
  appnode:plugin:whatsminer              — a specific node plugin
```

Rules:
- `ork` is always a single identity (one ORK instance per deployment)
- Workers MUST include their type and a unique instance identifier
- Identity strings MUST only contain lowercase alphanumeric characters,
  hyphens, and colons

---

## 11. Implementation Notes

### Building a protocol-compliant worker

A worker that implements this protocol must:

1. On startup, send `register` to ORK with full capability declaration
2. Wait for `register.ack` before accepting commands
3. Periodically send `telemetry.publish` events for each device
4. Respond to `health.ping` with `health.pong`
5. When receiving `command.request`:
   a. Validate the command is in declared capabilities
   b. Execute on the physical device
   c. Send `command.result` with the outcome
6. On notable device events, send `event.publish`
7. On graceful shutdown, send `deregister`

### Building a Node Plugin

A Node Plugin does NOT implement the protocol directly.
It communicates with ORK via the App Node's HRPC client, which
wraps protocol messages. The plugin only needs to:

1. Declare its routes and capabilities
2. Use `orkClient.sendCommand()` to issue commands
3. Use `orkClient.subscribeTelemetry()` to receive events
4. The App Node handles protocol envelope construction

---

## 12. Future Considerations (v0.1)

The following features are being considered for v0.1 but are
explicitly excluded from v0.0.1 to keep the initial contract minimal:

- **Subscriptions:** `subscription.open` / `subscription.close` for
  persistent event streams between specific components
- **Queries:** `query.request` / `query.response` for on-demand
  state queries (distinct from commands)
- **State sync:** `state.sync` for reconciling device state after
  extended worker disconnection
- **Config management:** `config.read` / `config.write` for
  device configuration changes as first-class protocol actions
- **Authorization context:** Per-message authorization tokens
  for fine-grained access control

These will be added once v0.0.1 is validated against real device
libraries in production.
```
