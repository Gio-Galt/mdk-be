# MDK POC — Developer & AI Context Guide

> **Purpose:** Complete knowledge dump for any developer or AI agent picking up work on this codebase. Read this before touching any file.

---

## 1. What this repo is

This is a **proof-of-concept** for the MDK (Mining Development Kit) agentic framework. It demonstrates a full end-to-end pipeline:

```
User prompt
  → AI Agent (LLM intent resolution or regex heuristic)
  → MCP tool calls  
  → App Node (JWT/RBAC gateway)
  → ORK Kernel (orchestration, routing, scheduling)
  → Workers (device-specific HTTP pull servers)
  → Physical devices (simulated with mock data)
  → Contract-driven HTML UI rendered to the user
```

The codebase lives entirely in `mdk-be/poc/`. The rest of `mdk-be/` is documentation and sample code from earlier HLD work — it does not run.

---

## 2. Architecture layers

The HLD (`mdk-be/docs/hld.md`) defines five layers. This POC implements all of them:

```
Layer 1  Consumers          — Agent Studio web UI (chat interface)
Layer 2  App Node           — Fastify server, JWT auth, MCP tool surface
Layer 3  ORK Kernel         — WorkerRegistry, Scheduler, Collector, Dispatcher, Health Monitor
Layer 4  Workers            — MDK Protocol HTTP pull servers (one per device family)
Layer 5  Physical Devices   — Simulated in hardware.mjs with realistic jitter + state
```

### Ports (defaults, all configurable)

| Service | Port | File |
|---|---|---|
| Agent Studio (App Node) | 3847 | `agentic-studio/server.mjs` |
| ORK Kernel | 3848 | `ork/src/index.mjs` |
| Miner Worker | 3850 | `workers/miner-worker/src/index.mjs` |
| Powermeter Worker | 3851 | `workers/powermeter-worker/src/index.mjs` |

### Startup order (critical)

ORK must start before workers. Workers announce to ORK on startup. App Node connects to ORK at request time. In single-process mode (`start.mjs`), this ordering is enforced programmatically.

---

## 3. File map

```
poc/
├── start.mjs                           Single-process launcher (all 4 layers)
├── agentic-end-to-end-poc.mjs          CLI entry point (stub/demo mode only)
├── .env.example                        All env vars with docs — copy to .env
├── .env                                Local secrets (gitignored, never commit)
├── .gitignore                          Excludes .env, generated/, node_modules/
├── README.md                           Operational guide (how to run, smoke tests)
├── DEVELOPER_GUIDE.md                  ← this file
│
├── lib/
│   ├── load-env.mjs                    Zero-dep .env loader (side-effect import)
│   ├── agentic-core.mjs                Agent pipeline + Live/Stub ORK clients + App Node
│   ├── llm-interpreter.mjs             LLM intent → structured plan (OpenAI / Anthropic)
│   └── ui-renderer.mjs                 Contract-driven HTML generator (6 visualization types)
│
├── ork/
│   └── src/index.mjs                   ORK Kernel (all 5 modules in one file)
│
├── workers/
│   ├── mdk-worker-base/
│   │   └── src/MDKWorkerBase.mjs       Base class: HTTP MDK Protocol server
│   ├── miner-worker/
│   │   ├── mdk-contract.json           Capability schema for Whatsminer miners
│   │   └── src/
│   │       ├── index.mjs               MinerWorker class + standalone bootstrap
│   │       ├── hardware.mjs            10 mock miner devices (MinerDevice class)
│   │       └── mapping.mjs             Raw CGMiner → MDK schema + health computation
│   └── powermeter-worker/
│       ├── mdk-contract.json           Capability schema for Schneider PM8000 meters
│       └── src/
│           ├── index.mjs               PowermeterWorker class + standalone bootstrap
│           ├── hardware.mjs            10 mock power meter devices (PowermeterDevice class)
│           └── mapping.mjs             Raw Modbus → MDK schema + health computation
│
├── agentic-studio/
│   ├── server.mjs                      Fastify App Node + auto ORK detection
│   ├── package.json                    Fastify + CORS + static deps
│   └── public/
│       ├── index.html                  Chat UI shell (tabs: Preview, Trace, Workers, Capabilities)
│       ├── app.js                      Frontend logic (fetch, render, tab management)
│       └── styles.css                  MDK dark theme
│
└── generated/
    └── agent-ui-latest.html            CLI output (gitignored)
```

---

## 4. MDK Protocol (transport simulation)

The real MDK uses Hyperswarm / HRPC. This POC simulates it with plain HTTP (Node built-in `http` module) so there are no external transport dependencies.

### Message envelope (all ORK→Worker calls)

```json
{
  "id":        "uuid-v4",
  "version":   "0.1.0",
  "type":      "request",
  "action":    "<action name>",
  "sender":    "ork:kernel:main",
  "timestamp": 1234567890000,
  "deviceId":  "wm001",       // present only for command.request
  "commandName": "reboot",    // present only for command.request
  "params":    {}             // present only for command.request
}
```

