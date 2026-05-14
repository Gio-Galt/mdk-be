/**
 * MDK Agentic POC — core engine
 * Agent → MCP → App Node → ORK → Worker (stubbed)
 * Shared by CLI and Agent Studio.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { detectProvider, interpretIntentWithLlm } from './llm-interpreter.mjs';
import { renderPage, buildNarrative } from './ui-renderer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONTRACT_PATH = join(__dirname, '../../docs/mdk-contract.json');

// ── Utility ───────────────────────────────────────────────────────────────────

export function outletTempCriticalC(capabilities) {
  const out = (capabilities?.telemetry ?? []).find((t) => t.name === 'temperature_out');
  const m = /(\d+)\s*C/.exec(out?.description ?? '');
  return m ? Number(m[1]) : 85;
}

function computeHealthStatus(metrics, tempLimit = 85) {
  if (!metrics?.hashrate_rt && !metrics?.power_draw) return 'OFFLINE';
  if ((metrics.temperature_out ?? 0) > 88) return 'CRITICAL';
  if (
    (metrics.fan_speed_in ?? 9999) < 2000 ||
    (metrics.fan_speed_out ?? 9999) < 2000
  )
    return 'DEGRADED';
  if ((metrics.temperature_out ?? 0) > tempLimit) return 'WARNING';
  return 'HEALTHY';
}

function computeAlerts(metrics, deviceId) {
  const alerts = [];
  if (!metrics?.hashrate_rt && metrics?.power_draw < 200)
    alerts.push({ code: 'OFFLINE', msg: `${deviceId}: no hashrate, appears offline` });
  if ((metrics?.temperature_out ?? 0) > 88)
    alerts.push({ code: 'E_TEMP_HIGH', msg: `${deviceId}: outlet ${metrics.temperature_out}°C exceeds safe threshold` });
  if ((metrics?.fan_speed_in ?? 9999) < 2000)
    alerts.push({ code: 'E_FAN_FAIL', msg: `${deviceId}: inlet fan ${metrics.fan_speed_in} RPM below 2000 RPM` });
  if ((metrics?.fan_speed_out ?? 9999) < 2000)
    alerts.push({ code: 'E_FAN_FAIL', msg: `${deviceId}: outlet fan ${metrics.fan_speed_out} RPM below 2000 RPM` });
  return alerts;
}

// ── ORK client stub ───────────────────────────────────────────────────────────

export class OrkClientStub {
  constructor(siteId, devices = [], traceFn) {
    this.siteId = siteId;
    this._devices = devices;
    this._trace = traceFn;
  }

  _log(layer, message, detail = null) {
    this._trace?.({ ts: Date.now(), layer, message, detail });
  }

  async pullTelemetry() {
    this._log('ork', `telemetry.pull @ ${this.siteId}`);
    return this._devices.map((d) => ({ ...d, timestamp: Date.now() }));
  }

  async sendCommand(deviceId, command, params = {}) {
    this._log('ork', `command.request → ${deviceId} :: ${command}`, params);
    return {
      status: 'SUCCESS',
      deviceId,
      command,
      params,
      workerAck: { message: 'command executed (stub)' },
    };
  }

  async getCapabilities() {
    this._log('ork', `capability.request @ ${this.siteId}`);
    return structuredClone(this._contract);
  }
}

// ── App Node gateway ─────────────────────────────────────────────────────────

export class AppNodeGateway {
  constructor(contractTemplate, traceFn) {
    this.orkBySite = new Map();
    this.agentScopes = new Set(['telemetry:read', 'device:write', 'capabilities:read']);
    this._contractTemplate = contractTemplate;
    this._trace = traceFn;
  }

  _log(layer, message, detail = null) {
    this._trace?.({ ts: Date.now(), layer, message, detail });
  }

  connectOrk(siteId, orkClient) {
    orkClient._contract = structuredClone(this._contractTemplate);
    orkClient._contract.metadata = { ...orkClient._contract.metadata, siteId };
    this.orkBySite.set(siteId, orkClient);
  }

  assertAgent(_token, scope) {
    if (!this.agentScopes.has(scope)) throw new Error(`RBAC: missing scope "${scope}"`);
  }

  async getRegisteredCapabilities() {
    this._log('app-node', 'Aggregate capability.response from ORK sessions');
    const list = [];
    for (const [siteId, ork] of this.orkBySite) {
      const cap = await ork.getCapabilities();
      list.push({ siteId, capabilities: cap.capabilities, metadata: cap.metadata });
    }
    return list;
  }

  async listDevices() {
    const out = [];
    for (const [siteId, ork] of this.orkBySite) {
      const rows = await ork.pullTelemetry();
      rows.forEach((r) => out.push({ siteId, deviceId: r.deviceId, workerType: r.workerType }));
    }
    return out;
  }

  async getFleetTelemetryWindow(hours = 24) {
    const all = [];
    for (const [siteId, ork] of this.orkBySite) {
      const rows = await ork.pullTelemetry();
      rows.forEach((r) =>
        all.push({
          siteId,
          deviceId: r.deviceId,
          workerType: r.workerType,
          metrics: r.metrics,
          healthStatus: r.healthStatus,
          activeAlerts: r.activeAlerts,
          history: r.history,
        })
      );
    }
    this._log('app-node', `Merged ${all.length} telemetry snapshots`, { hours });
    return all;
  }

  async dispatchCommand(token, { deviceId, command, params }) {
    this.assertAgent(token, 'device:write');
    this._log('app-node', 'Dispatch command via ORK', { deviceId, command });
    for (const [, ork] of this.orkBySite) {
      const rows = await ork.pullTelemetry();
      if (rows.some((r) => r.deviceId === deviceId)) {
        return ork.sendCommand(deviceId, command, params);
      }
    }
    throw new Error(`No ORK route for deviceId ${deviceId}`);
  }
}

// ── MCP tool façade ───────────────────────────────────────────────────────────

export function createMcpTools(appNode, agentToken, traceFn) {
  const log = (msg, detail = null) =>
    traceFn?.({ ts: Date.now(), layer: 'mcp', message: msg, detail });

  return {
    async get_worker_capabilities() {
      log('Tool: get_worker_capabilities');
      appNode.assertAgent(agentToken, 'capabilities:read');
      return appNode.getRegisteredCapabilities();
    },
    async list_devices() {
      log('Tool: list_devices');
      appNode.assertAgent(agentToken, 'telemetry:read');
      return appNode.listDevices();
    },
    async get_fleet_telemetry({ hours = 24 } = {}) {
      log('Tool: get_fleet_telemetry', { hours });
      appNode.assertAgent(agentToken, 'telemetry:read');
      return appNode.getFleetTelemetryWindow(hours);
    },
    async execute_device_command({ deviceId, command, params = {} }) {
      log('Tool: execute_device_command', { deviceId, command, params });
      return appNode.dispatchCommand(agentToken, { deviceId, command, params });
    },
  };
}

// ── Heuristic plan (no LLM key) ──────────────────────────────────────────────

export function interpretPrompt(raw, capsMerged) {
  const p = raw.toLowerCase();
  const tl = outletTempCriticalC(capsMerged);
  if (/report|boss|executive|summary|email|send/.test(p) && !/dashboard|table/.test(p))
    return { intent: 'query', focus_fields: [], visualization: 'fleet_summary', filter: 'all', title: 'Fleet Executive Summary', command: null, tempLimit: tl };
  if (/fix|action|throttle|overheat|remediat/.test(p) || (/take.+action|take action/.test(p)))
    return { intent: 'action', focus_fields: ['temperature_out'], visualization: 'action_result', filter: 'overheating', title: 'Thermal Remediation', command: { name: 'setPowerLimit', params: { limit_watts: 2800 }, target: 'overheating' }, tempLimit: tl };
  if (/\b(hash|hashrate|th\/s)\b/.test(p))
    return { intent: 'query', focus_fields: ['hashrate_rt', 'hashrate_avg'], visualization: 'metric_focus', filter: 'all', title: 'Hashrate Overview', command: null, tempLimit: tl };
  if (/\bpower\b|watt|kw\b/.test(p))
    return { intent: 'query', focus_fields: ['power_draw'], visualization: 'metric_focus', filter: 'all', title: 'Power Consumption', command: null, tempLimit: tl };
  if (/\bfan\b/.test(p))
    return { intent: 'query', focus_fields: ['fan_speed_in', 'fan_speed_out'], visualization: 'metric_focus', filter: 'all', title: 'Fan Status', command: null, tempLimit: tl };
  if (/\b(temp|thermal|hot|heat|cool|overh)\b/.test(p))
    return { intent: 'query', focus_fields: ['temperature_out', 'temperature_in', 'fan_speed_in', 'fan_speed_out'], visualization: 'thermal_grid', filter: 'all', title: 'Thermal Status', command: null, tempLimit: tl };
  if (/\b(health|status|alert|online|offline|alive|down)\b/.test(p))
    return { intent: 'query', focus_fields: [], visualization: 'health_status', filter: 'all', title: 'Fleet Health Status', command: null, tempLimit: tl };
  return { intent: 'query', focus_fields: [], visualization: 'full_table', filter: 'all', title: 'Fleet Dashboard', command: null, tempLimit: tl };
}

export function mergeCapabilities(registrations) {
  const [first] = registrations ?? [];
  return first?.capabilities ?? { telemetry: [], commands: [] };
}

// ── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Runs the full Agent pipeline for a given user prompt.
 * @returns {{ html, message, mode, intent, llm, rows, commandResults, trace }}
 */
