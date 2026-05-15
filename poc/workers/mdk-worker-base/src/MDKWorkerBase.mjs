/**
 * MDK Worker Base — POC implementation
 * hld.md §4.4: Workers expose capabilities via MDK Protocol.
 *
 * Transport: plain HTTP (simulating HRPC / Hyperswarm in the POC).
 * Protocol direction: strictly pull-only — ORK always initiates,
 * workers only respond. Workers announce their presence to ORK on startup
 * (simulating DHT topic join from hld.md §4.4.1).
 *
 * Supported MDK Protocol actions (hld.md §3.3):
 *   identity.request   — ORK asks worker for its identity + device list
 *   capability.request — ORK asks worker for its full mdk-contract.json
 *   health.ping        — ORK liveness probe (high cadence, ~5s)
 *   state.pull         — ORK pulls worker state machine status (~60s)
 *   telemetry.pull     — ORK pulls device metrics + history (~10s)
 *   command.request    — ORK dispatches a command routed by deviceId
 */

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../lib/logger.mjs';

export class MDKWorkerBase {
  /**
   * @param {string} workerType  e.g. 'miner-worker'
   * @param {string} contractPath  Absolute path to the worker's mdk-contract.json
   * @param {{ port?: number, orkUrl?: string }} [options]
   */
  constructor(workerType, contractPath, options = {}) {
    this.workerId    = `${workerType}-${randomUUID().slice(0, 8)}`;
    this.workerType  = workerType;
    this.contractPath = contractPath;
    this.port        = options.port   ?? 3850;
    this.orkUrl      = options.orkUrl ?? 'http://127.0.0.1:3848';
    this.contract    = null;
    this.devices     = [];
    this._startedAt  = Date.now();
    this._server     = null;
    // Per-worker logger tag: MINER or POWERMTR etc., derived from workerType
    const tag = workerType.replace('-worker', '').replace('powermeter', 'powermtr').toUpperCase();
    this._log = createLogger(tag);
  }

  // ── Public entry point ────────────────────────────────────────────────────

  async start() {
    this.contract = JSON.parse(readFileSync(this.contractPath, 'utf-8'));
    this._log.info('Loading contract', { path: this.contractPath, workerType: this.workerType });

    await this.onInit();
    this._log.info('Devices initialised', { count: this.devices.length, deviceIds: this.devices.map((d) => d.deviceId) });

    await this._listen();
    this._log.info('HTTP pull server ready', { workerId: this.workerId, port: this.port, orkUrl: this.orkUrl });

    await this._announce();
  }

  // ── HTTP pull server ──────────────────────────────────────────────────────

  async _listen() {
    return new Promise((resolve, reject) => {
      this._server = createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/mdk') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: 'not_found' }));
          return;
        }

        let raw = '';
        for await (const chunk of req) raw += chunk;

        let msg;
        try { msg = JSON.parse(raw); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: 'invalid_json' }));
          return;
        }

        try {
          const t0 = Date.now();
          const payload = await this._dispatch(msg);
          const latencyMs = Date.now() - t0;
          if (msg.action === 'telemetry.pull') {
            this._log.debug('MDK action', { action: msg.action, devices: payload.devices?.length ?? 0, latencyMs });
          } else if (msg.action === 'health.ping') {
            this._log.debug('MDK action', { action: msg.action, latencyMs });
          } else {
            this._log.info('MDK action', { action: msg.action, deviceId: msg.deviceId ?? null, cmd: msg.commandName ?? null, latencyMs });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify(this._envelope(msg, payload)));
        } catch (err) {
          this._log.error('MDK action error', { action: msg.action, deviceId: msg.deviceId ?? null, error: err.message });
          res.writeHead(500, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: err.message }));
        }
      });

      this._server.on('error', reject);
      this._server.listen(this.port, '127.0.0.1', resolve);
    });
  }

  _envelope(msg, payload) {
    return {
      id:        msg.id ?? randomUUID(),
      version:   '0.1.0',
      type:      'response',
      action:    msg.action,
      sender:    `worker:${this.workerType}:${this.workerId}`,
      target:    msg.sender ?? null,
      timestamp: Date.now(),
      payload,
    };
  }

  // ── MDK Protocol dispatcher ───────────────────────────────────────────────

  async _dispatch(msg) {
    switch (msg.action) {

      case 'identity.request':
        return {
          workerId:        this.workerId,
          workerType:      this.workerType,
          protocolVersion: '0.1.0',
          processId:       process.pid,
          startedAt:       this._startedAt,
          deviceIds:       this.devices.map((d) => d.deviceId),
          deviceCount:     this.devices.length,
        };

      case 'capability.request':
        return {
          capabilities: this.contract.capabilities,
          metadata:     this.contract.metadata,
        };

      case 'health.ping':
        return { ok: true, ts: Date.now(), uptimeMs: Date.now() - this._startedAt };

      case 'state.pull':
        return {
          workerState: 'RUNNING',
          deviceIds:   this.devices.map((d) => d.deviceId),
          ts:          Date.now(),
        };

      case 'telemetry.pull': {
        const devices = [];
        for (const dev of this.devices) {
          const data = await this.onTelemetryPull(dev.deviceId);
          devices.push({ deviceId: dev.deviceId, ...data });
        }
        return { devices, ts: Date.now() };
      }

      case 'command.request': {
        const result = await this.onCommand(
          msg.deviceId,
          msg.commandName,
          msg.params ?? {},
        );
        return {
          success:     true,
          deviceId:    msg.deviceId,
          commandName: msg.commandName,
          result,
          ts:          Date.now(),
        };
      }

      default:
        throw new Error(`Unsupported MDK action: "${msg.action}"`);
    }
  }

  // ── ORK announcement (DHT simulation) ────────────────────────────────────

  async _announce() {
    this._log.info('Announcing to ORK', { orkUrl: this.orkUrl, workerType: this.workerType, port: this.port });
    try {
      const res = await fetch(`${this.orkUrl}/announce`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ workerType: this.workerType, port: this.port, host: '127.0.0.1' }),
        signal:  AbortSignal.timeout(3000),
      });
      const data = await res.json().catch(() => ({}));
      this._log.info('ORK announcement accepted', { workerId: data.workerId, deviceCount: data.deviceCount });
    } catch (err) {
      this._log.warn('ORK not reachable — standalone mode', { error: err.message, orkUrl: this.orkUrl });
    }
  }

  // ── Abstract interface (implement in each worker) ─────────────────────────

  /** Discover devices and populate this.devices = [{ deviceId, ...meta }] */
  async onInit() { throw new Error('onInit() must be implemented'); }

  /**
   * Return telemetry for one device.
   * @returns {{ metrics: object, healthStatus: string, activeAlerts: object[], history: object }}
   */
  async onTelemetryPull(deviceId) { throw new Error(`onTelemetryPull(${deviceId}) must be implemented`); }

  /**
   * Execute a command on a device.
   * @returns {{ ack: string, [key: string]: any }}
   */
  async onCommand(deviceId, commandName, params) {
    throw new Error(`onCommand(${deviceId}, ${commandName}) must be implemented`);
  }
}