Worker response envelope:

```json
{
  "id":        "<same uuid>",
  "version":   "0.1.0",
  "type":      "response",
  "action":    "<same action>",
  "sender":    "worker:miner-worker:<workerId>",
  "target":    "ork:kernel:main",
  "timestamp": 1234567890001,
  "payload":   { ... }
}
```

### Supported actions

| Action | Payload (in) | Payload (out) | Cadence |
|---|---|---|---|
| `identity.request` | — | `{ workerId, workerType, protocolVersion, processId, startedAt, deviceIds[], deviceCount }` | once on announce |
| `capability.request` | — | `{ capabilities: {...}, metadata: {...} }` | once on announce |
| `health.ping` | — | `{ ok: true, ts, uptimeMs }` | every 5 s |
| `state.pull` | — | `{ workerState: "RUNNING", deviceIds[], ts }` | every 60 s (not yet scheduled) |
| `telemetry.pull` | — | `{ devices: [DeviceRow], ts }` | every 10 s |
| `command.request` | `{ deviceId, commandName, params }` | `{ success, deviceId, commandName, result, ts }` | on demand |

All calls go to `POST /mdk` on the worker's HTTP server.

### Worker discovery (DHT simulation)

1. Worker starts, binds its HTTP server.
2. Worker POSTs to `POST /announce` on ORK: `{ workerType, port, host }`.
3. ORK receives announcement, calls `identity.request` then `capability.request` on the worker.
4. ORK saves identity + capabilities to its `WorkerRegistry`.
5. On next scheduler tick, ORK calls `telemetry.pull` and starts `health.ping` loop.

---

## 5. Device row shape (the universal data contract)

Every layer that moves device data uses this shape consistently:

```typescript
interface DeviceRow {
  siteId:       string;           // "miner-worker" | "powermeter-worker" | "texas" | "iceland"
  workerType:   string;           // "miner-worker" | "powermeter-worker"
  deviceId:     string;           // "wm001" | "pm006" etc.
  metrics:      Record<string, number | boolean>;  // field names from mdk-contract.json telemetry
  healthStatus: "HEALTHY" | "WARNING" | "DEGRADED" | "CRITICAL" | "OFFLINE";
  activeAlerts: Array<{ code: string, msg: string }>;
  history:      Record<string, number[]>;  // rolling arrays (length 20) of past metric values
}
```

This shape flows from workers → ORK collector cache → MCP tool `get_fleet_telemetry` → `runAgentPipeline` → UI renderer.

---

## 6. `mdk-contract.json` — the source of truth

Every worker must ship an `mdk-contract.json`. It is:
- Sent to the LLM as full context for intent resolution
- Used by the UI renderer to discover which fields to display
- Validated against for command parameter bounds

### Schema

```json
{
  "$schema": "...",
  "metadata": {
    "provider": "microbt",
    "deviceFamily": "miner",
    "brand": "Whatsminer",
    "workerType": "miner-worker",
    "modelsSupported": ["M30S", "M50S", "M56S", "M60S"],
    "overview": "Natural language overview used as LLM system context."
  },
  "devices": [],
  "capabilities": {
    "telemetry": [
      {
        "name": "temperature_out",   // ← becomes a key in DeviceRow.metrics
        "unit": "C",
        "type": "number",
        "description": "..."         // ← injected verbatim into LLM system prompt
      }
    ],
    "commands": [
      {
        "name": "setPowerLimit",
        "description": "...",
        "constraints": "...",        // ← also injected into LLM prompt
        "params": [
          { "name": "limit_watts", "type": "number", "min": 2000, "max": 4000 }
        ]
      }
    ],
    "health": {
      "supportedStates": ["HEALTHY", "WARNING", "DEGRADED", "CRITICAL", "OFFLINE"],
      "alerts": ["alert.overheat", "alert.fan_failure"],
      "troubleshooting": ["..."]     // ← injected into LLM prompt
    },
    "errors": {
      "E_TEMP_HIGH": "..."
    }
  }
}
```

**Design principle:** `description`, `constraints`, and `troubleshooting` are simultaneously machine-readable JSON and AI reasoning context. They are not separate documents.

---

## 7. `lib/agentic-core.mjs` — the pipeline engine

This is the most important file. It is shared by the CLI, Agent Studio server, and `start.mjs`.

### Exports

