#!/usr/bin/env node
/**
 * MDK POC — Single-process launcher
 *
 * Starts all four layers in one Node.js process / one event loop:
 *
 *   Layer 3  ORK Kernel          :3848  (starts first, workers register to it)
 *   Layer 4  Miner Worker        :3850  (10 miners  wm001–wm010)
 *   Layer 4  Powermeter Worker   :3851  (10 meters  pm001–pm010)
 *   Layer 2  App Node / Studio   :3847
 *
 * Usage:
 *   node poc/start.mjs
 *   node poc/start.mjs --help
 *
 * Environment / flags (all optional):
 *   PORT          App Node port      (default 3847)
 *   ORK_PORT      ORK Kernel port    (default 3848)
 *   MINER_PORT    Miner Worker port  (default 3850)
 *   PM_PORT       PM Worker port     (default 3851)
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY   required — LLM always used
 */

import './lib/load-env.mjs';  // load poc/.env before reading process.env
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ── Parse CLI flags ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
MDK POC — Single-process launcher

  node poc/start.mjs [options]

Options:
  --help               Show this help
  --no-miner           Skip miner-worker
  --no-pm              Skip powermeter-worker

Environment variables (set in poc/.env or shell):
  PORT=3847            App Node port
  ORK_PORT=3848        ORK Kernel port
  MINER_PORT=3850      Miner Worker port
  PM_PORT=3851         Powermeter Worker port
  OPENAI_API_KEY       OpenAI API key (required — no heuristic fallback)
  ANTHROPIC_API_KEY    Anthropic API key (alternative to OpenAI)
  MDK_LLM_PROVIDER     Force "openai" or "anthropic" when both keys are set
`);
  process.exit(0);
}

const NO_MINER = args.includes('--no-miner');
const NO_PM    = args.includes('--no-pm');

const APP_PORT   = Number(process.env.PORT       ?? 3847);
const ORK_PORT   = Number(process.env.ORK_PORT   ?? 3848);
const MINER_PORT = Number(process.env.MINER_PORT ?? 3850);
const PM_PORT    = Number(process.env.PM_PORT     ?? 3851);
const ORK_URL    = `http://127.0.0.1:${ORK_PORT}`;

// ── Imports ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

const { OrkKernel }        = await import('./ork/src/index.mjs');
const { MinerWorker }      = await import('./workers/miner-worker/src/index.mjs');
const { PowermeterWorker } = await import('./workers/powermeter-worker/src/index.mjs');
const { buildServer }      = await import('./agentic-studio/server.mjs');

// ── Helpers ────────────────────────────────────────────────────────────────

function banner(text) { console.log(`\n${'─'.repeat(58)}\n  ${text}\n${'─'.repeat(58)}`); }
function step(emoji, label) { process.stdout.write(`  ${emoji}  ${label}… `); }
function ok(note = '') { console.log(`✓ ${note}`); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Main ───────────────────────────────────────────────────────────────────

banner('MDK POC — Single-Process Mode');

// 1. ORK Kernel  ─────────────────────────────────────────────────────────────
step('⬡', `ORK Kernel              :${ORK_PORT}`);
const ork = new OrkKernel();
await ork.start(ORK_PORT);
ok();

// 2. Miner Worker  ───────────────────────────────────────────────────────────
if (!NO_MINER) {
  step('⛏', `Miner Worker   (×10)    :${MINER_PORT}`);
  const miner = new MinerWorker({ port: MINER_PORT, orkUrl: ORK_URL });
  await miner.start();
  ok();
} else {
  console.log(`  ·  Miner Worker skipped (--no-miner)`);
}

// 3. Powermeter Worker  ──────────────────────────────────────────────────────
if (!NO_PM) {
  step('⚡', `Powermeter Worker (×10) :${PM_PORT}`);
  const pm = new PowermeterWorker({ port: PM_PORT, orkUrl: ORK_URL });
  await pm.start();
  ok();
} else {
  console.log(`  ·  Powermeter Worker skipped (--no-pm)`);
}

// 4. Let ORK pull initial telemetry from announced workers  ──────────────────
if (!NO_MINER || !NO_PM) {
  step('↻', 'ORK pulling initial telemetry        ');
  await sleep(600);
  const n = ork.collector.getAll().length;
  ok(`${n} device snapshots`);
}

// 5. App Node + Agent Studio  ─────────────────────────────────────────────────
step('◇', `App Node / Agent Studio :${APP_PORT}`);
const app = await buildServer();
await app.listen({ port: APP_PORT, host: '0.0.0.0' });
const { detectProvider } = await import('./lib/llm-interpreter.mjs');
const llmProvider = detectProvider(process.env);
ok();

// ── Startup summary ────────────────────────────────────────────────────────

const workers  = ork.registry.toJSON();
const devices  = ork.collector.getAll().length;

console.log(`
┌──────────────────────────────────────────────────────┐
│  MDK POC  —  all layers running in one process       │
├─────────────────────────┬────────────────────────────┤
│  Agent Studio (UI)      │  http://127.0.0.1:${APP_PORT}        │
│  ORK Kernel             │  http://127.0.0.1:${ORK_PORT}        │
${workers.map((w) =>
`│  ${w.workerType.padEnd(25)}│  http://127.0.0.1:${w.endpoint.split(':').pop().padEnd(4)}  (${String(w.deviceCount).padStart(2)} devices)  │`
).join('\n')}
├─────────────────────────┼────────────────────────────┤
│  Live devices           │  ${String(devices).padEnd(4)} across ${workers.length} worker type(s)      │
│  LLM intent             │  ${(llmProvider ?? '⚠ NO KEY — set in poc/.env').padEnd(26)}  │
└─────────────────────────┴────────────────────────────┘

  Open → http://127.0.0.1:${APP_PORT}
  Stop  → Ctrl-C
`);

// ── Graceful shutdown ──────────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\n[start] Shutting down…');
  ork.scheduler.stop();
  await app.close();
  process.exit(0);
});
