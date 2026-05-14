#!/usr/bin/env node
/**
 * MDK — Agentic POC CLI
 * @see ../agentic-studio for the App Node + web UI (recommended).
 *
 *   node poc/agentic-end-to-end-poc.mjs
 *   node poc/agentic-end-to-end-poc.mjs --demo
 */

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

import {
  loadContract,
  buildDemoWorld,
  runAgentPipeline,
  StubAgent,
  DEFAULT_CONTRACT_PATH,
} from './lib/agentic-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const contractTemplate = loadContract();
  const trace = [];
  const { mcp, agent } = buildDemoWorld(contractTemplate, trace);

  if (process.argv.includes('--demo')) {
    console.log('MDK agentic POC — --demo (non-interactive)\n');

    console.log('═══ USE CASE A: Generate report ═══\n');
    const a = await agent.scenarioGenerateReport();
    console.log(a.report.split('\n').map((l) => '  ' + l).join('\n'));

    console.log('\n═══ USE CASE B: Take action ═══\n');
    const b = await agent.scenarioTakeAction();
    console.log(
      b.acted
        ? `  Acted on ${b.target.deviceId}: ${JSON.stringify(b.cmdResult)}`
        : '  No thermal anomaly in stub fleet'
    );
    console.log('\nDone.\n');
    return;
  }

  console.log('MDK agentic POC — CLI (use Agent Studio for the full UI)');
  console.log('Capabilities:', DEFAULT_CONTRACT_PATH);
  console.log('Start studio: cd poc/agentic-studio && npm i && npm start\n');

  const rl = createInterface({ input, output });
  const userPrompt =
    (await rl.question('Your prompt: ')).trim() || 'show fleet dashboard';
  rl.close();

  trace.length = 0;
  const { html } = await runAgentPipeline(mcp, userPrompt, {
    trace,
    contractDocument: contractTemplate,
  });
  const outPath = join(__dirname, 'generated', 'agent-ui-latest.html');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, 'utf8');
  console.log(`\nWrote: ${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