export async function runAgentPipeline(mcp, userPrompt, options = {}) {
  const trace = options.trace ?? [];
  const env = options.env ?? process.env;
  const contractDocument = options.contractDocument ?? null;
  const push = (e) => trace.push({ ts: Date.now(), ...e });

  push({ layer: 'agent', message: 'Received prompt', detail: { prompt: userPrompt } });

  // Step 1: capabilities
  const registrations = await mcp.get_worker_capabilities();
  const caps = mergeCapabilities(registrations);
  const contractMeta = {
    brand: registrations[0]?.metadata?.brand,
    overview: registrations[0]?.metadata?.overview,
  };
  const tempLimit = outletTempCriticalC(caps);

  // Step 2: resolve intent
  const llmEnabled =
    env.MDK_LLM_DISABLE !== '1' &&
    Boolean(detectProvider(env)) &&
    Boolean(contractDocument);

  let plan = null;
  let llmResult = null;

  if (llmEnabled) {
    push({ layer: 'agent', message: 'LLM: resolve intent with full contract context' });
    try {
      llmResult = await interpretIntentWithLlm({
        userPrompt,
        contractDocument,
        registrations,
        env,
      });
      plan = { ...llmResult, tempLimit };
      push({ layer: 'agent', message: `LLM → ${plan.visualization}`, detail: { visualization: plan.visualization, filter: plan.filter, focus_fields: plan.focus_fields, command: plan.command } });
    } catch (err) {
      push({ layer: 'agent', message: 'LLM failed — heuristic fallback', detail: String(err?.message) });
    }
  }

  if (!plan) {
    plan = interpretPrompt(userPrompt, caps);
    plan.tempLimit = tempLimit;
    push({ layer: 'agent', message: `Heuristic → ${plan.visualization}`, detail: { visualization: plan.visualization } });
  }

  // Step 3: fetch telemetry
  await mcp.list_devices();
  const allRows = await mcp.get_fleet_telemetry({ hours: plan.visualization === 'fleet_summary' ? 24 : 1 });

  // Step 4: apply filter
  let rows = allRows;
  const filter = plan.filter ?? 'all';
  if (filter === 'overheating') {
    rows = allRows.filter((r) => (r.metrics?.temperature_out ?? 0) > tempLimit);
    if (!rows.length) rows = allRows;
  } else if (filter === 'degraded') {
    rows = allRows.filter((r) => r.healthStatus === 'DEGRADED' || r.healthStatus === 'CRITICAL');
  } else if (filter === 'offline') {
    rows = allRows.filter((r) => r.healthStatus === 'OFFLINE');
  } else if (filter === 'healthy') {
    rows = allRows.filter((r) => r.healthStatus === 'HEALTHY');
  } else if (filter.startsWith('site:')) {
    const site = filter.slice(5);
    rows = allRows.filter((r) => r.siteId === site);
  } else if (filter.startsWith('device:')) {
    const dev = filter.slice(7);
    rows = allRows.filter((r) => r.deviceId === dev);
    if (!rows.length) rows = allRows;
  }

  // Step 5: dispatch commands (action intent)
  let commandResults = [];
  if (plan.intent === 'action' && plan.command?.name) {
    const cmd = plan.command;
    let targets = [];
    if (cmd.target === 'overheating') {
      targets = allRows.filter((r) => (r.metrics?.temperature_out ?? 0) > tempLimit);
    } else if (cmd.target?.startsWith?.('device:')) {
      const dev = cmd.target.slice(7);
      targets = allRows.filter((r) => r.deviceId === dev);
    } else {
      targets = allRows.filter((r) => r.healthStatus === 'CRITICAL' || r.healthStatus === 'WARNING');
    }
    if (!targets.length) targets = allRows.filter((r) => r.healthStatus !== 'OFFLINE').slice(0, 1);
    for (const t of targets.slice(0, 3)) {
      push({ layer: 'agent', message: `Dispatch ${cmd.name} → ${t.deviceId}`, detail: cmd.params });
      const res = await mcp.execute_device_command({ deviceId: t.deviceId, command: cmd.name, params: cmd.params });
      commandResults.push(res);
    }
    rows = targets.length ? allRows : allRows;
  }

  // Step 6: compute narrative from data
  const narrative = buildNarrative(plan, rows, commandResults, tempLimit, contractMeta);
  push({ layer: 'agent', message: 'Narrative computed', detail: narrative });

  // Step 7: render HTML
  push({ layer: 'agent', message: 'Render HTML from contract telemetry schema', detail: { visualization: plan.visualization, devices: rows.length } });
  const html = renderPage({
    plan,
    rows,
    contractDoc: contractDocument,
    commandResults,
    narrative,
    rationale: llmResult?._llm ? `${llmResult._llm.provider}/${llmResult._llm.model}` : null,
  });

  return {
    html,
    message: narrative,
    mode: plan.visualization,
    intent: plan,
    llm: llmResult ? { provider: llmResult._llm.provider, model: llmResult._llm.model } : null,
    rows,
    commandResults,
    trace,
  };
}