```javascript
// Constants
DEFAULT_CONTRACT_PATH  // path to docs/mdk-contract.json
DEFAULT_ORK_URL        // "http://127.0.0.1:3848"

// Live ORK integration
class LiveOrkClient                          // HTTP client for real ORK
  .isAvailable()                             // → boolean (fast 600ms timeout)
  .getCapabilities()                         // → [{ workerId, workerType, siteId, capabilities, metadata }]
  .getFleetTelemetry()                       // → DeviceRow[]
  .getWorkers()                              // → worker registry entries
  .sendCommand(deviceId, commandName, params) // → command result

function createLiveMcpTools(live, traceFn)   // → MCP tool object (same shape as stub)
async function buildLiveWorld(live, trace)   // → { mcp, contractDocument }

// Stub (demo) mode
class OrkClientStub                          // in-memory, no network
class AppNodeGateway                         // connects OrkClientStubs by siteId
function createMcpTools(appNode, token, traceFn) // → MCP tool object
function buildDemoWorld(contractTemplate, trace) // → { app, mcp, agentToken, agent }

// Agent pipeline
async function runAgentPipeline(mcp, userPrompt, options)
  // options: { trace[], env, contractDocument }
  // returns: { html, message, mode, intent, llm, rows, commandResults, trace }

// Utilities  
function interpretPrompt(raw, capsMerged)    // heuristic fallback → Plan object
function mergeCapabilities(registrations)    // flatten multi-worker telemetry+commands
function outletTempCriticalC(capabilities)   // extract temperature threshold from contract description
function loadContract(contractPath?)         // → parsed JSON

// Scenario CLI
class StubAgent
  .scenarioGenerateReport()
  .scenarioTakeAction()
```

### MCP tool object shape (both stub and live implement this)

```javascript
{
  get_worker_capabilities()                           // → [{ siteId, capabilities, metadata }]
  list_devices()                                      // → [{ siteId, deviceId, workerType }]
  get_fleet_telemetry({ hours? })                     // → DeviceRow[]
  execute_device_command({ deviceId, command, params }) // → command result
}
```

### Plan object (output of intent resolution)

```typescript
interface Plan {
  intent:        "query" | "action";
  focus_fields:  string[];         // telemetry field names to highlight
  visualization: VisualizationType;
  filter:        FilterString;
  title:         string;
  command:       null | {
    name:   string;                // must exist in contract commands
    params: Record<string, any>;   // validated against contract param bounds
    target: "overheating" | "all" | `device:${string}`;
  };
  tempLimit:     number;           // extracted from contract (default 85)
}

type VisualizationType =
  "thermal_grid" | "fleet_summary" | "full_table" |
  "action_result" | "metric_focus" | "health_status";

type FilterString =
  "all" | "overheating" | "degraded" | "offline" | "healthy" |
  `site:${string}` | `device:${string}` | `worker:${string}`;
```

### `runAgentPipeline` — step by step

```
Step 1  get_worker_capabilities → merge telemetry + commands from all workers
Step 2  resolve intent:
          if OPENAI_API_KEY or ANTHROPIC_API_KEY set → interpretIntentWithLlm()
          else → interpretPrompt() (regex heuristic)
Step 3  list_devices() + get_fleet_telemetry()
Step 4  apply Plan.filter to rows
Step 4b narrow by focus_fields: if focus_fields is non-empty, keep only rows
        where at least one focus_field is present in metrics (non-null).
        This automatically scopes worker types — temperature_in only exists on
        miners, voltage_v only on powermeters. Falls back to all rows if nothing
        matches. A worker: prefix filter (e.g. "worker:miner-worker") can also
        explicitly scope to a single worker type.
Step 5  if intent === "action": dispatch Plan.command to up to 3 targeted devices
Step 6  buildNarrative(plan, rows, commandResults) → string
Step 7  renderPage({ plan, rows, contractDoc, commandResults, narrative }) → HTML string
return  { html, message, mode, intent, llm, rows, commandResults, trace }
```

---

## 8. `lib/llm-interpreter.mjs` — LLM intent resolution

### Provider detection

```javascript
detectProvider(env)
// checks MDK_LLM_PROVIDER (forced), then OPENAI_API_KEY, then ANTHROPIC_API_KEY
// returns: "openai" | "anthropic" | null
```

### What is sent to the LLM

```
System prompt:
  - Role definition (MDK operations agent)
  - Exact JSON output schema (intent, focus_fields, visualization, filter, title, command)
  - Rules: focus_fields MUST come from contract telemetry names, command MUST exist in contract
  - Visualization guide (when to use each type)

User message:
  - "User request: <prompt>"
  - "Context JSON: <{ mdk_contract_json, workers_registered[] }>"
```

The full `mdk-contract.json` (with all descriptions, constraints, troubleshooting) is sent as context. This grounds the LLM in exact field names, safety thresholds, and device-specific knowledge.

### Validation after LLM response

1. `intent` must be `"query"` or `"action"`
2. `visualization` must be one of the 6 known types
3. `focus_fields` filtered to only names that exist in contract telemetry
4. `command.name` must exist in contract commands (throws if not)
5. Command params validated against contract `min`/`max` bounds

### Model defaults

| Provider | Default model | Override env var |
|---|---|---|
| OpenAI | `gpt-4o-mini` | `OPENAI_MODEL` |
| Anthropic | `claude-3-5-haiku-20241022` | `ANTHROPIC_MODEL` |

