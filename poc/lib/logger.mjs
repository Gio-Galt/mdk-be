/**
 * MDK POC — Structured, colored, process-aware terminal logger.
 *
 * Zero external dependencies (ANSI escape codes only).
 * Colors are suppressed automatically when stdout is not a TTY
 * (e.g. piped to a file or CI), making the output plain-text AI-ingestible.
 *
 * Usage:
 *   import { createLogger } from '../lib/logger.mjs';
 *   const log = createLogger('ORK');
 *   log.info('Worker registered', { workerId, deviceCount: 10 });
 *   log.warn('Ping failed',       { workerId, fails: 2 });
 *   log.error('Cannot dispatch',  { deviceId, error: err.message });
 *
 * Pre-built loggers for every component:
 *   import { L } from '../lib/logger.mjs';
 *   L.agent.info(...)   L.llm.info(...)   L.mcp.info(...)
 *   L.appNode.info(...) L.ork.info(...)   L.registry.info(...)
 *   L.health.info(...)  L.telemetry.info(...) L.dispatch.info(...)
 *   L.miner.info(...)   L.powermtr.info(...)
 *
 * Output format (one line per event):
 *   12:46:01.234 [AGENT     ] Received prompt                    prompt="what is temperature?"
 *   12:46:01.250 [LLM       ] → openai/gpt-4o-mini               contextFields=15 workers=2
 *   12:46:01.890 [LLM       ] ← plan resolved                    viz=thermal_grid filter=worker:miner-worker focus=["temperature_out"]
 *   12:46:01.895 [MCP       ] Tool: get_fleet_telemetry           hours=1
 *   ⚠ 12:46:01.930 [ORK       ] Worker SICK                       workerId=miner-worker-abc fails=2/5
 *   ✗ 12:46:01.940 [HEALTH    ] Worker DEAD                       workerId=miner-worker-abc
 */

// ── ANSI palette ─────────────────────────────────────────────────────────────

const TTY = process.stdout.isTTY;
const R   = '\x1b[0m';     // reset

const C = TTY ? {
  dim:      '\x1b[2m',
  bold:     '\x1b[1m',
  red:      '\x1b[31m',
  yellow:   '\x1b[38;5;214m',   // amber
  green:    '\x1b[32m',
  cyan:     '\x1b[36m',
  white:    '\x1b[37m',

  // Component colors (256-color)
  agent:    '\x1b[38;5;87m',   // light cyan
  llm:      '\x1b[38;5;81m',   // sky blue
  mcp:      '\x1b[38;5;177m',  // lavender
  appNode:  '\x1b[38;5;220m',  // gold
  ork:      '\x1b[38;5;82m',   // lime green
  registry: '\x1b[38;5;114m',  // medium green
  health:   '\x1b[38;5;156m',  // pale green
  telemetry:'\x1b[38;5;78m',   // sea green
  dispatch: '\x1b[38;5;208m',  // orange
  miner:    '\x1b[38;5;215m',  // peach
  powermtr: '\x1b[38;5;227m',  // light yellow
  worker:   '\x1b[38;5;208m',  // orange (generic)
} : Object.fromEntries(
  ['dim','bold','red','yellow','green','cyan','white',
   'agent','llm','mcp','appNode','ork','registry','health',
   'telemetry','dispatch','miner','powermtr','worker']
  .map((k) => [k, ''])
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

function col(color, text) {
  return TTY ? `${color}${text}${R}` : text;
}

/**
 * Serialize data fields as a flat key=value string.
 * Arrays are compacted; large objects are truncated to JSON.
 */
function kv(obj) {
  if (!obj) return '';
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    let val;
    if (Array.isArray(v)) {
      val = v.length <= 5
        ? `[${v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)).join(',')}]`
        : `[...${v.length} items]`;
    } else if (typeof v === 'object') {
      const s = JSON.stringify(v);
      val = s.length > 120 ? s.slice(0, 117) + '…}' : s;
    } else {
      val = String(v);
    }
    parts.push(`${k}=${val}`);
  }
  return parts.join('  ');
}

// Fixed-width tag (10 chars) so all columns align
const TAG_W = 10;

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * @param {string} component  e.g. 'ORK', 'AGENT', 'MINER'
 * @param {string} [color]    Optional ANSI color override; defaults to palette lookup
 */
export function createLogger(component, color) {
  const tagColor = color ?? C[component.toLowerCase().replace(/-/g, '')] ?? C.white;
  const tag = col(tagColor, `[${component.toUpperCase().padEnd(TAG_W)}]`);

  function write(level, message, data) {
    const time = col(C.dim, ts());
    let prefix = '';
    let msgColor = '';

    if (level === 'WARN') {
      prefix = TTY ? `${C.yellow}⚠ ${R}` : '⚠ ';
      msgColor = C.yellow;
    } else if (level === 'ERROR') {
      prefix = TTY ? `${C.red}✗ ${R}` : '✗ ';
      msgColor = C.red;
    } else if (level === 'DEBUG') {
      msgColor = C.dim;
    }

    const msg = TTY && msgColor ? `${msgColor}${message}${R}` : message;
    const kvStr = data ? `  ${col(C.dim, kv(data))}` : '';
    process.stdout.write(`${prefix}${time} ${tag} ${msg}${kvStr}\n`);
  }

  return {
    debug: (msg, data) => write('DEBUG', msg, data),
    info:  (msg, data) => write('INFO',  msg, data),
    warn:  (msg, data) => write('WARN',  msg, data),
    error: (msg, data) => write('ERROR', msg, data),
  };
}

// ── Banner / separator helpers ────────────────────────────────────────────────

/** Print a visible separator line with a label (for major pipeline start). */
export function banner(label) {
  const line = '─'.repeat(60);
  const text = label ? ` ${label} ` : '';
  const pad  = Math.max(0, Math.floor((60 - text.length) / 2));
  const centered = '─'.repeat(pad) + text + '─'.repeat(60 - pad - text.length);
  process.stdout.write(`\n${col(C.dim, centered)}\n`);
}

// ── Pre-built loggers for every MDK component ─────────────────────────────────

export const L = {
  agent:    createLogger('AGENT',    C.agent),
  llm:      createLogger('LLM',      C.llm),
  mcp:      createLogger('MCP',      C.mcp),
  appNode:  createLogger('APP-NODE', C.appNode),
  ork:      createLogger('ORK',      C.ork),
  registry: createLogger('REGISTRY', C.registry),
  health:   createLogger('HEALTH',   C.health),
  telemetry:createLogger('TELEMETRY',C.telemetry),
  dispatch: createLogger('DISPATCH', C.dispatch),
  miner:    createLogger('MINER',    C.miner),
  powermtr: createLogger('POWERMTR', C.powermtr),
};
