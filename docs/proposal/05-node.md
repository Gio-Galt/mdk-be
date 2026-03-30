

## `05-node.md`
# MDK Architecture Proposal — Node

## What the Node Is

The Node is MDK's **outward-facing API layer**. It's what consumers
talk to — UIs, AI agents, CLIs, third-party systems. Everything that
wants to interact with the mining infrastructure goes through the Node.

```text
 ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
 │  MDK UI Kit │  │  Custom UI  │  │  AI Agent   │  │  CLI / SDK  │
 └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
        │                │                │                 │
        └────────────────┴───────┬────────┴─────────────────┘
                                 │  REST / WebSocket
                                 ▼
                    ┌────────────────────────┐
                    │         NODE           │
                    └────────────┬───────────┘
                                 │  MDK Protocol (HRPC / in-process)
                                 ▼
                    ┌────────────────────────┐
                    │         ORK            │
                    └────────────────────────┘
```

## The Problem with the Current Design

Today, app-node has **built-in knowledge of device types**. When a
new device type is added, app-node must be modified to wire up its
routes. This means:

- Every new integration touches core code
- External companies can't add devices independently
- The API surface grows only when the core team ships a release
- AI agents face a static, centrally-defined API

## The Proposal: Node as Plugin Host

The Node becomes a **thin, generic API gateway** with a plugin slot
system. It has **zero built-in knowledge of any device type**.

Each integration provides a **Node Plugin** that snaps into the
gateway and registers its own routes, capabilities, and worker
bindings.

```text
┌──────────────────────────────────────────────────────────────┐
│                          NODE                                 │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  CORE (thin, generic, never changes)                    │ │
│  │                                                          │ │
│  │  • HTTP server                                          │ │
│  │  • Auth middleware                                       │ │
│  │  • Plugin loader                                        │ │
│  │  • HRPC client to ORK                                   │ │
│  │  • WebSocket event relay                                │ │
│  │                                                          │ │
│  │  Built-in routes (minimal):                             │ │
│  │    GET  /health                                         │ │
│  │    GET  /plugins          ← discover loaded plugins     │ │
│  │    GET  /devices          ← aggregate all devices       │ │
│  │    GET  /system/stats     ← ORK status, queue depth     │ │
│  └──────────────────────────┬──────────────────────────────┘ │
│                              │                                │
│                              │ plugin.register(app, context)  │
│                              ▼                                │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  PLUGIN SLOTS                                           │ │
│  │                                                          │ │
│  │  ┌────────────────┐  ┌────────────────┐                 │ │
│  │  │  whatsminer     │  │  antminer      │                 │ │
│  │  │  plugin         │  │  plugin        │                 │ │
│  │  │                 │  │                │                 │ │
│  │  │  GET /wm/...    │  │  GET /am/...   │                 │ │
│  │  │  POST /wm/...   │  │  POST /am/...  │                 │ │
│  │  │  WS /wm/events  │  │  WS /am/events │                 │ │
│  │  └────────┬────────┘  └────────┬───────┘                 │ │
│  │           │                    │                          │ │
│  │  ┌────────┴────────┐  ┌───────┴────────┐                │ │
│  │  │  powermeter      │  │  custom        │                │ │
│  │  │  plugin          │  │  plugin        │  ← any company │ │
│  │  │                  │  │                │    can add this │ │
│  │  │  GET /pm/...     │  │  GET /xyz/...  │                │ │
│  │  └─────────────────┘  └────────────────┘                 │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## Plugin Interface

Every Node Plugin implements the same contract:

```text
┌─────────────────────────────────────────┐
│           NODE PLUGIN CONTRACT           │
│                                          │
│  name         unique identifier          │
│  version      semver                     │
│  prefix       route namespace (/wm, /am) │
│  workerType   matching worker in ORK     │
│  capabilities list of supported actions  │
│                                          │
│  register(app, context)                  │
│    → registers routes on the HTTP server │
│    → gets access to ORK client           │
│    → gets access to auth middleware      │
│                                          │
│  manifest()                              │
│    → returns plugin metadata             │
│    → used by GET /plugins for discovery  │
└─────────────────────────────────────────┘
```

### Plugin Interface Definition

```javascript
class NodePluginBase {
  constructor (opts = {}) {
    this.name = opts.name           // 'whatsminer'
    this.version = opts.version     // '1.0.0'
    this.prefix = opts.prefix       // '/wm'
    this.workerType = opts.workerType // 'whatsminer-worker'
    this.capabilities = opts.capabilities || []
  }