OpenAI: uses `response_format: { type: "json_object" }` — guaranteed JSON output.  
Anthropic: parses text response (strips code fences before JSON.parse).

Both use `temperature: 0.1` for deterministic plan generation.

---

## 9. `lib/ui-renderer.mjs` — contract-driven HTML generation

Renders self-contained HTML pages (no external CSS/JS, fully inline). The output is injected into `<iframe srcdoc="...">` in the chat UI.

### `renderPage(options)` — main entry point

```javascript
renderPage({
  plan,             // Plan object
  rows,             // DeviceRow[] (filtered)
  contractDoc,      // full mdk-contract.json (used to discover field names)
  commandResults,   // array of command dispatch results
  narrative,        // string (used as top narrative bar)
  rationale,        // optional "openai/gpt-4o-mini" string
})
// → self-contained HTML string
```

### Visualization types and when to use

| Type | Trigger | Best for |
|---|---|---|
| `thermal_grid` | thermal/temp/fan/heat | Miner thermal state — gauge cards sorted by outlet temp |
| `fleet_summary` | report/boss/executive | KPI boxes, per-site table, alert list |
| `full_table` | dashboard/all/default | Sortable table of all devices × all telemetry fields |
| `metric_focus` | specific field queries | Horizontal bar chart sorted by a specific field |
| `health_status` | health/status/alert/online | Health badge board + alert log |
| `action_result` | action intent | Command dispatch result cards per targeted device |

### Visual primitives

```javascript
semiGauge(value, maxVal, { unit, warnPct=0.65, critPct=0.85 })
// SVG semicircle gauge. Green/yellow/red based on percentage thresholds.
// Used for temperature_out (0–100°C), power_draw, etc.

hbar(value, maxVal, { color, height })
// Thin horizontal progress bar. Used for fan speed, current, power.

sparkline(values[], width=64, height=20, color)
// Tiny SVG polyline for historical trend. Uses DeviceRow.history arrays.

statusBadge(status)
// HEALTHY=green | WARNING=yellow | DEGRADED=yellow | CRITICAL=red | OFFLINE=gray
// Styled pill with colored dot.

alertChip(code)
// Red monospace badge for alert codes like "E_TEMP_HIGH", "E_FAN_FAIL".
```

### Color palette (MDK dark theme)

```
--bg:       #0a0b0d   (page background)
--surface:  #10151e   (cards, narrative bar)
--elevated: #171d27   (raised cards)
--border:   #252e3c
--text:     #e6ecf3
--muted:    #8b98a8
--accent:   #f7931a   (Bitcoin orange — KPI values, accents)
--red:      #e85d4c   (critical)
--yellow:   #d4a017   (warning)
--green:    #3fb950   (healthy)
--blue:     #58a6ff   (field names, links)
```

### `buildNarrative(plan, rows, commandResults, tempLimit, contractMeta)`

Returns a human-readable summary string based on the plan and live data. Examples:
- `"Fleet: 19/20 online. 2 critical, 3 degraded. 5 active alerts."`
- `"Total fleet draw: 27.7 kW across 20 devices."`
- `"Issued setPowerLimit to 2 device(s). wm005: APPLIED."`

---

## 10. ORK Kernel — `ork/src/index.mjs`

Five internal modules, one HTTP API, one HTTP server. Exports `OrkKernel` for embedding.

### `OrkKernel` class

```javascript
const ork = new OrkKernel();
await ork.start(port);           // awaitable — returns after HTTP is bound

// Internal access (for single-process start.mjs)
ork.registry                     // WorkerRegistry instance
ork.collector.getAll()           // → DeviceRow[] (latest telemetry snapshot)
ork.scheduler.stop()             // stop all timers (used in graceful shutdown)
```

### WorkerRegistry

```javascript
registry.register(workerId, { host, port, workerType, identity, capabilities })
registry.resolveWorker(deviceId)    // → worker entry | null
registry.allWorkers()               // → all worker entries
registry.healthyWorkers()           // → workers where health !== "DEAD"
registry.setHealth(workerId, health) // "HEALTHY" | "SICK" | "DEAD"
registry.toJSON()                   // → API-friendly array
```

Worker entry shape:
```json
{
  "workerId":   "miner-worker-da1e4d10",
  "workerType": "miner-worker",
  "host":       "127.0.0.1",
  "port":       3850,
  "health":     "HEALTHY",
  "pingFails":  0,
  "identity":   { "deviceIds": ["wm001", ...], "deviceCount": 10, ... },
  "capabilities": { "capabilities": {...}, "metadata": {...} },
  "registeredAt": 1234567890000,
  "lastSeen":     1234567890001,
  "lastTelemetryAt": 1234567890002
}
```

### Health Monitor thresholds

```javascript
SICK_THRESHOLD = 2   // consecutive ping fails → SICK
DEAD_THRESHOLD = 5   // consecutive ping fails → DEAD
// ping interval: every 5s (via Scheduler)
```

