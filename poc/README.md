# MDK Agentic POC

> **Proof-of-concept** implementing the full MDK architecture from `hld.md` — Agent → MCP → App Node → ORK → Worker — with two live workers (miner + powermeter), a real ORK kernel, and a contract-driven chat UI.

---

## Architecture

```
Layer 1  UI / Agent Studio   http://127.0.0.1:3847    agentic-studio/
Layer 2  App Node            (embedded in Studio)     lib/agentic-core.mjs
Layer 3  ORK Kernel          http://127.0.0.1:3848    ork/
Layer 4  Miner Worker        http://127.0.0.1:3850    workers/miner-worker/
Layer 4  Powermeter Worker   http://127.0.0.1:3851    workers/powermeter-worker/
```

Workers are **pull-only** (ORK always initiates). Workers announce themselves to ORK on startup (simulating DHT topic join from `hld.md §4.4.1`). The App Node auto-detects the live ORK and falls back to a built-in stub when ORK is offline.

### Devices


| Worker              | Devices         | Scenarios covered                                                                    |
| ------------------- | --------------- | ------------------------------------------------------------------------------------ |
| `miner-worker`      | `wm001`–`wm010` | Healthy, overheating (93°C), fan failure, offline, throttled, recovering from reboot |
| `powermeter-worker` | `pm001`–`pm010` | Healthy, over threshold, circuit open (load shed), overvoltage, low power factor     |


---

## Prerequisites

- **Node.js ≥ 20** (uses native `fetch`)
- No other global dependencies

Install App Node dependencies (one-time):

```bash
cd poc/agentic-studio
npm install
cd ../..
```

---

## Configuration — `.env`

Copy the example file and edit it:

```bash
cp poc/.env.example poc/.env
```

Then set the values you need. The `.env` file is loaded automatically by every entry point — no flags or exports required. Shell environment variables always take precedence over `.env` values.

**Minimal `.env` to enable LLM intent:**

```ini
OPENAI_API_KEY=sk-...
# or
ANTHROPIC_API_KEY=sk-ant-...
```

**Custom ports:**

```ini
PORT=4000
ORK_PORT=4001
MINER_PORT=4002
PM_PORT=4003
```

See `[poc/.env.example](.env.example)` for the full list with descriptions.

---

## Running the live stack

### Option A — Single process (recommended for dev / demos)

One command, one terminal, one PID:

```bash
node poc/start.mjs
```

