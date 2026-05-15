/**
 * MDK ORK Kernel — Layer 3 (hld.md §4.3)
 *
 * Implements the five core ORK modules:
 *   1. Worker Registry  — phonebook: deviceId → worker, health state
 *   2. Health Monitor   — pings workers every 5 s (health.ping)
 *   3. Telemetry Collector — pulls metrics every 10 s (telemetry.pull)
 *   4. Command Dispatcher — routes commands by deviceId (command.request)
 *   5. Scheduler        — metronome for Health Monitor + Telemetry Collector
 *
 * Transport: HTTP (simulates Hyperswarm HRPC for the POC).
 * All communication is pull-only: ORK always initiates, workers only respond.
 *
 * Worker discovery: workers POST /announce on startup (simulates DHT topic join).
 * ORK then pulls identity + capabilities before starting the telemetry loop.
 *
 * HTTP API (for App Node / hld.md §4.1):
 *   GET  /health           — ORK liveness + summary stats
 *   GET  /workers          — registered workers list with health states
 *   GET  /devices          — all known devices across all workers
 *   GET  /telemetry        — latest telemetry snapshot (all workers merged)
 *   GET  /capabilities     — worker capability declarations (mdk-contract.json)
 *   POST /command          — dispatch a command { deviceId, commandName, params }
 *   POST /announce         — worker self-registration (simulates DHT peer detection)
 *
 * Ports: ORK = 3848 | miner-worker = 3850 | powermeter-worker = 3851
 */

import '../../lib/load-env.mjs';  // load poc/.env before reading process.env
import { createServer } from 'http';
import { randomUUID }   from 'crypto';
import { L }            from '../../lib/logger.mjs';

const ORK_PORT = Number(process.env.ORK_PORT ?? 3848);

// ── Helpers ────────────────────────────────────────────────────────────────

async function orkRequest(host, port, action, extra = {}) {
  const body = JSON.stringify({
    id: randomUUID(),
    version: '0.1.0',
    type: 'request',
    action,
    sender: 'ork:kernel:main',
    timestamp: Date.now(),
    ...extra,
  });

  const res = await fetch(`http://${host}:${port}/mdk`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal:  AbortSignal.timeout(3000),
  });

  if (!res.ok) throw new Error(`Worker responded ${res.status}`);
  const envelope = await res.json();
  return envelope.payload;
}

// ── 1. Worker Registry ─────────────────────────────────────────────────────
// hld.md §4.3.1 §3 — phonebook: deviceId → worker info

class WorkerRegistry {
  constructor() {
    this._workers    = new Map();  // workerId → entry
    this._deviceMap  = new Map();  // deviceId → workerId
  }

  register(workerId, { host, port, workerType, identity, capabilities }) {
    const existing = this._workers.get(workerId);
    if (existing) {
      // re-announcement — update connection details
      existing.host = host;
      existing.port = port;
      existing.lastSeen = Date.now();
      return;
    }

    const entry = {
      workerId, host, port, workerType,
      identity, capabilities,
      health:   'UNKNOWN',   // HEALTHY | SICK | DEAD
      pingFails: 0,
      registeredAt: Date.now(),
      lastSeen: Date.now(),
      lastTelemetryAt: null,
    };
    this._workers.set(workerId, entry);

    for (const deviceId of (identity.deviceIds ?? [])) {
      this._deviceMap.set(deviceId, workerId);
    }

    L.registry.info('Worker registered', { workerType, workerId, devices: identity.deviceCount, deviceIds: identity.deviceIds });
  }

  resolveWorker(deviceId) {
    const wid = this._deviceMap.get(deviceId);
    return wid ? this._workers.get(wid) : null;
  }

  allWorkers() { return [...this._workers.values()]; }
  healthyWorkers() { return this.allWorkers().filter((w) => w.health !== 'DEAD'); }
  get(workerId) { return this._workers.get(workerId); }

  setHealth(workerId, health) {
    const w = this._workers.get(workerId);
    if (w) { w.health = health; w.lastSeen = Date.now(); }
  }

  incrementPingFail(workerId) {
    const w = this._workers.get(workerId);
    if (w) w.pingFails++;
    return w?.pingFails ?? 0;
  }

  resetPingFail(workerId) {
    const w = this._workers.get(workerId);
    if (w) w.pingFails = 0;
  }

  toJSON() {
    return this.allWorkers().map(({ workerId, workerType, host, port, health, registeredAt, lastSeen, lastTelemetryAt, identity }) => ({
      workerId, workerType,
      endpoint: `http://${host}:${port}`,
      health,
      deviceIds: identity.deviceIds ?? [],
      deviceCount: identity.deviceCount ?? 0,
      registeredAt, lastSeen, lastTelemetryAt,
    }));
  }
}

// ── 2. Health Monitor ──────────────────────────────────────────────────────
// hld.md §4.3.1 §6 — pings workers, marks SICK/DEAD

const SICK_THRESHOLD = 2;   // consecutive failures → SICK
const DEAD_THRESHOLD = 5;   // consecutive failures → DEAD