### ORK HTTP API (called by App Node)

```
GET  /health          → { ok, service, uptimeMs, workers, devices, healthyWorkers }
GET  /workers         → { workers: WorkerEntry[] }
GET  /devices         → { devices: [{ deviceId, workerType, workerId, workerHealth }] }
GET  /telemetry       → { devices: DeviceRow[], ts }
GET  /capabilities    → { capabilities: [{ workerId, workerType, siteId, capabilities, metadata }] }
POST /command         → { deviceId, commandName, params } → command result
POST /announce        → { workerType, port, host } → triggers identity+capability pull
```

### Command validation in CommandDispatcher

Before sending `command.request` to a worker:
1. Looks up worker for `deviceId` via registry
2. Checks worker health is not `DEAD`
3. Validates `commandName` exists in `worker.capabilities.capabilities.commands[]`
4. Throws with descriptive error if any check fails

---

## 11. Worker base — `workers/mdk-worker-base/src/MDKWorkerBase.mjs`

### Constructor

```javascript
new MDKWorkerBase(workerType, contractPath, { port, orkUrl })
```

### `start()` method — sequence

1. `readFileSync(contractPath)` → `this.contract`
2. `this.onInit()` (abstract — populate `this.devices`)
3. `this._listen()` — bind HTTP server on `this.port`, returns Promise resolving when bound
4. `this._announce()` — POST to `orkUrl/announce`; warn-and-continue if ORK unreachable

### `POST /mdk` handler

Routes on `msg.action`:
- `identity.request` → return workerId, deviceIds[], etc.
- `capability.request` → return `this.contract.capabilities` + `this.contract.metadata`
- `health.ping` → `{ ok: true, ts, uptimeMs }`
- `state.pull` → `{ workerState: "RUNNING", deviceIds[] }`
- `telemetry.pull` → iterate `this.devices`, call `onTelemetryPull(deviceId)` for each
- `command.request` → call `onCommand(deviceId, commandName, params)`

### Abstract methods to implement

```javascript
async onInit()
// Populate this.devices = [{ deviceId, ...meta }]
// Called once during start(), before HTTP server binds.

async onTelemetryPull(deviceId)
// Return: { metrics: object, healthStatus: string, activeAlerts: object[], history: object }
// Called for every device on each telemetry.pull request.

async onCommand(deviceId, commandName, params)
// Execute the command against the physical device layer.
// Return: { ack: string, ...commandSpecificFields }
```

### `isMain` guard pattern

All worker entry points use this to prevent auto-start when imported:

```javascript
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // standalone bootstrap
}
```

Same pattern in `ork/src/index.mjs` and `agentic-studio/server.mjs`.

---

## 12. Miner Worker — `workers/miner-worker/`

### Devices (10 physical miners, wm001–wm010)

| DeviceId | Model | Scenario | health |
|---|---|---|---|
| wm001 | M60S | Top performer, 120 TH/s | HEALTHY |
| wm002 | M56S | Normal, 110 TH/s | HEALTHY |
| wm003 | M50S | Normal, 104 TH/s | HEALTHY |
| wm004 | M50S | Slightly warm ambient (42°C in) | HEALTHY |
| wm005 | M50S | Overheating (93°C outlet) | CRITICAL |
| wm006 | M30S | Inlet fan failure (1100 RPM) | DEGRADED |
| wm007 | M56S | Power-throttled (setPowerLimit applied) | HEALTHY |
| wm008 | M30S | Offline (hashrate=0, power=45W) | OFFLINE |
| wm009 | M50S | High temp warning (83°C) | WARNING |
| wm010 | M60S | Recovering from reboot (~60% back up) | HEALTHY |

### `MinerDevice` class (hardware.mjs)

Each device maintains:
- `state` — current values (mutated by commands)
- `_nom` — nominal spec (used for throttling ratios)
- `_history` — rolling arrays (length 20) for `hashrate_rt`, `temperature_out`, `power_draw`
- `_rebootUntil` — timestamp; during reboot, all values go to zero
- `_rebootPhase` — 0..10, recovery ramp after reboot completes

`_tick()` is called on every `getRaw()` call, adding jitter to all values.

### Command effects

```javascript
reboot:         sets _rebootUntil = now + 3min, zeros all metrics
setPowerLimit:  adjusts state.power_draw, proportionally scales hashrate + temp_out
setPools:       no state change, just logs
```

### Health computation (`mapping.mjs`)

```javascript
computeHealth(metrics) → { healthStatus, activeAlerts }
// OFFLINE:   hashrate_rt < 1 TH/s AND power_draw < 200W
// CRITICAL:  temperature_out > 90°C
// DEGRADED:  fan_speed_in < 2000 RPM OR fan_speed_out < 2000 RPM
// WARNING:   temperature_out > 85°C
// HEALTHY:   everything else
```