All four layers start in sequence in the same Node.js process. Open **[http://127.0.0.1:3847](http://127.0.0.1:3847)**.

```
# Flags
node poc/start.mjs --help          # show all options
node poc/start.mjs --no-pm         # skip powermeter worker
node poc/start.mjs --no-miner      # skip miner worker
node poc/start.mjs --no-llm        # force heuristic intent (ignore LLM keys)

# Custom ports via env
PORT=4000 ORK_PORT=4001 node poc/start.mjs
```

### Option B — Four separate processes (closer to production topology)

Open **4 separate terminals**, all from `mdk-be/`:

```bash
# Terminal 1 — Layer 3: ORK Kernel (start first)
node poc/ork/src/index.mjs

# Terminal 2 — Layer 4: Miner Worker (10 physical miners)
node poc/workers/miner-worker/src/index.mjs

# Terminal 3 — Layer 4: Powermeter Worker (10 power meters)
node poc/workers/powermeter-worker/src/index.mjs

# Terminal 4 — Layer 2/1: App Node + Agent Studio UI
node poc/agentic-studio/server.mjs
```

Open **[http://127.0.0.1:3847](http://127.0.0.1:3847)** — the topbar shows **Live ORK** and the **Workers** tab lists both workers with all 20 devices.

### Optional: LLM-grounded intent

Add your key to `poc/.env` (or export in your shell):

```ini
# poc/.env
OPENAI_API_KEY=sk-...        # uses gpt-4o-mini by default
# ANTHROPIC_API_KEY=sk-ant-... # uses claude-3-5-haiku by default
# MDK_LLM_DISABLE=1           # force heuristics even if a key is set
```

### Stub mode (no workers needed)

Start only the App Node. It detects ORK is offline and serves the built-in 8-device demo world automatically:

```bash
node poc/agentic-studio/server.mjs
```

---

Stopping 

lsof -ti:3847,3848,3850,3851 2>/dev/null | xargs kill -9 2>/dev/null || true; echo "done"



## Smoke tests

Run these **with the live stack running** (single-process or 4-terminal).

### 0. Single-process startup check

```bash
node poc/start.mjs &
sleep 5
# Should print the startup table with 2 workers, 20 devices
```

### 1. ORK kernel health

```bash
curl http://127.0.0.1:3848/health
```

Expected: `"workers": 2, "devices": 20, "healthyWorkers": 2`

### 2. Worker registry

```bash
curl http://127.0.0.1:3848/workers
```

Expected: two entries — `miner-worker` (10 devices) and `powermeter-worker` (10 devices).

### 3. Live telemetry (20 devices)

```bash
curl http://127.0.0.1:3848/telemetry | node -e \
  "const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); \
   console.log('Devices:', j.devices.length); \
   j.devices.slice(0,3).forEach(d => console.log(d.deviceId, d.healthStatus))"
```

Expected: 20 rows, mixed `HEALTHY / WARNING / CRITICAL / DEGRADED`.

### 4. Dispatch a command via ORK

```bash
curl -X POST http://127.0.0.1:3848/command \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"wm005","commandName":"setPowerLimit","params":{"limit_watts":2800}}'
```

Expected: `"status": "SUCCESS"` with a worker ack.

### 5. App Node health (auto-detects ORK mode)

```bash
curl http://127.0.0.1:3847/api/v1/health
```

Expected: `"orkLive": true`.

### 6. Worker registry via App Node

```bash
curl http://127.0.0.1:3847/api/v1/workers \
  -H "Authorization: Bearer mdk-agent-demo"
```

Expected: `"orkLive": true` with both workers listed.

### 7. Full agent pipeline — miner query

```bash
curl -s -X POST http://127.0.0.1:3847/api/v1/agent/run \
  -H "Authorization: Bearer mdk-agent-demo" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Show health status of all devices"}' | \
  node -e "const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); \
  console.log('Mode:', j.mode, '| ORK:', j.orkMode, '| Devices:', j.summary.deviceCount, '| Workers:', j.summary.workerTypes)"
```

Expected: `Mode: health_status | ORK: live | Devices: 20`

### 8. Full agent pipeline — powermeter query

```bash
curl -s -X POST http://127.0.0.1:3847/api/v1/agent/run \
  -H "Authorization: Bearer mdk-agent-demo" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Which racks are over their power threshold?"}' | \
  node -e "const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); \
  console.log('Mode:', j.mode, '| Message:', j.message?.slice(0,100))"
```

### 9. Stub mode smoke test (no workers required)

Kill the ORK and workers, then:

```bash
curl -s -X POST http://127.0.0.1:3847/api/v1/agent/run \
  -H "Authorization: Bearer mdk-agent-demo" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Fleet dashboard"}' | \
  node -e "const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); \
  console.log('Mode:', j.mode, '| ORK:', j.orkMode)"
```

Expected: `ORK: stub`

### 10. CLI demo (no server needed)

```bash
node poc/agentic-end-to-end-poc.mjs --demo
```

Runs both use-case scenarios (report + thermal action) non-interactively against the stub world.

---

## Manual UI test checklist

Open **[http://127.0.0.1:3847](http://127.0.0.1:3847)** with the live stack running.

- Topbar shows **Live ORK** (green dot)
- **Workers** tab shows `miner-worker` + `powermeter-worker`, each with 10 device chips
- **Miner prompts** (click chips or type):
  - `Show health status of all devices` → healthstatus visualization, 20 devices
  - `Which miners are overheating?` → thermalgrid, `wm005` highlighted critical
  - `What's the total fleet hashrate?` → metricfocus on hashrate fields
  - `Are there any fan failures?` → fanspeed fields, `wm006` flagged
  - `Fix the overheating miners by reducing power limit` → actionresult, setPowerLimit dispatched
  - `Generate an executive report for my boss` → fleetsummary, narrative text
- **Powermeter prompts** (purple chips):
  - `Show voltage and grid status for all power meters` → metricfocus on voltage/frequency
  - `Which racks are over their power threshold?` → `pm006` shown critical
  - `Show power factor for all racks` → `pm009` flagged low PF (0.83)
  - `How much energy has each rack consumed?` → energykwh breakdown
  - `Show current draw per rack` → `pm007` shows 0A (circuit open)
- **Preview** tab auto-switches to show generated HTML on each response
- **Trace** tab shows the full Agent → MCP → App Node → ORK → Worker trace
- **Capabilities** tab shows merged telemetry channels from both workers

---

## File map

```
poc/
├── README.md                          ← you are here
├── start.mjs                          ← single-process launcher (all 4 layers)
├── agentic-end-to-end-poc.mjs         ← CLI entry point (stub only)
│
├── lib/
│   ├── agentic-core.mjs               ← agent pipeline, OrkClientStub, LiveOrkClient
│   ├── llm-interpreter.mjs            ← OpenAI / Anthropic intent resolution
│   └── ui-renderer.mjs                ← contract-driven HTML generator
│
├── ork/
│   └── src/index.mjs                  ← Layer 3: ORK Kernel
│                                         WorkerRegistry, Scheduler, HealthMonitor,
│                                         TelemetryCollector, CommandDispatcher
│
├── workers/
│   ├── mdk-worker-base/
│   │   └── src/MDKWorkerBase.mjs      ← Base class: HTTP pull server (MDK Protocol)
│   ├── miner-worker/
│   │   ├── mdk-contract.json          ← capability schema (telemetry + commands)
│   │   └── src/
│   │       ├── hardware.mjs           ← 10 mock miners, jitter, command state
│   │       ├── mapping.mjs            ← raw → MDK schema + health computation
│   │       └── index.mjs              ← MinerWorker : MDKWorkerBase
│   └── powermeter-worker/
│       ├── mdk-contract.json          ← voltage, current, kW, PF, kWh, circuit
│       └── src/
│           ├── hardware.mjs           ← 10 mock rack meters, varied power states
│           ├── mapping.mjs            ← raw → MDK schema + health computation
│           └── index.mjs              ← PowermeterWorker : MDKWorkerBase
│
├── agentic-studio/
│   ├── server.mjs                     ← Layer 2: App Node (Fastify)
│   │                                     auto-detects live ORK, falls back to stub
│   ├── package.json
│   └── public/
│       ├── index.html                 ← chat UI + Workers / Preview / Trace tabs
│       ├── app.js                     ← frontend logic
│       └── styles.css
│
└── generated/
    └── agent-ui-latest.html           ← CLI output (git-ignored)
```

---

## MDK Protocol actions implemented


| Action               | Direction    | Cadence     | Purpose                       |
| -------------------- | ------------ | ----------- | ----------------------------- |
| `identity.request`   | ORK → Worker | on announce | Get worker ID + device list   |
| `capability.request` | ORK → Worker | on announce | Get `mdk-contract.json`       |
| `health.ping`        | ORK → Worker | every 5 s   | Liveness probe                |
| `telemetry.pull`     | ORK → Worker | every 10 s  | Device metrics + history      |
| `command.request`    | ORK → Worker | on demand   | Execute command by `deviceId` |


All communication is **strictly pull-only** — workers never initiate (per `hld.md §3.1`).

---

## Troubleshooting

`**EADDRINUSE` on startup**

```bash
lsof -ti :3847 :3848 :3850 :3851 | xargs kill -9
```

**ORK shows stub mode even though ORK is running**

The App Node checks ORK availability every 8 seconds. Wait a moment and refresh `/api/v1/health`.

**Worker announces but ORK shows 0 devices**

The ORK pulls telemetry on a 10-second tick. Wait one tick and re-check `/telemetry`.

`**node: fetch is not defined`**

Upgrade to Node.js ≥ 20 — native `fetch` is required.