# mdk-app-example

Reference implementation of the **MDK App** layer as defined in [`docs/hld-mdk-app.md`](../docs/hld-mdk-app.md).

Demonstrates the full Plugin + Widget pattern with a real multi-site mining fleet dashboard.

---

## Component Map

```
mdk-app-example/
├── src/
│   ├── index.js                  ← Entry point — wires all components together
│   ├── app-node/
│   │   └── AppNode.js            ← [MDK Provided] Fastify server, ORK session registry
│   ├── ork/
│   │   └── OrkClientStub.js      ← [MDK Provided] ORK HRPC stub for local dev
│   ├── plugin/
│   │   └── MiningPlugin.js       ← [Developer Built] MDK App Plugin — business logic
│   └── widget/
│       ├── MiningWidget.jsx      ← [Developer Built] MDK App Widget — React UI
│       └── main.jsx              ← React entry point
├── index.html                    ← Vite HTML shell
├── vite.config.js                ← Vite config (proxies /mining/* to App Node)
└── package.json
```

---

## What Each File Does

| File | Owner | Role |
|---|---|---|
| `AppNode.js` | MDK (provided) | Empty-box Fastify server. Pre-wired with ORK session management and plugin registration hook. Contains zero business logic. |
| `OrkClientStub.js` | MDK (provided) | Simulates HRPC ORK sessions for local development. Swap with real HRPC client for production. |
| `MiningPlugin.js` | **Developer** | Registers `/mining/*` routes with the App Node. Performs scatter-gather across both ORK sites, aggregates fleet metrics, evaluates alert thresholds, and runs an internal scheduler. |
| `MiningWidget.jsx` | **Developer** | React component that fetches from `/mining/stats` and `/mining/alerts`. Binds to the Plugin via the registered route prefix — no HRPC or ORK code in the UI. |

---

## Running Locally

### Prerequisites

```bash
cd mdk-app-example
npm install
```

### Terminal 1 — Boot the Fastify App Node + Plugin

```bash
node src/index.js
```

### Terminal 2 — Run the React Widget (dev server with proxy)

```bash
npx vite
```

Open **http://localhost:5173** — the Widget fetches from the Plugin automatically via the Vite proxy.

---

## Available API Routes (App Node)

| Method | Route | Source | Description |
|---|---|---|---|
| `GET` | `/mining/stats` | MiningPlugin | Fleet-wide aggregate metrics across all ORK sites |
| `GET` | `/mining/alerts` | MiningPlugin | Devices breaching temperature or hashrate thresholds |
| `POST` | `/mining/command` | MiningPlugin | Dispatch a hardware command via ORK → Worker → Device |

### Example: Fetch Stats

```bash
curl http://localhost:3000/mining/stats
```

```json
{
  "ok": true,
  "stats": {
    "deviceCount": 6,
    "totalHashrateTHs": 0.72,
    "totalPowerKW": 20.78,
    "avgTempC": 71.5,
    "sites": ["site-texas", "site-iceland"]
  }
}
```

### Example: Send a Command

```bash
curl -X POST http://localhost:3000/mining/command \
  -H "Content-Type: application/json" \
  -d '{ "siteId": "site-texas", "deviceId": "wm001", "command": "reboot" }'
```

---

## Extending This Example

To add a new business logic endpoint:

1. Add a new route in `MiningPlugin.js` (e.g., `fastify.get('/efficiency', ...)`)
2. Fetch from that route in `MiningWidget.jsx` (e.g., `fetch('/mining/efficiency')`)
3. No changes required to `AppNode.js` — the Plugin registers its routes automatically.

To connect a real ORK instance, replace `OrkClientStub` with a real HRPC client and update `src/index.js`:

```js
import { OrkClient } from 'mdk-ork-client'; // real HRPC client
appNode.connectOrk('site-texas', new OrkClient({ topic: '<hyperswarm-topic>' }));
```
