/**
 * Mining Plugin — MDK App Plugin (Developer-Built, Fastify)
 * ----------------------------------------------------------
 * This is the SERVER-SIDE half of an MDK App.
 *
 * Responsibilities (per hld-mdk-app.md §4.5):
 *  - Cross-ORK data aggregation (scatter-gather across all sites)
 *  - Business rules (alert thresholds, SLA enforcement)
 *  - Custom Fastify routes registered with the App Node
 *  - Internal scheduler for periodic anomaly detection
 *
 * Registration:
 *  Call appNode.registerPlugin('/mining', miningPlugin.routes()) to mount.
 *  Paired Widget (MiningWidget) fetches from /mining/stats and /mining/alerts.
 */

export class MiningPlugin {
  /**
   * @param {import('../app-node/AppNode.js').AppNode} appNode
   */
  constructor(appNode) {
    this.appNode = appNode;
    this.alertThresholdTempC = 85;
    this.alertThresholdHashrateGHs = 50;
  }

  /**
   * Returns a Fastify plugin function that declares all routes.
   * Passed directly to appNode.registerPlugin(prefix, fn).
   */
  routes() {
    const self = this;

    return async function miningRoutes(fastify) {
      /**
       * GET /mining/stats
       * ─────────────────
       * Aggregates telemetry across ALL connected ORK instances (multi-site).
       * Primary data source for the paired MiningWidget.
       */
      fastify.get('/stats', async (request, reply) => {
        const allTelemetry = await self._fetchAllSites();
        return { ok: true, stats: self._aggregate(allTelemetry) };
      });

      /**
       * GET /mining/alerts
       * ──────────────────
       * Returns devices breaching business-rule thresholds.
       */
      fastify.get('/alerts', async (request, reply) => {
        const allTelemetry = await self._fetchAllSites();
        return { ok: true, alerts: self._evaluateAlerts(allTelemetry) };
      });

      /**
       * POST /mining/command
       * ────────────────────
       * Dispatches a hardware command via ORK → Worker → Device.
       * Body: { siteId, deviceId, command, params }
       */
      fastify.post('/command', {
        schema: {
          body: {
            type: 'object',
            required: ['siteId', 'deviceId', 'command'],
            properties: {
              siteId:   { type: 'string' },
              deviceId: { type: 'string' },
              command:  { type: 'string' },
              params:   { type: 'object' }
            }
          }
        }
      }, async (request, reply) => {
        const { siteId, deviceId, command, params = {} } = request.body;
        const ork = self.appNode.getOrkSessions().get(siteId);

        if (!ork) {
          return reply.status(404).send({ ok: false, error: `No ORK session for site: ${siteId}` });
        }

        const result = await ork.sendCommand(deviceId, command, params);
        return { ok: true, result };
      });
    };
  }

  /**
   * Register this Plugin with the App Node and start the scheduler.
   */
  async register() {
    await this.appNode.registerPlugin('/mining', this.routes());
    this._startScheduler();
    console.log('[MiningPlugin] Registered. Routes live at /mining/*');
  }

  // ─── Private: Cross-ORK Scatter-Gather ───────────────────────────────────────

  async _fetchAllSites() {
    const sessions = this.appNode.getOrkSessions();
    const pulls = Array.from(sessions.entries()).map(async ([siteId, ork]) => {
      const records = await ork.pullTelemetry();
      return records.map(r => ({ ...r, siteId }));
    });
    return (await Promise.all(pulls)).flat();
  }

  // ─── Private: Business Logic ─────────────────────────────────────────────────

  _aggregate(telemetry) {
    const totalHashrate = telemetry.reduce((s, d) => s + (d.metrics.hashrateGHs ?? 0), 0);
    const totalPower    = telemetry.reduce((s, d) => s + (d.metrics.powerW ?? 0), 0);
    const avgTemp = telemetry.length
      ? telemetry.reduce((s, d) => s + (d.metrics.tempC ?? 0), 0) / telemetry.length
      : 0;

    return {
      deviceCount:       telemetry.length,
      totalHashrateTHs:  +(totalHashrate / 1000).toFixed(2),
      totalPowerKW:      +(totalPower    / 1000).toFixed(2),
      avgTempC:          +avgTemp.toFixed(1),
      sites:             [...new Set(telemetry.map(d => d.siteId))]
    };
  }

  _evaluateAlerts(telemetry) {
    return telemetry
      .filter(d =>
        d.metrics.tempC          > this.alertThresholdTempC ||
        d.metrics.hashrateGHs    < this.alertThresholdHashrateGHs
      )
      .map(d => ({
        siteId:   d.siteId,
        deviceId: d.deviceId,
        reason:   d.metrics.tempC > this.alertThresholdTempC ? 'HIGH_TEMP' : 'LOW_HASHRATE',
        metrics:  d.metrics
      }));
  }

  // ─── Private: Internal Scheduler ─────────────────────────────────────────────

  _startScheduler() {
    setInterval(async () => {
      try {
        const telemetry = await this._fetchAllSites();
        const alerts = this._evaluateAlerts(telemetry);
        if (alerts.length > 0) {
          console.warn(
            `[MiningPlugin] SCHEDULER: ${alerts.length} device(s) breaching thresholds:`,
            alerts.map(a => `${a.deviceId} (${a.reason})`).join(', ')
          );
        }
      } catch (e) {
        console.error('[MiningPlugin] Scheduler error:', e.message);
      }
    }, 30_000);
  }
}
