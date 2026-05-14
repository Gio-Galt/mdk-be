/**
 * MDK Agent Studio — App Node gateway (POC)
 * hld.md §4.1 / §4.2: JWT at boundary, MCP-style tools backed by ORK stubs.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';

import {
  loadContract,
  buildDemoWorld,
  runAgentPipeline,
  mergeCapabilities,
  DEFAULT_CONTRACT_PATH,
} from '../lib/agentic-core.mjs';
import { detectProvider } from '../lib/llm-interpreter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3847;
const PUBLIC_DIR = join(__dirname, 'public');

function assertAgentAuth(request) {
  const auth = request.headers.authorization;
  const fallback = request.headers['x-mdk-agent-token'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : String(fallback ?? '').trim();
  if (process.env.NODE_ENV === 'production' && token !== 'mdk-agent-demo') {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  return token || 'mdk-agent-demo';
}

let contractCache = null;
function getContract() {
  if (!contractCache) {
    contractCache = loadContract(process.env.MDK_CONTRACT_PATH ?? DEFAULT_CONTRACT_PATH);
  }
  return contractCache;
}

export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.get('/api/v1/health', async () => ({
    ok: true,
    service: 'mdk-agent-studio',
    protocol: 'MDK App Node POC',
  }));

  app.get('/api/v1/meta', async () => {
    const contract = getContract();
    const provider = detectProvider(process.env);
    return {
      contractPath: process.env.MDK_CONTRACT_PATH ?? DEFAULT_CONTRACT_PATH,
      metadata: contract.metadata ?? {},
      llm: {
        enabled: Boolean(provider),
        provider: provider ?? null,
        model:
          provider === 'openai'
            ? (process.env.OPENAI_MODEL ?? 'gpt-4o-mini')
            : (process.env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-20241022'),
        hint: 'Set OPENAI_API_KEY or ANTHROPIC_API_KEY. MDK_LLM_DISABLE=1 forces heuristics.',
      },
    };
  });

  app.get('/api/v1/capabilities', async (request) => {
    assertAgentAuth(request);
    const trace = [];
    const { mcp } = buildDemoWorld(getContract(), trace);
    const registrations = await mcp.get_worker_capabilities();
    return {
      registrations,
      merged: mergeCapabilities(registrations),
      trace,
    };
  });

  app.post('/api/v1/agent/run', async (request, reply) => {
    assertAgentAuth(request);
    const body = request.body ?? {};
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: 'prompt_required' });

    const trace = [];
    const { mcp } = buildDemoWorld(getContract(), trace);
    const result = await runAgentPipeline(mcp, prompt, {
      trace,
      contractDocument: getContract(),
    });

    return {
      message: result.message,
      title: result.intent?.title ?? result.mode,
      mode: result.mode,
      intent: result.intent,
      llm: result.llm,
      html: result.html,
      trace: result.trace,
      summary: {
        deviceCount: result.rows.length,
        sites: [...new Set(result.rows.map((r) => r.siteId))],
        commandsExecuted: result.commandResults?.length ?? 0,
      },
    };
  });

  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/', decorateReply: false });
  return app;
}

async function main() {
  const app = await buildServer();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`\nMDK Agent Studio → http://127.0.0.1:${PORT}\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
