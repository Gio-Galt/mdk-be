/**
 * LLM intent resolution — full mdk-contract.json as primary context.
 * Providers: OpenAI (OPENAI_API_KEY) or Anthropic (ANTHROPIC_API_KEY).
 * No extra npm deps — uses global fetch (Node 20+).
 *
 * Output shape:
 * {
 *   intent:        "query" | "action"
 *   focus_fields:  string[]        – telemetry field names from contract
 *   visualization: string          – rendering mode
 *   filter:        string          – device filter hint
 *   title:         string          – panel title
 *   command:       null | { name, params, target }
 *   _llm:          { provider, model }
 * }
 */

import { L } from './logger.mjs';

const VISUALIZATIONS = new Set([
  'thermal_grid',
  'fleet_summary',
  'full_table',
  'action_result',
  'metric_focus',
  'health_status',
]);

function detectProvider(env = process.env) {
  const forced = (env.MDK_LLM_PROVIDER ?? '').toLowerCase();
  if (forced === 'openai' || forced === 'anthropic') return forced;
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

function systemPrompt() {
  return `You are an AI operations agent for MDK (Mining Development Kit). You receive a user request plus the full mdk-contract.json for the registered workers.

Your task: produce a structured JSON plan that drives data fetching and UI rendering.

Output ONLY valid JSON (no markdown) in this exact shape:
{
  "intent": "query" | "action",
  "focus_fields": ["<telemetry.name from contract>", ...],
  "visualization": "<one of: thermal_grid | fleet_summary | full_table | action_result | metric_focus | health_status>",
  "filter": "<one of: all | overheating | degraded | offline | healthy | site:SITEID | device:DEVICEID>",
  "title": "<short panel title, max 8 words>",
  "command": null | {
    "name": "<commands[].name from contract>",
    "params": { "<param>": <value> },
    "target": "overheating" | "device:DEVICEID"
  }
}

Rules:
1. focus_fields MUST come from capabilities.telemetry[].name in mdk_contract_json.
2. For "action" intent, command.name MUST come from capabilities.commands[].name. Choose wisely per constraints/troubleshooting text.
3. For "action" visualization should be "action_result".
4. Visualization guide:
   - thermal question (temp, fan, heat, cool) → "thermal_grid", focus_fields = temperature + fan fields
   - single metric question (hashrate, power, specific field) → "metric_focus", focus_fields = matching fields
   - health/status/alert/online question → "health_status"
   - report/summary/boss/executive → "fleet_summary"
   - overview/all/dashboard → "full_table"
5. setPowerLimit params: limit_watts must be between 2000 and 4000.
6. filter "overheating" means devices with temperature_out above the critical threshold.
7. For "action", only set command if the user explicitly requests a remediation or corrective action.
8. focus_fields should be the MINIMUM set of fields that directly answer the question. Put the most relevant field FIRST. If unsure, use 1-3 fields.`;
}

function parseAndValidate(text, contractDocument) {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  const parsed = JSON.parse(cleaned);

  if (!['query', 'action'].includes(parsed.intent)) {
    throw new Error(`Invalid intent: ${parsed.intent}`);
  }
  if (!VISUALIZATIONS.has(parsed.visualization)) {
    throw new Error(`Unknown visualization: ${parsed.visualization}. Allowed: ${[...VISUALIZATIONS].join(', ')}`);
  }

  const telemetryNames = new Set(
    (contractDocument?.capabilities?.telemetry ?? []).map((t) => t.name)
  );
  const validFocusFields = (parsed.focus_fields ?? []).filter((f) => telemetryNames.has(f));

  const validatedCommand = (() => {
    if (parsed.intent !== 'action' || !parsed.command?.name) return null;
    const cmds = contractDocument?.capabilities?.commands ?? [];
    const spec = cmds.find((c) => c.name === parsed.command.name);
    if (!spec) {
      throw new Error(`Unknown command "${parsed.command.name}". Allowed: ${cmds.map((c) => c.name).join(', ')}`);
    }
    const params = { ...(parsed.command.params ?? {}) };
    for (const p of spec.params ?? []) {
      const val = params[p.name];
      if (val == null) throw new Error(`Missing param ${p.name} for ${parsed.command.name}`);
      if (typeof p.min === 'number' && Number(val) < p.min) throw new Error(`${p.name}=${val} below min ${p.min}`);
      if (typeof p.max === 'number' && Number(val) > p.max) throw new Error(`${p.name}=${val} above max ${p.max}`);
    }
    return { name: spec.name, params, target: parsed.command.target ?? 'overheating' };
  })();

  return {
    intent: parsed.intent,
    focus_fields: validFocusFields,
    visualization: parsed.visualization,
    filter: String(parsed.filter ?? 'all'),
    title: String(parsed.title ?? 'Fleet Data'),
    command: validatedCommand,
  };
}

async function openAiComplete(messages, env) {
  const key   = env.OPENAI_API_KEY;
  const model = env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const base  = (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const url   = `${base}/chat/completions`;

  const promptChars = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
  L.llm.info('→ OpenAI request', { model, endpoint: base, messages: messages.length, promptChars });

  const t0  = Date.now();
  const res = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model, temperature: 0.1, response_format: { type: 'json_object' }, messages }),
  });
  const data = await res.json().catch(() => ({}));
  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    L.llm.error('← OpenAI error', { status: res.status, error: data.error?.message ?? JSON.stringify(data), latencyMs });
    throw new Error(data.error?.message ?? JSON.stringify(data));
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI: empty response');

  const usage = { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens };
  L.llm.info('← OpenAI response', { model, latencyMs, ...usage, responseChars: text.length });
  return { text, model, usage };
}