Telemetry fields (from contract):
`hashrate_rt`, `hashrate_avg`, `power_draw`, `temperature_in`, `temperature_out`, `fan_speed_in`, `fan_speed_out`

---

## 13. Powermeter Worker — `workers/powermeter-worker/`

### Devices (10 rack power meters, pm001–pm010)

| DeviceId | Rack | Scenario | health |
|---|---|---|---|
| pm001 | Rack-01 | Healthy, ~8 kW | HEALTHY |
| pm002 | Rack-02 | Healthy, ~9 kW | HEALTHY |
| pm003 | Rack-03 | Healthy, low load 6 miners | HEALTHY |
| pm004 | Rack-04 | Healthy, full rack 10 kW | HEALTHY |
| pm005 | Rack-05 | Near threshold (9.8 kW, limit 10 kW) | WARNING |
| pm006 | Rack-06 | Over threshold (11.2 kW, limit 10 kW) | CRITICAL |
| pm007 | Rack-07 | Circuit open (load shed) | DEGRADED |
| pm008 | Rack-08 | Overvoltage (248 V) | WARNING |
| pm009 | Rack-09 | Low power factor (0.83) | DEGRADED |
| pm010 | Rack-10 | New rack, low energy counter | HEALTHY |

### Telemetry fields (from contract)

`voltage_v`, `current_a`, `power_kw`, `power_factor`, `energy_kwh`, `frequency_hz`, `circuit_enabled`, `alert_threshold_kw`

`power_kw` is computed as `(voltage_v × current_a × power_factor) / 1000`. Not raw from hardware.

`energy_kwh` accumulates at each tick: `+= power_kw × (10 / 3600)` (simulating 10-second intervals).

### Command effects

```javascript
setCircuitBreaker({ enabled }): sets circuit_enabled, zeros current_a when false
resetEnergyCounter():           sets energy_kwh = 0
setAlertThreshold({ power_kw_limit }): updates alert_threshold_kw
```

### Health computation (`mapping.mjs`)

```javascript
computeHealth(metrics) → { healthStatus, activeAlerts }
// DEGRADED:  circuit_enabled === false → alert.circuit_open
// CRITICAL:  power_kw > alert_threshold_kw → alert.threshold_exceeded
//            OR voltage_v > 250 → E_OVERVOLT
// DEGRADED:  power_factor < 0.90 (and current_a > 5) → E_LOW_PF
// WARNING:   voltage_v > 245
//            OR power_factor < 0.92
// HEALTHY:   everything else
```

---

## 14. App Node — `agentic-studio/server.mjs`

### ORK mode detection

```javascript
const liveOrk = new LiveOrkClient(ORK_URL);
let _orkLive = null; // cached, re-checked every 8s

async function isOrkLive() → boolean
// Uses 600ms timeout on GET /health

async function getWorld(trace) → { mcp, contractDocument, mode: "live" | "stub" }
// live: buildLiveWorld(liveOrk, trace)
// stub: buildDemoWorld(getContract(), trace)
```

**Key behavior:** The App Node does NOT decide ORK mode at startup. It checks on every request. This means you can start workers/ORK after the App Node and subsequent requests will go live automatically (within 8 seconds of the next re-check).

### API endpoints

```
GET  /api/v1/health          No auth — { ok, orkLive, orkUrl }
GET  /api/v1/meta            No auth — { ork: {live, hint}, llm: {enabled, provider, model, hint} }
GET  /api/v1/workers         Auth — { orkLive, workers[] | hint }
GET  /api/v1/capabilities    Auth — { mode, registrations[], merged: { telemetry[], commands[] } }
POST /api/v1/agent/run       Auth — body: { prompt } → { message, title, mode, orkMode, html, trace, summary }
```

### Auth

Development: any token accepted (including empty).  
Production (`NODE_ENV=production`): `Authorization: Bearer mdk-agent-demo` required.

```
Headers accepted:
  Authorization: Bearer mdk-agent-demo
  X-MDK-Agent-Token: mdk-agent-demo
```

### `POST /api/v1/agent/run` response shape

```json
{
  "message":   "Fleet: 19/20 online. 2 critical.",
  "title":     "Fleet Health Status",
  "mode":      "health_status",
  "orkMode":   "live",
  "intent":    { ...Plan object... },
  "llm":       { "provider": "openai", "model": "gpt-4o-mini" } | null,
  "html":      "<!DOCTYPE html>...",
  "trace":     [{ "ts": 1234, "layer": "agent", "message": "...", "detail": {} }],
  "summary":   {
    "deviceCount":      20,
    "sites":            ["miner-worker", "powermeter-worker"],
    "workerTypes":      ["miner-worker", "powermeter-worker"],
    "commandsExecuted": 0
  }
}
```

### Exported functions (for embedding)

```javascript
export async function buildServer() → Fastify app instance
export async function startServer(port?) → starts listening, returns app
```

`startServer` is used by `start.mjs`. `buildServer` is useful for testing.

