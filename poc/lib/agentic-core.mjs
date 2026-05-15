/**
 * MDK Agentic POC — core engine
 * Agent → MCP → App Node → ORK → Worker
 * Shared by CLI and Agent Studio.
 *
 * Supports two ORK modes:
 *   Live   — LiveOrkClient talks to the real ORK kernel (poc/ork)
 *   Stub   — OrkClientStub uses the built-in demo world (no external processes)
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { detectProvider, interpretIntentWithLlm } from './llm-interpreter.mjs';
import { renderPage, buildNarrative } from './ui-renderer.mjs';
import { L, banner } from './logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONTRACT_PATH = join(__dirname, '../../docs/mdk-contract.json');
export const DEFAULT_ORK_URL = 'http://127.0.0.1:3848';

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

// ── Live ORK client (hld.md §4.3 / §4.1) ────────────────────────────────────

/**
 * Talks directly to the running ORK Kernel HTTP API.
 * Used when the ORK process (poc/ork) is running alongside the workers.
 */
export class LiveOrkClient {
  constructor(orkUrl = DEFAULT_ORK_URL) {
    this.orkUrl = orkUrl;
  }

  async isAvailable() {
    try {
      const res = await fetch(`${this.orkUrl}/health`, { signal: AbortSignal.timeout(600) });
      return res.ok;
    } catch { return false; }
  }

  async getCapabilities() {
    const res = await fetch(`${this.orkUrl}/capabilities`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`ORK /capabilities ${res.status}`);
    const { capabilities } = await res.json();
    return capabilities; // [{ workerId, workerType, siteId, capabilities, metadata }]
  }

  async getFleetTelemetry() {
    const res = await fetch(`${this.orkUrl}/telemetry`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`ORK /telemetry ${res.status}`);
    const { devices } = await res.json();
    return devices; // flat array of device rows in App Node format
  }

  async getWorkers() {
    const res = await fetch(`${this.orkUrl}/workers`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`ORK /workers ${res.status}`);
    const { workers } = await res.json();
    return workers;
  }

  async sendCommand(deviceId, commandName, params = {}) {
    const res = await fetch(`${this.orkUrl}/command`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ deviceId, commandName, params }),
      signal:  AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error ?? `ORK /command ${res.status}`);
    }
    return res.json();
  }
}

/**
 * Builds MCP tools backed by the live ORK kernel.
 * The interface is identical to createMcpTools so runAgentPipeline works without changes.
 */
export function createLiveMcpTools(live, traceFn) {
  const trace = (msg, detail = null) =>
    traceFn?.({ ts: Date.now(), layer: 'mcp', message: msg, detail });

  return {
    async get_worker_capabilities() {
      trace('Tool: get_worker_capabilities → input', { source: 'live-ork', params: {} });
      L.mcp.info('Tool: get_worker_capabilities', { source: 'live-ork' });
      const raw = await live.getCapabilities();
      const caps = raw.map((c) => ({
        siteId:       c.siteId,
        capabilities: c.capabilities,
        metadata:     { ...c.metadata, workerType: c.workerType },
      }));
      trace('Tool: get_worker_capabilities ← output', caps);
      L.mcp.debug('← capabilities', { workers: caps.length, types: caps.map((c) => c.metadata?.workerType) });
      return caps;
    },

    async list_devices() {
      trace('Tool: list_devices → input', { source: 'live-ork', params: {} });
      L.mcp.info('Tool: list_devices', { source: 'live-ork' });
      const rows  = await live.getFleetTelemetry();
      const devices = rows.map((r) => ({ siteId: r.siteId, deviceId: r.deviceId, workerType: r.workerType }));
      trace('Tool: list_devices ← output', devices);
      L.mcp.debug('← devices', { count: devices.length });
      return devices;
    },

    async get_fleet_telemetry({ hours = 1 } = {}) {
      trace('Tool: get_fleet_telemetry → input', { source: 'live-ork', hours });
      L.mcp.info('Tool: get_fleet_telemetry', { source: 'live-ork', hours });
      const rows = await live.getFleetTelemetry();
      trace('Tool: get_fleet_telemetry ← output', rows);
      L.mcp.debug('← telemetry', { devices: rows.length, workerTypes: [...new Set(rows.map((r) => r.workerType))] });
      return rows;
    },

    async execute_device_command({ deviceId, command, params = {} }) {
      trace('Tool: execute_device_command → input', { deviceId, command, params });
      L.mcp.info('Tool: execute_device_command', { deviceId, command, params });
      const result = await live.sendCommand(deviceId, command, params);
      trace('Tool: execute_device_command ← output', result);
      L.mcp.info('← command result', { deviceId, status: result.status ?? 'OK' });
      return result;
    },
  };
}

