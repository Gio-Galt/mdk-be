/**
 * MDK App Node — Reference Implementation (Fastify)
 * ---------------------------------------------------
 * Provided by MDK as pre-built infrastructure.
 * Ships as an "empty box" — NO business logic here.
 *
 * Responsibilities:
 *  - Maintains HRPC sessions to one or more ORK instances
 *  - Exposes a Fastify HTTP API for MDK UI / AI agents
 *  - Provides an extension point where MDK App Plugins register their routes
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class AppNode {
  constructor({ port = 3000 } = {}) {
    this.port = port;

    this.fastify = Fastify({ logger: { transport: { target: 'pino-pretty' } } });

    // Registry of connected ORK instances (keyed by siteId)
    this.orkSessions = new Map();

    this.fastify.register(cors, { origin: true });

    // Serve the built React widget from /ui
    this.fastify.register(staticPlugin, {
      root: join(__dirname, '../../widget/dist'),
      prefix: '/ui'
    });
  }

  /**
   * Register a connection to an ORK instance.
   * In production this opens an HRPC session via Hyperswarm.
   *
   * @param {string} siteId
   * @param {object} orkClient - ORK HRPC client or stub
   */
  connectOrk(siteId, orkClient) {
    this.orkSessions.set(siteId, orkClient);
    this.fastify.log.info(`ORK session registered: ${siteId}`);
  }

  /**
   * Extension Point — MDK App Plugins call this to mount their routes.
   *
   * @param {string} prefix           - e.g. '/mining'
   * @param {Function} pluginFn       - A Fastify plugin function
   */
  async registerPlugin(prefix, pluginFn) {
    await this.fastify.register(pluginFn, { prefix });
    this.fastify.log.info(`Plugin mounted at: ${prefix}`);
  }

  /**
   * Returns a read-only view of all connected ORK sessions.
   * Plugins use this to query ORK instances.
   */
  getOrkSessions() {
    return this.orkSessions;
  }

  async start() {
    await this.fastify.listen({ port: this.port, host: '0.0.0.0' });
  }
}
