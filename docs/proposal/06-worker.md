

# `06-workers.md` — Workers: Contract, Capabilities & Device Integration

# Workers

## 1. What Is a Worker?

A worker is the bridge between ORK and a physical device (or class of
devices). It wraps a device library and exposes it to the system through
the MDK protocol.

Workers have one job: **translate protocol messages into device-specific
operations, and device responses back into protocol messages.**

ORK never talks directly to a device. ORK talks to workers. Workers talk
to devices.

```text
    ORK                    Worker                  Device
     │                       │                       │
     │  command.request      │                       │
     │ ───────────────────►  │                       │
     │                       │  device-specific API  │
     │                       │ ───────────────────►  │
     │                       │                       │
     │                       │  device response      │
     │                       │ ◄───────────────────  │
     │  command.result       │                       │
     │ ◄───────────────────  │                       │
```

## 2. Worker Lifecycle

Every worker goes through the same lifecycle, regardless of what device
type it manages.

```text
  ┌─────────┐
  │  INIT   │  Process starts, loads device lib
  └────┬────┘
       │ open HRPC channel (multi-process) or register in-process
       ▼
  ┌──────────┐
  │ REGISTER │  Sends identity.register + capability.declare to ORK
  └────┬─────┘
       │ ORK acknowledges registration
       ▼
  ┌─────────┐
  │  READY  │◄─────────────────────────────┐
  └────┬────┘                              │
       │ receives command from ORK         │ command complete
       ▼                                   │
  ┌─────────┐                              │
  │  BUSY   │──────────────────────────────┘
  └────┬────┘
       │ health check fails / crash / unresponsive
       ▼
  ┌─────────┐
  │  SICK   │  Health Monitor marks unhealthy (missed pings)
  └────┬────┘
       │ exceeds missed-ping threshold
       ▼
  ┌─────────┐
  │  DEAD   │  Fault Supervisor opens circuit breaker
  └────┬────┘
       │ process restarted by PM2 / Docker / ORK
       ▼
  ┌─────────┐
  │  INIT   │  (cycle repeats)
  └─────────┘
```

### Key rules

- Workers **self-register** on startup. ORK never "discovers" workers —
  workers announce themselves.
- A worker that loses its ORK connection must **re-register** when the
  connection is restored.
- ORK does not assume any worker exists until it receives
  `identity.register`.

---

## 3. Worker Contract

Every worker must implement the following contract. This is the interface
between a worker and ORK — it is the same whether the worker runs
in-process or as a separate container.

### 3.1 Required protocol messages

| Message | Direction | When |
|---|---|---|
| `identity.register` | Worker → ORK | On startup / reconnection |
| `capability.declare` | Worker → ORK | Immediately after registration |
| `command.request` | ORK → Worker | When ORK dispatches a command |
| `command.result` | Worker → ORK | When the command completes (success, failure, or partial) |
| `telemetry.publish` | Worker → ORK | Periodically, based on scheduler or push interval |
| `event.publish` | Worker → ORK | On state changes, alerts, errors |
| `healthCheck` (ping) | ORK → Worker | Periodic liveness probe |

### 3.2 Registration message

When a worker starts, it sends `identity.register` to ORK:

```json
{
  "version": "0.0.1",
  "type": "identity.register",
  "sender": "worker:whatsminer-m56s:rack-04",
  "target": "ork",
  "correlationId": "uuid-v4",
  "timestamp": 1711500000000,
  "payload": {
    "workerType": "whatsminer-worker",
    "processId": "pid-12345",
    "startedAt": 1711500000000
  }
}
```

Immediately followed by `capability.declare` (see Section 4).

### 3.3 Handling commands

When ORK sends a `command.request`, the worker must:

1. **Acknowledge** — send back an ack (transitions command to EXECUTING
   in ORK's state machine)
2. **Execute** — call the device lib with the appropriate action
3. **Respond** — send `command.result` with either success + result
   payload, or failure + error details

```javascript
// Pseudocode — what every worker does when it receives a command
async function handleCommand (message) {
  const { action, deviceId, params } = message.payload

  // 1. Ack — tell ORK we're working on it
  sendToOrk({
    type: 'command.ack',
    correlationId: message.correlationId
  })

  try {
    // 2. Execute — call the device lib
    const result = await deviceLib[action](deviceId, params)

    // 3. Respond — success
    sendToOrk({
      type: 'command.result',
      correlationId: message.correlationId,
      payload: { status: 'success', result }
    })
  } catch (err) {
    // 3. Respond — failure
    sendToOrk({
      type: 'command.result',
      correlationId: message.correlationId,
      payload: { status: 'failed', error: err.message }
    })
  }
}
```

### 3.4 Telemetry publishing

Workers push telemetry to ORK on a configured interval (e.g., every 30s).
The worker is responsible for polling the device and formatting the data
into a `telemetry.publish` message:

```json
{
  "version": "0.0.1",
  "type": "telemetry.publish",
  "sender": "worker:whatsminer-m56s:rack-04",
  "target": "ork",
  "correlationId": "uuid-v4",
  "timestamp": 1711640000000,
  "payload": {
    "deviceId": "WM001",
    "metrics": {
      "hashrate": { "value": 210, "unit": "TH/s" },
      "temperature": { "value": 67, "unit": "celsius" },
      "fanSpeed": { "value": 4200, "unit": "rpm" },
      "powerConsumption": { "value": 3150, "unit": "watts" }
    }
  }
}
```

### 3.5 Event publishing

Workers emit events for state changes, alerts, and errors that are not
responses to commands:

```json
{
  "version": "0.0.1",
  "type": "event.publish",
  "sender": "worker:whatsminer-m56s:rack-04",
  "target": "ork",
  "correlationId": "uuid-v4",
  "timestamp": 1711640030000,
  "payload": {
    "deviceId": "WM001",
    "eventType": "alert",
    "severity": "warning",
    "details": {
      "message": "Temperature exceeds threshold",
      "temperature": 85,
      "threshold": 80
    }
  }
}
```

### 3.6 Health check response

ORK's Health Monitor pings workers periodically. Workers must respond
within the configured timeout (default: 3000ms):

```javascript
// Worker-side health check handler
async function handlePing () {
  return {
    status: 'ok',
    uptime: process.uptime(),
    devicesManaged: deviceList.length,
    memoryUsage: process.memoryUsage().heapUsed
  }
}
```

## 4. Capability Declaration

This is how ORK knows what a worker (and its devices) can do — without
ORK having any built-in knowledge of device types.

### 4.1 How it works

After registration, every worker sends a `capability.declare` message.
This message tells ORK:

- What type of entity this worker manages
- What telemetry it produces
- What commands it accepts
- What events it can emit

ORK stores this in the **Worker Registry** and uses it to:

- Route commands only to workers that support them
- Validate actions before dispatching
- Expose available capabilities to the App Node (and therefore to the UI
  and any external consumer)

### 4.2 Capability declaration format

```json
{
  "version": "0.0.1",
  "type": "capability.declare",
  "sender": "worker:whatsminer-m56s:rack-04",
  "target": "ork",
  "correlationId": "uuid-v4",
  "timestamp": 1711500000100,
  "payload": {
    "capabilities": [
      "telemetry.publish",
      "event.publish",
      "health.read",
      "command.execute",
      "config.read",
      "config.write"
    ],
    "telemetrySchema": {
      "hashrate": { "unit": "TH/s", "type": "number" },
      "temperature": { "unit": "celsius", "type": "number" },
      "powerConsumption": { "unit": "watts", "type": "number" },
      "fanSpeed": { "unit": "rpm", "type": "number" },
      "chipFrequency": { "unit": "MHz", "type": "number" }
    },
    "commands": [
      "reboot",
      "setFrequency",
      "setPowerLimit",
      "switchPool",
      "setFanSpeed"
    ],
    "devices": [
      { "id": "WM001", "model": "M56S", "ip": "192.168.1.100" },
      { "id": "WM002", "model": "M56S", "ip": "192.168.1.101" },
      { "id": "WM003", "model": "M56S+", "ip": "192.168.1.102" }
    ],
    "metadata": {
      "deviceType": "miner",
      "manufacturer": "Whatsminer",
      "models": ["M56S", "M56S+"]
    }
  }
}
```

### 4.3 Capability categories

| Capability | Meaning |
|---|---|
| `telemetry.publish` | Worker produces periodic telemetry data |
| `event.publish` | Worker produces system events (alerts, state changes) |
| `health.read` | Worker supports health/liveness queries |
| `command.execute` | Worker accepts commands for its devices |
| `config.read` | Worker can read device configuration |
| `config.write` | Worker can modify device configuration |

### 4.4 What happens when capabilities differ

Not all devices support the same operations. The capability model handles
this naturally:

**Full-featured ASIC miner:**
```json
{
  "capabilities": [
    "telemetry.publish", "event.publish", "health.read",
    "command.execute", "config.read", "config.write"
  ],
  "commands": ["reboot", "setFrequency", "setPowerLimit", "switchPool", "setFanSpeed"]
}
```

**Read-only power meter:**
```json
{
  "capabilities": [
    "telemetry.publish", "event.publish", "health.read",
    "config.read"
  ],
  "commands": []
}
```

**Temperature/humidity sensor:**
```json
{
  "capabilities": [
    "telemetry.publish", "health.read"
  ],
  "commands": []
}
```

ORK adapts automatically:
- It will never dispatch a `command.request` to a worker that didn't
  declare `command.execute`
- The App Node (via Node Plugins) can query the capability registry to
  render UI controls only for devices that support them
- An AI agent querying `GET /plugins` or `GET /devices` gets accurate
  capability information — no guessing

---

## 5. Wrapping Existing Device Libraries

MDK already has device libraries for several miner brands. Those libraries
don't need to be rewritten. They need to be **wrapped** inside a worker
that speaks the MDK protocol.

### 5.1 The wrapper pattern

```text
┌───────────────────────────────────────────────┐
│                  WORKER                        │
│                                                │
│   ┌───────────────────────────────────────┐   │
│   │         Protocol Handler              │   │
│   │                                       │   │
│   │  - Receives protocol messages         │   │
│   │  - Sends protocol responses           │   │
│   │  - Manages registration lifecycle     │   │
│   │  - Handles health checks              │   │
│   └───────────────┬───────────────────────┘   │
│                   │                            │
│                   │ translate action → lib call │
│                   ▼                            │
│   ┌───────────────────────────────────────┐   │
│   │         Device Library                │   │
│   │         (existing code)               │   │
│   │                                       │   │
│   │  - WM_M56S, AM_S21, etc.             │   │
│   │  - registerMiner()                    │   │
│   │  - connectToDevice()                  │   │
│   │  - getStats()                         │   │
│   │  - reboot()                           │   │
│   │  - setFanSpeed()                      │   │
│   └───────────────────────────────────────┘   │
│                                                │
└───────────────────────────────────────────────┘
```

### 5.2 Implementation skeleton

```javascript
// workers/whatsminer-worker.js
const { WorkerBase } = require('@tetherto/mdk/worker')
const MDK = require('@tetherto/mdk')

class WhatsminerWorker extends WorkerBase {
  constructor (config) {
    super({
      name: 'whatsminer-worker',
      sender: `worker:whatsminer:${config.rackId || 'default'}`
    })

    this.devices = new Map()
    this.config = config
  }

  // --- Lifecycle ---

  async onInit () {
    // Initialize device lib instances for each configured device
    for (const device of this.config.devices) {
      const lib = new MDK.WM_M56S()
      const miner = lib.registerMiner({
        ip: device.ip,
        port: device.port,
        serialNumber: device.serialNumber
      })
      await miner.connectToDevice()
      this.devices.set(device.id, { lib, miner, config: device })
    }
  }

  // --- Capability declaration ---

  getCapabilities () {
    return {
      capabilities: [
        'telemetry.publish',
        'event.publish',
        'health.read',
        'command.execute',
        'config.read',
        'config.write'
      ],
      telemetrySchema: {
        hashrate: { unit: 'TH/s', type: 'number' },
        temperature: { unit: 'celsius', type: 'number' },
        powerConsumption: { unit: 'watts', type: 'number' },
        fanSpeed: { unit: 'rpm', type: 'number' }
      },
      commands: ['reboot', 'setFanSpeed', 'setFrequency', 'switchPool'],
      devices: Array.from(this.devices.entries()).map(([id, d]) => ({
        id,
        model: 'M56S',
        ip: d.config.ip
      })),
      metadata: {
        deviceType: 'miner',
        manufacturer: 'Whatsminer',
        models: ['M56S']
      }
    }
  }

  // --- Command handling ---

  async onCommand (message) {
    const { action, deviceId, params } = message.payload
    const device = this.devices.get(deviceId)

    if (!device) {
      throw new Error(`Device ${deviceId} not found in this worker`)
    }

    switch (action) {
      case 'getStats':
        return await device.miner.getStats()

      case 'reboot':
        return await device.miner.reboot()

      case 'setFanSpeed':
        return await device.miner.setFanSpeed(params.speed)

      case 'setFrequency':
        return await device.miner.setFrequency(params.frequency)

      case 'switchPool':
        return await device.miner.switchPool(params.pool)

      default:
        throw new Error(`Unsupported action: ${action}`)
    }
  }

  // --- Telemetry collection ---

  async collectTelemetry () {
    const readings = []

    for (const [deviceId, device] of this.devices) {
      try {
        const stats = await device.miner.getStats()
        readings.push({
          deviceId,
          metrics: {
            hashrate: { value: stats.hashrate, unit: 'TH/s' },
            temperature: { value: stats.temperature, unit: 'celsius' },
            powerConsumption: { value: stats.power, unit: 'watts' },
            fanSpeed: { value: stats.fanSpeed, unit: 'rpm' }
          }
        })
      } catch (err) {
        this.emitEvent({
          deviceId,
          eventType: 'error',
          severity: 'warning',
          details: { message: `Telemetry collection failed: ${err.message}` }
        })
      }
    }

    return readings
  }
}

module.exports = WhatsminerWorker
```

### 5.3 WorkerBase class

The `WorkerBase` class handles all protocol boilerplate so that device
workers only need to implement the device-specific parts:

```javascript
// mdk/worker/worker-base.js
class WorkerBase {
  constructor (opts) {
    this.name = opts.name
    this.sender = opts.sender
  }

  // --- Called by MDK runtime ---

  async start (orkConnection) {
    this.ork = orkConnection

    // 1. Initialize device libs
    await this.onInit()

    // 2. Register with ORK
    await this.ork.send({
      type: 'identity.register',
      sender: this.sender,
      target: 'ork',
      payload: {
        workerType: this.name,
        processId: process.pid,
        startedAt: Date.now()
      }
    })

    // 3. Declare capabilities
    await this.ork.send({
      type: 'capability.declare',
      sender: this.sender,
      target: 'ork',
      payload: this.getCapabilities()
    })

    // 4. Start listening for commands
    this.ork.on('command.request', (msg) => this._handleCommand(msg))

    // 5. Start telemetry loop
    this._startTelemetryLoop()
  }

  async _handleCommand (message) {
    // Send ack
    this.ork.send({
      type: 'command.ack',
      correlationId: message.correlationId,
      sender: this.sender,
      target: 'ork'
    })

    try {
      const result = await this.onCommand(message)
      this.ork.send({
        type: 'command.result',
        correlationId: message.correlationId,
        sender: this.sender,
        target: 'ork',
        payload: { status: 'success', result }
      })
    } catch (err) {
      this.ork.send({
        type: 'command.result',
        correlationId: message.correlationId,
        sender: this.sender,
        target: 'ork',
        payload: { status: 'failed', error: err.message }
      })
    }
  }

  _startTelemetryLoop () {
    setInterval(async () => {
      try {
        const readings = await this.collectTelemetry()
        for (const reading of readings) {
          this.ork.send({
            type: 'telemetry.publish',
            sender: this.sender,
            target: 'ork',
            payload: reading
          })
        }
      } catch (err) {
        console.error(`[${this.name}] Telemetry loop error:`, err.message)
      }
    }, 30000) // configurable
  }

  emitEvent (eventPayload) {
    this.ork.send({
      type: 'event.publish',
      sender: this.sender,
      target: 'ork',
      payload: eventPayload
    })
  }

  // --- Must be implemented by subclass ---

  async onInit () {
    throw new Error('onInit() must be implemented')
  }

  getCapabilities () {
    throw new Error('getCapabilities() must be implemented')
  }

  async onCommand (message) {
    throw new Error('onCommand() must be implemented')
  }

  async collectTelemetry () {
    throw new Error('collectTelemetry() must be implemented')
  }
}

module.exports = { WorkerBase }
```

---

## 6. Multi-Device Workers

A single worker process can manage **multiple devices** of the same type.
This is the expected pattern for rack-level or site-level deployments.

```text
  ┌──────────────────────────────────────────┐
  │         Whatsminer Worker                 │
  │         (one process)                    │
  │                                          │
  │   ┌──────┐  ┌──────┐  ┌──────┐         │
  │   │WM001 │  │WM002 │  │WM003 │  ...    │
  │   │M56S  │  │M56S  │  │M56S+ │         │
  │   └──┬───┘  └──┬───┘  └──┬───┘         │
  │      │         │         │               │
  └──────┼─────────┼─────────┼───────────────┘
         │         │         │
         ▼         ▼         ▼
      Physical  Physical  Physical
      Device    Device    Device
```

The capability declaration includes a `devices` array listing all devices
managed by this worker instance. ORK uses this to route commands to the
correct worker based on `deviceId`.

### Scaling pattern

| Scale | Worker Layout |
|---|---|
| Home miner (1–5 devices) | One worker, all devices |
| Small site (10–50 devices) | One worker per device type |
| Medium site (50–500 devices) | Multiple workers per type, split by rack |
| Large site (500+ devices) | Worker per rack or cluster, separate processes |

Workers are stateless from ORK's perspective — if a worker crashes and
restarts, it re-registers and ORK rebuilds its view of that worker's
devices from the new capability declaration. No persistent state is
needed in the worker itself.

---

## 7. Transport Independence

Workers don't need to know how they're connected to ORK. The `WorkerBase`
class abstracts the transport:

| Mode | Transport | Worker Perspective |
|---|---|---|
| **Single-process** | Direct function calls | `this.ork.send()` calls a function |
| **Multi-process** | HRPC over network | `this.ork.send()` calls an RPC method |

The protocol messages are identical in both cases. A worker developed and
tested in single-process mode works in multi-process mode without any
code changes.

---

## 8. Worker Configuration

Workers are configured via `mdk.config.json`:

```json
{
  "ork": {
    "workers": [
      {
        "type": "whatsminer-worker",
        "instances": 2,
        "config": {
          "rackId": "rack-04",
          "devices": [
            { "id": "WM001", "ip": "192.168.1.100", "port": 8080, "serialNumber": "WM001" },
            { "id": "WM002", "ip": "192.168.1.101", "port": 8080, "serialNumber": "WM002" }
          ],
          "telemetryIntervalMs": 30000
        }
      },
      {
        "type": "antminer-worker",
        "instances": 1,
        "config": {
          "rackId": "rack-05",
          "devices": [
            { "id": "AM001", "ip": "192.168.2.100", "port": 4028, "serialNumber": "AM001" }
          ]
        }
      },
      {
        "type": "powermeter-worker",
        "instances": 1,
        "config": {
          "devices": [
            { "id": "PM001", "ip": "192.168.3.100", "port": 502, "serialNumber": "PM001" }
          ]
        }
      }
    ]
  }
}
```

---

## 9. Summary

| Concept | Description |
|---|---|
| **What** | Workers are protocol adapters between ORK and physical devices |
| **Contract** | Register → Declare capabilities → Handle commands → Publish telemetry/events → Respond to health checks |
| **Capability model** | Workers declare what they can do; ORK adapts dynamically |
| **Existing libs** | Wrapped inside workers using `WorkerBase` — no rewrites needed |
| **Scaling** | One worker can manage many devices; multiple workers can run in parallel |
| **Transport** | Same code runs in-process or over HRPC — only config changes |
| **State** | Workers are stateless from ORK's view; re-registration rebuilds everything |
```

