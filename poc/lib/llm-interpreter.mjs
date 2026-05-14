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
7. For "action", only set command if the user explicitly requests a remediation or corrective action.`;
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
  const key = env.OPENAI_API_KEY;
  const model = env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const base = (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message ?? JSON.stringify(data));
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI: empty response');
  return { text, model };
}

async function anthropicComplete(messages, env) {
  const key = env.ANTHROPIC_API_KEY;
  const model = env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-20241022';
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const rest = messages.filter((m) => m.role !== 'system');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature: 0.1,
      system,
      messages: rest.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message ?? JSON.stringify(data));
  const block = data.content?.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('Anthropic: empty response');
  return { text: block.text, model };
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
}) {
  const provider = detectProvider(env);
  if (!provider) throw new Error('No LLM key: set OPENAI_API_KEY or ANTHROPIC_API_KEY');

  const context = {
    mdk_contract_json: contractDocument,
    workers_registered: registrations.map((r) => ({
      siteId: r.siteId,
      brand: r.metadata?.brand,
      deviceFamily: r.metadata?.deviceFamily,
    })),
  };

  const messages = [
    { role: 'system', content: systemPrompt() },
    {
      role: 'user',
      content: `User request: ${userPrompt}\n\nContext JSON:\n${JSON.stringify(context)}`,
    },
  ];

  const { text, model } =
    provider === 'openai'
      ? await openAiComplete(messages, env)
      : await anthropicComplete(messages, env);

  const plan = parseAndValidate(text, contractDocument);
  return { ...plan, _llm: { provider, model } };
}

export { detectProvider, VISUALIZATIONS };