// ── Contract loader ───────────────────────────────────────────────────────────

export function loadContract(contractPath = DEFAULT_CONTRACT_PATH) {
  return JSON.parse(readFileSync(contractPath, 'utf8'));
}

// ── Demo world (8 rich devices across 2 sites) ────────────────────────────────

function mkHistory(base, variance, n = 10) {
  const arr = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    v = Math.max(0, v + (Math.random() - 0.5) * variance * 2);
    arr.push(parseFloat(v.toFixed(1)));
  }
  arr[arr.length - 1] = parseFloat(base.toFixed(1));
  return arr;
}

export function buildDemoWorld(contractTemplate, traceCollector = null) {
  const push = (e) => traceCollector?.push?.({ ts: Date.now(), ...e });
  const app = new AppNodeGateway(contractTemplate, push);

  const mkOrk = (siteId, rawDevices) => {
    const devices = rawDevices.map((d) => ({
      ...d,
      healthStatus: computeHealthStatus(d.metrics),
      activeAlerts: computeAlerts(d.metrics, d.deviceId),
    }));
    return new OrkClientStub(siteId, devices, push);
  };

  app.connectOrk(
    'texas',
    mkOrk('texas', [
      {
        deviceId: 'wm001',
        workerType: 'whatsminer-worker',
        metrics: { hashrate_rt: 110.4, hashrate_avg: 109.8, power_draw: 3480, temperature_in: 35, temperature_out: 72, fan_speed_in: 4200, fan_speed_out: 4300 },
        history: { hashrate_rt: mkHistory(110, 2), temperature_out: mkHistory(72, 1.5) },
      },
      {
        deviceId: 'wm002',
        workerType: 'whatsminer-worker',
        metrics: { hashrate_rt: 95.0, hashrate_avg: 94.2, power_draw: 3510, temperature_in: 44, temperature_out: 91, fan_speed_in: 4100, fan_speed_out: 3950 },
        history: { hashrate_rt: mkHistory(95, 3), temperature_out: mkHistory(91, 2) },
      },
      {
        deviceId: 'wm003',
        workerType: 'whatsminer-worker',
        metrics: { hashrate_rt: 112.0, hashrate_avg: 111.5, power_draw: 3465, temperature_in: 32, temperature_out: 68, fan_speed_in: 4450, fan_speed_out: 4520 },
        history: { hashrate_rt: mkHistory(112, 1.5), temperature_out: mkHistory(68, 1) },
      },
      {
        deviceId: 'wm004',
        workerType: 'whatsminer-worker',
        metrics: { hashrate_rt: 108.5, hashrate_avg: 107.0, power_draw: 3490, temperature_in: 38, temperature_out: 77, fan_speed_in: 1750, fan_speed_out: 4200 },
        history: { hashrate_rt: mkHistory(108, 2), temperature_out: mkHistory(77, 2) },
      },
      {
        deviceId: 'wm005',
        workerType: 'whatsminer-worker',
        metrics: { hashrate_rt: 0, hashrate_avg: 0, power_draw: 85, temperature_in: 26, temperature_out: 0, fan_speed_in: 0, fan_speed_out: 0 },
        history: { hashrate_rt: [110, 111, 108, 72, 40, 10, 0, 0, 0, 0], temperature_out: [69, 68, 60, 42, 20, 5, 0, 0, 0, 0] },
      },
    ])
  );

  app.connectOrk(
    'iceland',
    mkOrk('iceland', [
      {
        deviceId: 'am001',
        workerType: 'antminer-worker',
        metrics: { hashrate_rt: 140.0, hashrate_avg: 139.2, power_draw: 3400, temperature_in: 17, temperature_out: 55, fan_speed_in: 4850, fan_speed_out: 4920 },
        history: { hashrate_rt: mkHistory(140, 1.5), temperature_out: mkHistory(55, 1) },
      },
      {
        deviceId: 'am002',
        workerType: 'antminer-worker',
        metrics: { hashrate_rt: 138.5, hashrate_avg: 137.8, power_draw: 3380, temperature_in: 20, temperature_out: 58, fan_speed_in: 4780, fan_speed_out: 4860 },
        history: { hashrate_rt: mkHistory(138, 2), temperature_out: mkHistory(58, 1.5) },
      },
      {
        deviceId: 'am003',
        workerType: 'antminer-worker',
        metrics: { hashrate_rt: 118.0, hashrate_avg: 116.5, power_draw: 3450, temperature_in: 28, temperature_out: 73, fan_speed_in: 4600, fan_speed_out: 4680 },
        history: { hashrate_rt: mkHistory(118, 4), temperature_out: mkHistory(73, 2) },
      },
    ])
  );

  const agentToken = 'mdk-agent-demo';
  const mcp = createMcpTools(app, agentToken, push);
  const agent = new StubAgent(mcp);
  return { app, mcp, agentToken, agent };
}