async function anthropicComplete(messages, env) {
  const key    = env.ANTHROPIC_API_KEY;
  const model  = env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-20241022';
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const rest   = messages.filter((m) => m.role !== 'system');

  const promptChars = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
  L.llm.info('→ Anthropic request', { model, messages: rest.length, promptChars, systemChars: system.length });

  const t0  = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model, max_tokens: 1024, temperature: 0.1, system, messages: rest.map((m) => ({ role: m.role, content: m.content })) }),
  });
  const data = await res.json().catch(() => ({}));
  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    L.llm.error('← Anthropic error', { status: res.status, error: data.error?.message ?? JSON.stringify(data), latencyMs });
    throw new Error(data.error?.message ?? JSON.stringify(data));
  }

  const block = data.content?.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('Anthropic: empty response');

  const usage = { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens };
  L.llm.info('← Anthropic response', { model, latencyMs, ...usage, responseChars: block.text.length });
  return { text: block.text, model, usage };
}

/**
 * Resolve the operator prompt into a structured plan using the LLM.
 * The full mdk-contract.json + registered workers are passed as context.
 */
export async function interpretIntentWithLlm({
  userPrompt,
  contractDocument,
  registrations = [],
  env = process.env,
  onTrace = null,         // optional (ts, layer, message, detail) => void
}) {
  const trace = (message, detail) => onTrace?.({ ts: Date.now(), layer: 'llm', message, detail });
  const provider = detectProvider(env);
  if (!provider) throw new Error('No LLM key: set OPENAI_API_KEY or ANTHROPIC_API_KEY');

  // Include per-worker field ownership so the LLM can set an explicit worker filter
  const workerFieldMap = registrations.map((r) => ({
    siteId:          r.siteId,
    workerType:      r.metadata?.workerType ?? r.siteId,
    brand:           r.metadata?.brand,
    deviceFamily:    r.metadata?.deviceFamily,
    telemetryFields: (r.capabilities?.telemetry ?? []).map((t) => t.name),
    commandNames:    (r.capabilities?.commands  ?? []).map((c) => c.name),
  }));

  const context = {
    mdk_contract_json:  contractDocument,
    workers_registered: workerFieldMap,
  };

  const messages = [
    { role: 'system', content: systemPrompt() },
    {
      role: 'user',
      content: `User request: ${userPrompt}\n\nContext JSON:\n${JSON.stringify(context)}`,
    },
  ];

  L.llm.info('Resolving intent', {
    provider,
    workers:        workerFieldMap.length,
    contractFields: (contractDocument?.capabilities?.telemetry ?? []).length,
    contractCmds:   (contractDocument?.capabilities?.commands  ?? []).length,
    promptLen:      userPrompt.length,
  });

  // Emit the full request so the Trace pane shows exactly what was sent to the LLM
  trace('LLM request messages', messages);

  const { text, model, usage } =
    provider === 'openai'
      ? await openAiComplete(messages, env)
      : await anthropicComplete(messages, env);

  // Emit the raw text response before any parsing
  trace('LLM raw response', { model, provider, usage, text });

  let plan;
  try {
    plan = parseAndValidate(text, contractDocument);
  } catch (err) {
    L.llm.error('Plan validation failed', { error: err.message, rawResponse: text.slice(0, 200) });
    trace('LLM validation error', { error: err.message, rawResponse: text });
    throw err;
  }

  L.llm.info('Plan validated', {
    intent:    plan.intent,
    viz:       plan.visualization,
    filter:    plan.filter,
    focus:     plan.focus_fields,
    cmd:       plan.command?.name ?? null,
    cmdParams: plan.command?.params ?? null,
  });

  trace('LLM plan validated', plan);

  return { ...plan, _llm: { provider, model } };
}

export { detectProvider, VISUALIZATIONS };
