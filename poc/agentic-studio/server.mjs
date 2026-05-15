/**
 * MDK Agent Studio — App Node gateway (hld.md §4.1 / §4.2)
 *
 * Layer 2: JWT at boundary, MCP tools backed by ORK.
 * Operates in two modes (auto-detected at startup):
 *
 *   Live   — ORK kernel (poc/ork) is running; reads real telemetry from live workers
 *   Stub   — no ORK available; uses the built-in demo world for offline development
 *
 * Live stack start order:
 *   1. node poc/ork/src/index.mjs           (ORK kernel, port 3848)
 *   2. node poc/workers/miner-worker/src/index.mjs      (port 3850)
 *   3. node poc/workers/powermeter-worker/src/index.mjs (port 3851)
 *   4. node poc/agentic-studio/server.mjs   (App Node, port 3847)
 */

import '../lib/load-env.mjs';  // load poc/.env before reading process.env
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';

import {
  loadContract,
  buildDemoWorld,
  buildLiveWorld,
  LiveOrkClient,
  runAgentPipeline,
  mergeCapabilities,
  DEFAULT_CONTRACT_PATH,
  DEFAULT_ORK_URL,
} from '../lib/agentic-core.mjs';
import { detectProvider } from '../lib/llm-interpreter.mjs';
import { L } from '../lib/logger.mjs';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PORT       = Number(process.env.PORT)    || 3847;
const PUBLIC_DIR = join(__dirname, 'public');
const ORK_URL    = process.env.ORK_URL         || DEFAULT_ORK_URL;

// ── Auth ───────────────────────────────────────────────────────────────────

function assertAgentAuth(request) {
  const auth     = request.headers.authorization;
  const fallback = request.headers['x-mdk-agent-token'];
  const token    = auth?.startsWith('Bearer ')
    ? auth.slice(7).trim()
    : String(fallback ?? '').trim();
  if (process.env.NODE_ENV === 'production' && token !== 'mdk-agent-demo') {
    const err = new Error('Unauthorized'); err.statusCode = 401; throw err;
  }
  return token || 'mdk-agent-demo';
}

// ── Contract cache (stub mode) ─────────────────────────────────────────────

let contractCache = null;
function getContract() {
  if (!contractCache) {
    contractCache = loadContract(process.env.MDK_CONTRACT_PATH ?? DEFAULT_CONTRACT_PATH);
  }
  return contractCache;
}

// ── Live ORK detection ─────────────────────────────────────────────────────

const liveOrk = new LiveOrkClient(ORK_URL);
let _orkLive  = null; // null = not yet checked, true/false = cached

async function isOrkLive() {
  if (_orkLive !== null) return _orkLive;
  _orkLive = await liveOrk.isAvailable();
  L.appNode.info(`ORK detected: ${_orkLive ? 'LIVE' : 'STUB'}`, { orkUrl: ORK_URL });
  setInterval(async () => {
    const was  = _orkLive;
    _orkLive   = await liveOrk.isAvailable();
    if (was !== _orkLive) {
      L.appNode.info(`ORK mode changed → ${_orkLive ? 'LIVE' : 'STUB'}`, { orkUrl: ORK_URL });
    }
  }, 8000);
  return _orkLive;
}

// ── World factory ──────────────────────────────────────────────────────────

async function getWorld(trace) {
  if (await isOrkLive()) {
    const { mcp, contractDocument } = await buildLiveWorld(liveOrk, trace);
    return { mcp, contractDocument, mode: 'live' };
  }
  const contract = getContract();
  const { mcp }  = buildDemoWorld(contract, trace);
  return { mcp, contractDocument: contract, mode: 'stub' };
}

// ── Server ─────────────────────────────────────────────────────────────────