// ── Legacy StubAgent (for --demo CLI) ────────────────────────────────────────

export class StubAgent {
  constructor(mcp) {
    this.mcp = mcp;
  }

  async scenarioGenerateReport() {
    const caps = mergeCapabilities(await this.mcp.get_worker_capabilities());
    const tempLimit = outletTempCriticalC(caps);
    const metrics = await this.mcp.get_fleet_telemetry({ hours: 24 });
    const online = metrics.filter((r) => r.healthStatus !== 'OFFLINE');
    const totalHash = online.reduce((s, r) => s + (r.metrics?.hashrate_rt ?? 0), 0);
    const avgTemp = (online.reduce((s, r) => s + (r.metrics?.temperature_out ?? 0), 0) / (online.length || 1)).toFixed(1);
    const hottest = [...metrics].sort((a, b) => (b.metrics?.temperature_out ?? 0) - (a.metrics?.temperature_out ?? 0))[0];
    const report = [
      `MDK Fleet Executive Summary — ${new Date().toISOString().slice(0, 10)}`,
      `Sites: ${[...new Set(metrics.map((m) => m.siteId))].join(', ')}`,
      `Devices: ${online.length}/${metrics.length} active`,
      `Aggregate hashrate: ${totalHash.toFixed(2)} TH/s`,
      `Avg outlet: ${avgTemp} °C`,
      `Hottest: ${hottest?.deviceId} @ ${hottest?.metrics?.temperature_out ?? '?'} °C`,
      `Contract threshold: ${tempLimit} °C outlet`,
    ].join('\n');
    return { report, metrics };
  }

  async scenarioTakeAction() {
    const caps = mergeCapabilities(await this.mcp.get_worker_capabilities());
    const TEMP_ALERT_C = outletTempCriticalC(caps);
    const metrics = await this.mcp.get_fleet_telemetry({ hours: 1 });
    const alerts = metrics.filter((m) => (m.metrics?.temperature_out ?? 0) > TEMP_ALERT_C);
    if (!alerts.length) return { acted: false };
    const target = alerts[0];
    const cmdResult = await this.mcp.execute_device_command({
      deviceId: target.deviceId,
      command: 'setPowerLimit',
      params: { limit_watts: 2800 },
    });
    return { acted: true, target, cmdResult };
  }
}