  /**
   * Called by the Node plugin loader.
   *
   * @param {Object} app      — HTTP server instance
   * @param {Object} context  — Shared context:
   *   context.orkClient      — HRPC client to ORK
   *   context.pluginRegistry — Registry of loaded plugins
   *   context.auth           — Auth middleware
   */
  async register (app, context) {
    throw new Error('register() must be implemented by plugin')
  }

  manifest () {
    return {
      name: this.name,
      version: this.version,
      prefix: this.prefix,
      workerType: this.workerType,
      capabilities: this.capabilities
    }
  }
}
```

## Example: Whatsminer Node Plugin

```javascript
class WhatsminerNodePlugin extends NodePluginBase {
  constructor () {
    super({
      name: 'whatsminer',
      version: '1.0.0',
      prefix: '/wm',
      workerType: 'whatsminer-worker',
      capabilities: [
        'getStats', 'reboot', 'setFanSpeed',
        'setFrequency', 'getPools', 'setPools'
      ]
    })
  }

  async register (app, { orkClient, auth }) {
    const prefix = this.prefix
    const workerType = this.workerType

    // List devices managed by this plugin
    app.get(`${prefix}/devices`, { preHandler: auth },
      async (req, reply) => {
        return orkClient.getDevicesByWorkerType(workerType)
      }
    )

    // Get stats for a specific device
    app.get(`${prefix}/:deviceId/stats`, { preHandler: auth },
      async (req, reply) => {
        return orkClient.sendCommand({
          workerType,
          deviceId: req.params.deviceId,
          action: 'getStats'
        })
      }
    )

    // Reboot a device
    app.post(`${prefix}/:deviceId/reboot`, { preHandler: auth },
      async (req, reply) => {
        return orkClient.sendCommand({
          workerType,
          deviceId: req.params.deviceId,
          action: 'reboot'
        })
      }
    )

    // Whatsminer-specific: set fan speed
    app.post(`${prefix}/:deviceId/fan`, { preHandler: auth },
      async (req, reply) => {
        return orkClient.sendCommand({
          workerType,
          deviceId: req.params.deviceId,
          action: 'setFanSpeed',
          params: { speed: req.body.speed }
        })
      }
    )

    // Real-time event stream
    app.get(`${prefix}/events`, { websocket: true, preHandler: auth },
      (connection) => {
        orkClient.subscribeTelemetry(workerType, (event) => {
          connection.socket.send(JSON.stringify(event))
        })
      }
    )
  }
}
```

---

## Plugin Loading

The Node loads plugins from configuration at startup:

```json
{
  "appNode": {
    "port": 3000,
    "plugins": [
      "@tetherto/mdk-plugin-whatsminer",
      "@tetherto/mdk-plugin-antminer",
      "@tetherto/mdk-plugin-powermeter",
      "@acme-corp/mdk-plugin-custom-sensor"
    ]
  }
}
```

### Loading Sequence

```text
1. Node starts
2. Reads plugin list from mdk.config.json
3. For each plugin:
   a. require() the module
   b. Call plugin.register(app, context)
      → Plugin registers its routes
      → Plugin gets ORK client access
   c. Store plugin manifest in Plugin Registry
4. Start HTTP server
5. All routes from all plugins are now live
```

### Node Core — Plugin Loader

```javascript
class AppNode {
  constructor (opts = {}) {
    this.app = Fastify(opts.fastify || {})
    this.orkClient = opts.orkClient
    this.plugins = []
    this.pluginRegistry = new Map()
  }

  async loadPlugin (PluginClass) {
    const plugin = new PluginClass()
    const context = {
      orkClient: this.orkClient,
      pluginRegistry: this.pluginRegistry,
      auth: this._authMiddleware()
    }

    await plugin.register(this.app, context)
    this.plugins.push(plugin)
    this.pluginRegistry.set(plugin.name, plugin.manifest())
  }

  async start (port = 3000) {
    // Core routes — always present, never change
    this.app.get('/health', async () => ({ status: 'ok' }))

    this.app.get('/plugins', async () => {
      return Array.from(this.pluginRegistry.values())
    })

    this.app.get('/devices', async () => {
      const allDevices = []
      for (const [name, manifest] of this.pluginRegistry) {
        const devices = await this.orkClient
          .getDevicesByWorkerType(manifest.workerType)
        allDevices.push(
          ...devices.map(d => ({ ...d, plugin: name }))
        )
      }
      return allDevices
    })

    await this.app.listen({ port })
  }
}
```

---

## Discovery

The Node is **self-describing**. Any consumer can learn what's
available at runtime:

```text
GET /plugins