/**
 * Build a world backed by the live ORK kernel.
 * Returns { mcp, contractDocument } where contractDocument is the merged
 * capability set from all registered workers.
 */
export async function buildLiveWorld(live, traceCollector = null) {
  const push = (e) => traceCollector?.push?.({ ts: Date.now(), ...e });
  push({ layer: 'app-node', message: 'Connecting to live ORK kernel', detail: { url: live.orkUrl } });

  const mcp = createLiveMcpTools(live, push);

  // Build a synthetic contractDocument from all worker capabilities
  const caps = await live.getCapabilities();
  const allTelemetry = caps.flatMap((c) => c.capabilities?.telemetry ?? []);
  const allCommands  = caps.flatMap((c) => c.capabilities?.commands  ?? []);
  const uniqueTelemetry = [...new Map(allTelemetry.map((t) => [t.name, t])).values()];
  const uniqueCommands  = [...new Map(allCommands.map((c)  => [c.name, c])).values()];

  const contractDocument = {
    metadata:     caps[0]?.metadata ?? {},
    capabilities: { telemetry: uniqueTelemetry, commands: uniqueCommands },
    _workerTypes: caps.map((c) => c.workerType),
  };

  push({ layer: 'app-node', message: `Live fleet: ${caps.length} worker type(s)`, detail: { workerTypes: contractDocument._workerTypes } });

  return { mcp, contractDocument };
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
  const trace = (msg, detail = null) =>
    traceFn?.({ ts: Date.now(), layer: 'mcp', message: msg, detail });

  return {
    async get_worker_capabilities() {
      trace('Tool: get_worker_capabilities → input', { source: 'stub', params: {} });
      L.mcp.info('Tool: get_worker_capabilities', { source: 'stub', token: agentToken });
      appNode.assertAgent(agentToken, 'capabilities:read');
      const regs = await appNode.getRegisteredCapabilities();
      trace('Tool: get_worker_capabilities ← output', regs);
      L.mcp.debug('← capabilities', { sites: regs.length });
      return regs;
    },
    async list_devices() {
      trace('Tool: list_devices → input', { source: 'stub', params: {} });
      L.mcp.info('Tool: list_devices', { source: 'stub' });
      appNode.assertAgent(agentToken, 'telemetry:read');
      const devs = await appNode.listDevices();
      trace('Tool: list_devices ← output', devs);
      L.mcp.debug('← devices', { count: devs.length });
      return devs;
    },
    async get_fleet_telemetry({ hours = 24 } = {}) {
      trace('Tool: get_fleet_telemetry → input', { source: 'stub', hours });
      L.mcp.info('Tool: get_fleet_telemetry', { source: 'stub', hours });
      appNode.assertAgent(agentToken, 'telemetry:read');
      const rows = await appNode.getFleetTelemetryWindow(hours);
      trace('Tool: get_fleet_telemetry ← output', rows);
      L.mcp.debug('← telemetry', { devices: rows.length });
      return rows;
    },
    async execute_device_command({ deviceId, command, params = {} }) {
      trace('Tool: execute_device_command → input', { deviceId, command, params });
      L.mcp.info('Tool: execute_device_command', { source: 'stub', deviceId, command, params });
      const result = await appNode.dispatchCommand(agentToken, { deviceId, command, params });
      trace('Tool: execute_device_command ← output', result);
      L.mcp.info('← command result', { deviceId, status: result.status });
      return result;
    },
  };
}