---

## 15. Frontend — `agentic-studio/public/`

### `index.html` structure

```
.shell
  header.topbar
    .brand                    ← logo + title + tagline
    .topbar-meta              ← ORK status dot + LLM status dot + device count
  .layout
    section.chat-panel
      .chat-messages           ← message bubbles append here
        .empty-state           ← starter chips (removed on first message)
      .chat-input-bar          ← textarea + send button
    section.right-panel
      .tab-bar                 ← Preview | Trace | Workers | Capabilities
      #pane-preview            ← <iframe srcdoc="..."> for generated HTML
      #pane-trace              ← execution trace timeline
      #pane-workers            ← ORK status + worker card list
      #pane-info               ← merged telemetry + command capabilities
```

### `app.js` key functions

```javascript
sendPrompt()                  // main: POST /api/v1/agent/run, append messages
appendUserMsg(text)           // → .msg.msg-user bubble
appendAgentMsg({ message, mode, title, html, llm })  // → .msg.msg-agent bubble with iframe
appendTrace(events[])         // → trace-item divs in #traceList
setPreview(html, title)       // → sets #previewFrame.srcdoc, switches to Preview tab
loadMeta()                    // GET /api/v1/meta → update ORK + LLM status dots
loadCapabilities()            // GET /api/v1/capabilities → update #capContent
loadWorkers()                 // GET /api/v1/workers → update #workersList
switchTab(tabId)              // toggle .active on tabs + panes
```

### Starter chip categories

Blue chips (default): fleet-wide miner queries  
Purple chips (`.chip-pm`): powermeter-specific queries (voltage, threshold, PF, energy, current)

### Trace event layers

```
"agent"    → pipeline orchestration steps
"mcp"      → tool calls (get_worker_capabilities, get_fleet_telemetry, etc.)
"app-node" → App Node decisions (ORK connection, RBAC)
"ork"      → ORK stub telemetry/command calls (stub mode only)
```

---

## 16. Single-process launcher — `start.mjs`

Imports and starts all four layers in sequence:

```javascript
// Startup order (enforced)
await ork.start(ORK_PORT)
await miner.start()         // announces to ORK, ORK pulls identity+capabilities
await pm.start()            // same
await sleep(600)            // ORK first telemetry.pull completes
app = await buildServer()
await app.listen(APP_PORT)
```

Exports nothing — it is a standalone entry point only.

### Flags

```
--help       Show usage and exit
--no-miner   Skip miner-worker (start with PM only)
--no-pm      Skip powermeter-worker (start with miners only)
--no-llm     Set MDK_LLM_DISABLE=1 (force heuristics even if key present)
```

### Environment variables

```
PORT           App Node port (default 3847)
ORK_PORT       ORK Kernel port (default 3848)
MINER_PORT     Miner Worker port (default 3850)
PM_PORT        Powermeter Worker port (default 3851)
OPENAI_API_KEY        → enables OpenAI LLM
ANTHROPIC_API_KEY     → enables Anthropic LLM
MDK_LLM_DISABLE=1     → force heuristic intent
```

---

## 17. Stub (demo) world vs live mode — differences

| Concern | Stub | Live |
|---|---|---|
| Devices | 8 devices (5 texas, 3 iceland) | 20 devices (10 miners + 10 PM) |
| Data | Static snapshot, single call | Live jitter, updated every 10s by ORK |
| siteId | `"texas"` / `"iceland"` | `"miner-worker"` / `"powermeter-worker"` |
| Commands | Always return `{ status: "SUCCESS", workerAck: {message: "command executed (stub)"} }` | Real state mutation in hardware.mjs |
| contractDocument | `docs/mdk-contract.json` (miner only) | Merged from all worker contracts |
| Heuristic fallback | `interpretPrompt` works with miner fields | `interpretPrompt` handles both miner + PM fields |
| ORK dependency | None (all in-process) | Requires ORK + at least one worker running |

---

## 18. How to add a new worker type

1. **Write `mdk-contract.json`** — telemetry fields, commands, health states, troubleshooting. Semantic descriptions are LLM context. Param bounds are validated programmatically.

2. **Create `src/hardware.mjs`** — `N` device instances, each with:
   - Internal `state` object with all telemetry fields
   - `_tick()` method adding jitter
   - `_history` rolling arrays for key metrics
   - `getRaw()` → raw values + history
   - `executeCommand(name, params)` → mutates state, returns ack
   - Exported: `getDevices()`, `fetchRaw(deviceId)`, `executeCommand(deviceId, name, params)`

3. **Create `src/mapping.mjs`** — two exports:
   - `translateTelemetry(raw)` → normalized object matching contract telemetry names
   - `computeHealth(metrics)` → `{ healthStatus, activeAlerts: [{ code, msg }] }`