class HealthMonitor {
  constructor(registry) { this._reg = registry; }

  async pingAll() {
    for (const w of this._reg.allWorkers()) {
      const t0 = Date.now();
      try {
        await orkRequest(w.host, w.port, 'health.ping');
        const latencyMs = Date.now() - t0;
        this._reg.resetPingFail(w.workerId);
        if (w.health !== 'HEALTHY') {
          L.health.info('Worker recovered → HEALTHY', { workerId: w.workerId, workerType: w.workerType });
        } else {
          L.health.debug('Ping OK', { workerId: w.workerId, latencyMs });
        }
        this._reg.setHealth(w.workerId, 'HEALTHY');
      } catch (err) {
        const fails = this._reg.incrementPingFail(w.workerId);
        if (fails >= DEAD_THRESHOLD) {
          this._reg.setHealth(w.workerId, 'DEAD');
          L.health.error('Worker DEAD', { workerId: w.workerId, workerType: w.workerType, fails, error: err.message });
        } else if (fails >= SICK_THRESHOLD) {
          this._reg.setHealth(w.workerId, 'SICK');
          L.health.warn('Worker SICK', { workerId: w.workerId, workerType: w.workerType, fails, threshold: DEAD_THRESHOLD });
        } else {
          L.health.warn('Ping failed', { workerId: w.workerId, fails, error: err.message });
        }
      }
    }
  }
}

// ── 3. Telemetry Collector ─────────────────────────────────────────────────
// hld.md §4.3.1 §4 — pull-only; stores latest snapshot per worker

class TelemetryCollector {
  constructor(registry) {
    this._reg   = registry;
    this._cache = new Map();  // workerId → { devices: [], pulledAt }
  }

  async pullAll() {
    for (const w of this._reg.healthyWorkers()) {
      const t0 = Date.now();
      try {
        const payload = await orkRequest(w.host, w.port, 'telemetry.pull');
        const devices = payload.devices ?? [];
        this._cache.set(w.workerId, {
          workerType: w.workerType,
          siteId:     w.workerType,
          devices,
          pulledAt:   Date.now(),
        });
        const entry = this._reg.get(w.workerId);
        if (entry) entry.lastTelemetryAt = Date.now();
        L.telemetry.debug('Pulled', { workerId: w.workerId, workerType: w.workerType, devices: devices.length, latencyMs: Date.now() - t0 });
      } catch (err) {
        L.telemetry.warn('Pull failed', { workerId: w.workerId, workerType: w.workerType, error: err.message });
      }
    }
  }

  /** Returns flat array of device rows in the App Node expected shape */
  getAll() {
    const out = [];
    for (const [workerId, { workerType, siteId, devices }] of this._cache) {
      for (const d of devices) {
        out.push({
          siteId,
          workerType,
          workerId,
          deviceId:    d.deviceId,
          metrics:     d.metrics     ?? {},
          healthStatus: d.healthStatus ?? 'UNKNOWN',
          activeAlerts: d.activeAlerts ?? [],
          history:     d.history     ?? {},
        });
      }
    }
    return out;
  }

  /** Per-worker capability cache (for capabilities endpoint) */
  getCapabilities(registry) {
    return registry.allWorkers().map((w) => ({
      workerId:     w.workerId,
      workerType:   w.workerType,
      siteId:       w.workerType,
      capabilities: w.capabilities?.capabilities  ?? { telemetry: [], commands: [] },
      metadata:     w.capabilities?.metadata      ?? {},
    }));
  }
}

// ── 4. Command Dispatcher ──────────────────────────────────────────────────
// hld.md §4.3.1 §1 — validates and routes commands by deviceId

class CommandDispatcher {
  constructor(registry) { this._reg = registry; }

  async dispatch(deviceId, commandName, params = {}) {
    const w = this._reg.resolveWorker(deviceId);
    if (!w) throw new Error(`No worker registered for deviceId: ${deviceId}`);
    if (w.health === 'DEAD') throw new Error(`Worker for ${deviceId} is DEAD — cannot dispatch`);

    // Validate command exists in capabilities
    const commands = w.capabilities?.capabilities?.commands ?? [];
    const cmd = commands.find((c) => c.name === commandName);
    if (!cmd) throw new Error(`Command "${commandName}" not declared in ${w.workerType} capabilities`);

    L.dispatch.info('Dispatching command', { commandName, deviceId, workerId: w.workerId, workerType: w.workerType, params });

    const result = await orkRequest(w.host, w.port, 'command.request', {
      deviceId,
      commandName,
      params,
    });

    return {
      status:      'SUCCESS',
      deviceId,
      commandName,
      params,
      workerAck:   result,
      dispatchedAt: Date.now(),
    };
  }
}

// ── 5. Scheduler ───────────────────────────────────────────────────────────
// hld.md §4.3.1 §5 — system metronome

class Scheduler {
  constructor() { this._timers = []; }