export function mergeCapabilities(registrations) {
  if (!registrations?.length) return { telemetry: [], commands: [] };
  // Merge all worker capabilities into a unified view
  const allTelemetry = registrations.flatMap((r) => r.capabilities?.telemetry ?? []);
  const allCommands  = registrations.flatMap((r) => r.capabilities?.commands  ?? []);
  return {
    telemetry: [...new Map(allTelemetry.map((t) => [t.name, t])).values()],
    commands:  [...new Map(allCommands.map((c)  => [c.name, c])).values()],
  };
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
  const pipelineStart = Date.now();

  banner(`AGENT PIPELINE`);
  L.agent.info('Received prompt', { prompt: userPrompt });
  push({ layer: 'agent', message: 'Received prompt', detail: { prompt: userPrompt } });

  // Step 1: capabilities
  L.agent.debug('Step 1 — fetch worker capabilities');
  const registrations = await mcp.get_worker_capabilities();
  const caps = mergeCapabilities(registrations);
  const contractMeta = {
    brand:    registrations[0]?.metadata?.brand,
    overview: registrations[0]?.metadata?.overview,
  };
  const tempLimit = outletTempCriticalC(caps);
  L.agent.info('Capabilities merged', {
    workers:   registrations.length,
    telemetry: caps.telemetry.length,
    commands:  caps.commands.length,
    tempLimit,
  });
  // Raw capabilities from all registered workers
  push({ layer: 'mcp', message: 'Capabilities raw response', detail: registrations });

  // Step 2: resolve intent via LLM (always required — no heuristic fallback)
  const provider = detectProvider(env);
  if (!provider) {
    L.agent.error('No LLM API key — cannot resolve intent');
    throw new Error('No LLM API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in poc/.env');
  }
  if (!contractDocument) {
    L.agent.error('No contractDocument — cannot build LLM context');
    throw new Error('No contract document available — cannot resolve intent without capability context');
  }

  L.agent.debug('Step 2 — LLM intent resolution', { provider });
  push({ layer: 'agent', message: `LLM: resolve intent (${provider})` });
  const llmResult = await interpretIntentWithLlm({
    userPrompt,
    contractDocument,
    registrations,
    env,
    onTrace: push,    // pipe raw LLM request + response into the trace
  });
  const plan = { ...llmResult, tempLimit };
  L.agent.info('Plan resolved', {
    viz:    plan.visualization,
    filter: plan.filter,
    intent: plan.intent,
    focus:  plan.focus_fields,
    cmd:    plan.command?.name ?? null,
  });
  push({ layer: 'agent', message: `LLM → ${plan.visualization}`, detail: { visualization: plan.visualization, filter: plan.filter, focus_fields: plan.focus_fields, command: plan.command } });

  // Step 3: fetch telemetry
  L.agent.debug('Step 3 — fetch fleet telemetry');
  const hours = plan.visualization === 'fleet_summary' ? 24 : 1;
  await mcp.list_devices();
  const allRows = await mcp.get_fleet_telemetry({ hours });
  L.agent.info('Telemetry fetched', { devices: allRows.length, hours, workerTypes: [...new Set(allRows.map((r) => r.workerType))] });
  // Raw telemetry snapshot for every device
  push({ layer: 'ork', message: `Telemetry raw response (${allRows.length} devices)`, detail: allRows });

  // Step 4: apply filter
  L.agent.debug('Step 4 — apply filter', { filter: plan.filter, totalDevices: allRows.length });
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
  if (filter !== 'all') {
    L.agent.info('Filter applied', { filter, before: allRows.length, after: rows.length });
  }

  // Step 5: dispatch commands (action intent)
  let commandResults = [];
  if (plan.intent === 'action' && plan.command?.name) {
    const cmd = plan.command;
    L.agent.info('Step 5 — action intent, dispatching command', { cmd: cmd.name, params: cmd.params, target: cmd.target });
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
    L.agent.info('Command targets selected', { count: targets.length, devices: targets.map((t) => t.deviceId) });
    for (const t of targets.slice(0, 3)) {
      L.agent.info(`→ Dispatch ${cmd.name}`, { device: t.deviceId, params: cmd.params });
      push({ layer: 'agent', message: `Dispatch ${cmd.name} → ${t.deviceId}`, detail: cmd.params });
      const res = await mcp.execute_device_command({ deviceId: t.deviceId, command: cmd.name, params: cmd.params });
      L.agent.info(`← ${cmd.name} result`, { device: t.deviceId, status: res.status ?? 'OK' });
      commandResults.push(res);
    }
    rows = allRows;
  }

  // Step 6: compute narrative
  L.agent.debug('Step 6 — build narrative');
  const narrative = buildNarrative(plan, rows, commandResults, tempLimit, contractMeta);
  push({ layer: 'agent', message: 'Narrative computed', detail: narrative });

  // Step 7: render HTML
  L.agent.debug('Step 7 — render HTML', { viz: plan.visualization, devices: rows.length });
  push({ layer: 'agent', message: 'Render HTML from contract telemetry schema', detail: { visualization: plan.visualization, devices: rows.length } });
  const html = renderPage({
    plan,
    rows,
    contractDoc: contractDocument,
    commandResults,
    narrative,
    rationale: `${llmResult._llm.provider}/${llmResult._llm.model}`,
  });

  const elapsedMs = Date.now() - pipelineStart;
  L.agent.info('Pipeline complete', {
    viz:       plan.visualization,
    devices:   rows.length,
    commands:  commandResults.length,
    htmlKb:    (html.length / 1024).toFixed(1),
    elapsedMs,
  });

  return {
    html,
    message:        narrative,
    mode:           plan.visualization,
    intent:         plan,
    llm:            { provider: llmResult._llm.provider, model: llmResult._llm.model },
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
