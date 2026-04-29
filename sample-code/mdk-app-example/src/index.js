/**
 * MDK App Example — Entry Point
 * ══════════════════════════════
 * Wires all MDK App layer components together.
 *
 *  [MDK Provided]
 *    AppNode        → Empty-box Fastify server. Manages ORK sessions & plugin mounts.
 *    OrkClientStub  → Simulates an HRPC ORK session (swap with real HRPC client).
 *
 *  [Developer Built]
 *    MiningPlugin   → MDK App Plugin. Cross-ORK aggregation + business rules.
 *    MiningWidget   → MDK App Widget (React). Served from /ui, fetches Plugin routes.
 *
 * Route binding (hld-mdk-app.md §6):
 *   MiningPlugin registers → /mining/*
 *   MiningWidget fetches   → GET /mining/stats, GET /mining/alerts
 *   Widget UI served at    → /ui (static React build)
 */

import { AppNode } from './app-node/AppNode.js';
import { OrkClientStub } from './ork/OrkClientStub.js';
import { MiningPlugin } from './plugin/MiningPlugin.js';

// ─── 1. Boot the App Node (MDK-provided infrastructure) ──────────────────────
const appNode = new AppNode({ port: 3000 });

// ─── 2. Connect ORK instances — one per physical site ────────────────────────
// In production: replace OrkClientStub with a real HRPC client over Hyperswarm
appNode.connectOrk('site-texas',   new OrkClientStub('site-texas'));
appNode.connectOrk('site-iceland', new OrkClientStub('site-iceland'));

// ─── 3. Register the MDK App Plugin (developer-built) ────────────────────────
// Plugin declares /mining/* routes; App Node mounts them automatically.
// Paired MiningWidget is pre-configured to call these same routes.
const miningPlugin = new MiningPlugin(appNode);
await miningPlugin.register();

// ─── 4. Start listening ───────────────────────────────────────────────────────
await appNode.start();

console.log('\n MDK App Example running:');
console.log('   Widget UI  →  http://localhost:3000/ui');
console.log('   Stats      →  GET  http://localhost:3000/mining/stats');
console.log('   Alerts     →  GET  http://localhost:3000/mining/alerts');
console.log('   Command    →  POST http://localhost:3000/mining/command\n');