  add(intervalMs, fn, label = '') {
    const id = setInterval(async () => {
      try { await fn(); } catch (err) {
        L.ork.error(`Scheduler job error`, { job: label, error: err.message });
      }
    }, intervalMs);
    this._timers.push(id);
  }

  stop() { this._timers.forEach(clearInterval); }
}

// ── ORK Kernel ─────────────────────────────────────────────────────────────

class OrkKernel {
  constructor() {
    this.registry   = new WorkerRegistry();
    this.health     = new HealthMonitor(this.registry);
    this.collector  = new TelemetryCollector(this.registry);
    this.dispatcher = new CommandDispatcher(this.registry);
    this.scheduler  = new Scheduler();
    this._startedAt = Date.now();
  }

  async start(port = ORK_PORT) {
    await this._startHttp(port);

    this.scheduler.add(5000,  () => this.health.pingAll(),   'health.ping');
    this.scheduler.add(10000, () => this.collector.pullAll(), 'telemetry.pull');

    L.ork.info('Kernel online', { port, schedulerJobs: ['health.ping@5s', 'telemetry.pull@10s'] });
  }

  // ── Worker announcement handler (DHT simulation) ────────────────────────

  async _handleAnnounce(body) {
    const { host = '127.0.0.1', port, workerType } = body;
    if (!port) throw new Error('announce: missing port');

    L.registry.info('Peer announced', { workerType, host, port });

    // Pull identity (hld.md §4.4.1 step 3)
    const identity = await orkRequest(host, port, 'identity.request');

    // Pull capabilities (hld.md §4.4.1 step 5)
    const capabilities = await orkRequest(host, port, 'capability.request');

    // Save to registry (hld.md §4.4.1 step 4)
    this.registry.register(identity.workerId, { host, port, workerType, identity, capabilities });

    L.registry.info('Identity + capabilities pulled', { workerId: identity.workerId, deviceCount: identity.deviceCount });
    await this.collector.pullAll();
    L.registry.info('Initial telemetry pulled', { workerId: identity.workerId });

    return { ok: true, workerId: identity.workerId, deviceCount: identity.deviceCount };
  }

  // ── HTTP API for App Node ───────────────────────────────────────────────

  _startHttp(port) {
    return new Promise((resolve, reject) => {
    const srv = createServer(async (req, res) => {
      const send = (code, data) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      let body = '';
      for await (const chunk of req) body += chunk;
      const json = body ? JSON.parse(body) : {};

      try {
        const url = new URL(req.url, `http://localhost`);
        const path = url.pathname;

        if (req.method === 'GET' && path === '/health') {
          return send(200, {
            ok:          true,
            service:     'mdk-ork-kernel',
            protocol:    'MDK ORK POC v0.1.0',
            uptimeMs:    Date.now() - this._startedAt,
            workers:     this.registry.allWorkers().length,
            devices:     this.registry.allWorkers().reduce((s, w) => s + (w.identity?.deviceCount ?? 0), 0),
            healthyWorkers: this.registry.healthyWorkers().length,
          });
        }

        if (req.method === 'GET' && path === '/workers') {
          return send(200, { workers: this.registry.toJSON() });
        }

        if (req.method === 'GET' && path === '/devices') {
          const devices = this.registry.allWorkers().flatMap((w) =>
            (w.identity?.deviceIds ?? []).map((id) => ({
              deviceId: id, workerType: w.workerType, workerId: w.workerId,
              workerHealth: w.health,
            }))
          );
          return send(200, { devices });
        }

        if (req.method === 'GET' && path === '/telemetry') {
          return send(200, { devices: this.collector.getAll(), ts: Date.now() });
        }

        if (req.method === 'GET' && path === '/capabilities') {
          return send(200, { capabilities: this.collector.getCapabilities(this.registry) });
        }

        if (req.method === 'POST' && path === '/command') {
          const { deviceId, commandName, params = {} } = json;
          if (!deviceId || !commandName) return send(400, { error: 'deviceId and commandName are required' });
          const result = await this.dispatcher.dispatch(deviceId, commandName, params);
          return send(200, result);
        }

        if (req.method === 'POST' && path === '/announce') {
          const result = await this._handleAnnounce(json);
          return send(200, result);
        }

        send(404, { error: 'not_found', path });
      } catch (err) {
        L.ork.error('HTTP request error', { method: req.method, url: req.url, error: err.message });
        send(500, { error: err.message });
      }
    });

    srv.on('error', reject);
    srv.listen(port, '0.0.0.0', () => {
      L.ork.info('HTTP API ready', { url: `http://127.0.0.1:${port}` });
      resolve();
    });
    }); // end Promise
  }
}

export { OrkKernel };

// ── Standalone bootstrap (guard so import doesn't auto-start) ──────────────

import { fileURLToPath as __ftu } from 'url';
if (process.argv[1] === __ftu(import.meta.url)) {
  const ork = new OrkKernel();
  ork.start(ORK_PORT).catch((err) => {
    L.ork.error('Fatal startup error', { error: err.message });
    process.exit(1);
  });
}