export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  // ── /api/v1/health ────────────────────────────────────────────────────────
  app.get('/api/v1/health', async () => ({
    ok:       true,
    service:  'mdk-agent-studio',
    protocol: 'MDK App Node POC',
    orkUrl:   ORK_URL,
    orkLive:  await isOrkLive(),
  }));

  // ── /api/v1/meta ──────────────────────────────────────────────────────────
  app.get('/api/v1/meta', async () => {
    const live     = await isOrkLive();
    const provider = detectProvider(process.env);
    return {
      contractPath: process.env.MDK_CONTRACT_PATH ?? DEFAULT_CONTRACT_PATH,
      metadata:     live ? {} : (getContract().metadata ?? {}),
      ork: {
        live,
        url:    ORK_URL,
        hint:   live
          ? 'Connected to live ORK kernel — real worker telemetry active'
          : 'ORK offline — using built-in demo world. Start poc/ork, miner-worker, powermeter-worker to go live.',
      },
      llm: {
        enabled:  Boolean(provider),
        provider: provider ?? null,
        model:    provider === 'openai'
          ? (process.env.OPENAI_MODEL ?? 'gpt-4o-mini')
          : (process.env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-20241022'),
        hint: provider ? null : 'Set OPENAI_API_KEY or ANTHROPIC_API_KEY in poc/.env',
      },
    };
  });

  // ── /api/v1/workers ───────────────────────────────────────────────────────
  app.get('/api/v1/workers', async (request) => {
    assertAgentAuth(request);
    const live = await isOrkLive();
    if (!live) {
      return {
        orkLive: false,
        workers: [],
        hint: 'ORK offline. Run: node poc/ork/src/index.mjs then start the workers.',
      };
    }
    const workers = await liveOrk.getWorkers();
    return { orkLive: true, orkUrl: ORK_URL, workers };
  });

  // ── /api/v1/capabilities ─────────────────────────────────────────────────
  app.get('/api/v1/capabilities', async (request) => {
    assertAgentAuth(request);
    const trace = [];
    const { mcp, mode } = await getWorld(trace);
    const registrations = await mcp.get_worker_capabilities();
    return {
      mode,
      registrations,
      merged: mergeCapabilities(registrations),
      trace,
    };
  });

  // ── /api/v1/agent/run ─────────────────────────────────────────────────────
  app.post('/api/v1/agent/run', async (request, reply) => {
    const t0     = Date.now();
    const token  = assertAgentAuth(request);
    const body   = request.body ?? {};
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: 'prompt_required' });

    L.appNode.info('POST /api/v1/agent/run', { prompt, token });

    const trace = [];
    const { mcp, contractDocument, mode } = await getWorld(trace);
    L.appNode.info('World ready', { orkMode: mode });

    let result;
    try {
      result = await runAgentPipeline(mcp, prompt, { trace, contractDocument });
    } catch (err) {
      L.appNode.error('Pipeline error', { error: err.message, prompt });
      return reply.code(500).send({ error: err.message });
    }

    const elapsedMs = Date.now() - t0;
    L.appNode.info('Response sent', {
      viz:       result.mode,
      orkMode:   mode,
      devices:   result.rows.length,
      commands:  result.commandResults?.length ?? 0,
      htmlKb:    (result.html.length / 1024).toFixed(1),
      elapsedMs,
    });

    return {
      message:  result.message,
      title:    result.intent?.title ?? result.mode,
      mode:     result.mode,
      orkMode:  mode,
      intent:   result.intent,
      llm:      result.llm,
      html:     result.html,
      trace:    result.trace,
      summary: {
        deviceCount:      result.rows.length,
        sites:            [...new Set(result.rows.map((r) => r.siteId))],
        workerTypes:      [...new Set(result.rows.map((r) => r.workerType).filter(Boolean))],
        commandsExecuted: result.commandResults?.length ?? 0,
      },
    };
  });

  // ── Static files (serve last so API routes take precedence) ───────────────
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/', decorateReply: false });

  return app;
}

export async function startServer(port = PORT) {
  const app  = await buildServer();
  await app.listen({ port, host: '0.0.0.0' });
  const live = await isOrkLive();
  L.appNode.info(`Agent Studio ready`, { port, orkMode: live ? 'live' : 'stub', orkUrl: ORK_URL });
  console.log(`\nMDK Agent Studio → http://127.0.0.1:${port}`);
  console.log(`ORK mode: ${live ? `LIVE (${ORK_URL})` : 'STUB (demo world)'}\n`);
  return app;
}

// ── Standalone bootstrap ───────────────────────────────────────────────────

import { fileURLToPath as __ftu2 } from 'url';
if (process.argv[1] === __ftu2(import.meta.url)) {
  startServer().catch((err) => { console.error(err); process.exit(1); });
}