4. **Create `src/index.mjs`** — subclass `MDKWorkerBase`:
   ```javascript
   export class MyWorker extends MDKWorkerBase {
     constructor(options = {}) {
       super('my-worker', CONTRACT, { port: options.port ?? 3852, orkUrl: options.orkUrl ?? DEFAULT_ORK_URL });
     }
     async onInit() { this.devices = getDevices(); }
     async onTelemetryPull(deviceId) {
       const { raw, history } = fetchRaw(deviceId);
       const metrics = translateTelemetry(raw);
       const { healthStatus, activeAlerts } = computeHealth(metrics);
       return { metrics, healthStatus, activeAlerts, history };
     }
     async onCommand(deviceId, commandName, params) {
       return executeCommand(deviceId, commandName, params);
     }
   }
   // isMain guard + standalone bootstrap
   ```

5. **Update `start.mjs`** — import `MyWorker`, add `await myWorker.start()` step.

6. **Update `interpretPrompt` in `agentic-core.mjs`** — add regex branches for new worker's field names.

7. **Update starter chips** in `index.html` and `app.js` with relevant prompts.

No changes needed to the ORK kernel, renderer, or App Node — they are generic by design.

---

## 19. How to add a new visualization type

1. Add the name to `VISUALIZATIONS` set in `llm-interpreter.mjs`.
2. Update `systemPrompt()` in `llm-interpreter.mjs` with when to use it.
3. Write `renderMyViz(rows, contractDoc, plan)` in `ui-renderer.mjs` — returns HTML string.
4. Add a case to the `switch (plan.visualization)` in `renderPage()`.
5. Add a regex branch to `interpretPrompt()` in `agentic-core.mjs` returning the new type.

---

## 20. Environment variables reference

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `3847` | App Node / Studio port |
| `ORK_PORT` | `3848` | ORK Kernel port |
| `MINER_PORT` | `3850` | Miner Worker port |
| `PM_PORT` | `3851` | Powermeter Worker port |
| `ORK_URL` | `http://127.0.0.1:3848` | App Node → ORK URL |
| `OPENAI_API_KEY` | — | Enables OpenAI LLM intent |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model name |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` | — | Enables Anthropic LLM intent |
| `ANTHROPIC_MODEL` | `claude-3-5-haiku-20241022` | Anthropic model name |
| `MDK_LLM_DISABLE` | — | Set to `1` to force heuristics |
| `MDK_LLM_PROVIDER` | — | Force `"openai"` or `"anthropic"` |
| `MDK_CONTRACT_PATH` | `docs/mdk-contract.json` | Override contract path (stub mode) |
| `NODE_ENV` | — | Set to `"production"` to enforce auth |

---

## 21. Known sharp edges

### Worker port hardcoding
Worker constructors default port from `process.argv` when options not provided. When running standalone, use `--port=3850` flag. When embedding, pass `{ port: N }` to constructor.

### ORK mode caching
`isOrkLive()` caches the result and re-checks every 8 seconds. If ORK goes offline mid-session, the App Node will keep attempting live mode for up to 8 seconds before falling back.

### Telemetry pull race
Workers announce to ORK, which immediately calls `collector.pullAll()`. However the first scheduler tick (10s) will also pull. The `start.mjs` adds a 600ms delay before starting the App Node to ensure the initial pull completes — without this delay, the App Node may see 0 devices on the very first request.

### `siteId` vs `workerType`
In stub mode, `siteId` is a geographic identifier (`"texas"`, `"iceland"`). In live mode, `siteId` is set to the `workerType` by the TelemetryCollector. This inconsistency is intentional for the POC (geographic sites are a stub concept; live workers self-identify by type). Code that filters by `siteId` must account for this.

### `filter: "overheating"` with powermeter data
The filter uses `temperature_out` which does not exist in powermeter telemetry. This filter effectively matches nothing for PM devices, which is correct behavior (no PM rows in overheating result, falls back to all rows).

### History buffer length
Workers keep 20-entry rolling history arrays. The `buildDemoWorld` stub uses 10-entry arrays. UI renderer's sparkline handles any length ≥ 2.

### Fastify logger output
Server logs JSON (`{"level":30,"msg":"...",...}`) — these are normal Fastify structured logs, not errors.

---

## 22. Trace event format

Every function in the pipeline can emit trace events for debugging. These are collected into the `trace[]` array returned by `runAgentPipeline` and displayed in the Trace tab.

```typescript
interface TraceEvent {
  ts:      number;       // Date.now()
  layer:   "agent" | "mcp" | "app-node" | "ork" | "worker";
  message: string;       // human-readable description
  detail?: any;          // optional structured data
}
```

Pass a `traceFn` or `traceCollector` array to propagate events through all layers.

---

## 23. Node.js version requirement

**Node.js ≥ 20** is required. The codebase uses:
- Native `fetch` (Node 18+ but `AbortSignal.timeout()` requires 20+)
- `structuredClone` (Node 17+)
- ESM (`"type": "module"` in package.json)
- `for await...of` on request stream

No transpilation. No bundling. No Babel.