Response:
[
  {
    "name": "whatsminer",
    "version": "1.0.0",
    "prefix": "/wm",
    "workerType": "whatsminer-worker",
    "capabilities": ["getStats", "reboot", "setFanSpeed", ...]
  },
  {
    "name": "antminer",
    "version": "2.1.0",
    "prefix": "/am",
    "workerType": "antminer-worker",
    "capabilities": ["getStats", "reboot", "setFrequency", ...]
  },
  {
    "name": "powermeter",
    "version": "1.0.0",
    "prefix": "/pm",
    "workerType": "powermeter-worker",
    "capabilities": ["getStats"]
  }
]
```

```text
GET /devices

Response:
[
  { "id": "WM001", "plugin": "whatsminer", "model": "M56S", "status": "online" },
  { "id": "AM015", "plugin": "antminer", "model": "S21", "status": "online" },
  { "id": "PM003", "plugin": "powermeter", "model": "PM-100", "status": "online" }
]
```

This is what makes the system **AI-agent friendly** — an agent
doesn't need hardcoded knowledge of device types. It calls
`GET /plugins`, learns what's possible, and acts accordingly.

---

## Communication: Node → ORK

Every plugin communicates with ORK through the **MDK Protocol**.
The plugin doesn't talk to workers directly — it sends protocol
messages to ORK, which handles routing, validation, concurrency,
and lifecycle.

```text
Plugin                     ORK                      Worker
  │                         │                         │
  │  orkClient.sendCommand  │                         │
  │  {                      │                         │
  │    workerType: 'wm',   │                         │
  │    deviceId: 'WM001',  │                         │
  │    action: 'reboot'    │                         │
  │  }                      │                         │
  │ ───────────────────────►│                         │
  │    MDK Protocol msg     │  Validate, queue,       │
  │    (HRPC or in-process) │  dispatch                │
  │                         │ ───────────────────────►│
  │                         │   MDK Protocol msg      │
  │                         │   (HRPC or in-process)  │
  │                         │                         │
  │                         │◄────────────────────────│
  │                         │   Result                │
  │◄────────────────────────│                         │
  │   Result                │                         │
```

The plugin never knows or cares:
- Which specific worker instance handles the command
- Whether the worker is in-process or a separate container
- How ORK manages concurrency or retries
- What transport carries the message

The plugin only knows the **MDK Protocol contract**.

---

## Key Design Decisions

> **Mark these for feedback — challenge any of them.**

| Decision | Choice | Why |
|---|---|---|
| Plugin loading | Config-driven (`mdk.config.json`) | Explicit, predictable, debuggable |
| Plugin isolation | In-process (shared server) | Performance, simplicity for v1 |
| Route namespacing | Plugin-owned prefix (`/wm`, `/am`) | No route collisions between plugins |
| Discovery | `GET /plugins` returns manifests | Self-describing API for AI/UI/CLI |
| Auth | Shared middleware injected via context | Consistent auth across all plugins |
| Plugin ↔ ORK | Via ORK client (MDK Protocol) | Plugins never talk to workers directly |

---

## What This Enables

| Before | After |
|---|---|
| Adding a device = modify Node core | Adding a device = install a plugin |
| API surface controlled by core team | API surface controlled by plugin authors |
| Static, centrally-defined capabilities | Dynamic discovery via `GET /plugins` |
| AI agents need hardcoded device knowledge | AI agents discover capabilities at runtime |
| One release cycle for everything | Independent plugin release cycles |

---

## Open Questions — Leave Your Feedback

> Comment directly on the PR or use these markers:
> ✅ Agree  ❌ Disagree  ❓ Unsure  💡 Idea

1. **Plugin isolation** — Should plugins run in-process (shared
   server) or sandboxed? In-process is simpler but a bad plugin
   can crash the Node.

2. **Plugin validation** — Should the Node validate plugin
   manifests on load? (e.g., reject if required fields missing,
   check capability format)

3. **Hot reloading** — Should we support loading/unloading
   plugins without restarting the Node? Or is restart acceptable?

4. **Route conflicts** — What happens if two plugins try to
   register the same prefix? First-wins? Error? Configurable?

5. **Plugin versioning** — How do we handle breaking changes in
   the plugin interface? Semver on the contract? Version field
   in manifests?

6. **WebSocket strategy** — One WebSocket per plugin
   (`/wm/events`, `/am/events`) or a single multiplexed
   WebSocket (`/events` with type filtering)?

7. **Aggregation endpoints** — `GET /devices` aggregates across
   plugins. What other cross-plugin queries should the Node
   support natively?
```

---

That's the Node doc. It covers the plugin host model, the interface contract, discovery, communication flow to ORK, and specific open questions for your team to react to.

Want me to move to `03-ork.md`?