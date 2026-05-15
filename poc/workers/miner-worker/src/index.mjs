/**
 * Miner Worker — Layer 4 (hld.md §4.4)
 * Manages 10 physical Whatsminer miners (wm001–wm010).
 *
 * Standalone: node src/index.mjs [--port=3850] [--ork=http://127.0.0.1:3848]
 * Embedded:   import { MinerWorker } and call new MinerWorker({ port, orkUrl }).start()
 */

import '../../../lib/load-env.mjs';  // load poc/.env before reading process.env
import { dirname, join } from 'path';
import { fileURLToPath as toPath } from 'url';
import { MDKWorkerBase } from '../../mdk-worker-base/src/MDKWorkerBase.mjs';
import { getDevices, fetchRaw, executeCommand } from './hardware.mjs';
import { translateTelemetry, computeHealth } from './mapping.mjs';
import { L } from '../../../lib/logger.mjs';

const __dirname = dirname(toPath(import.meta.url));
const CONTRACT  = join(__dirname, '../mdk-contract.json');

export class MinerWorker extends MDKWorkerBase {
  /**
   * @param {{ port?: number, orkUrl?: string }} [options]
   *   Defaults to CLI args --port= / --ork=, then 3850 / localhost:3848.
   */
  constructor(options = {}) {
    const port   = options.port   ?? Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? 3850);
    const orkUrl = options.orkUrl ?? (process.argv.find((a) => a.startsWith('--ork='))?.split('=')[1] ?? 'http://127.0.0.1:3848');
    super('miner-worker', CONTRACT, { port, orkUrl });
  }

  async onInit() {
    this.devices = getDevices();
    L.miner.info('Devices loaded', { count: this.devices.length, ids: this.devices.map((d) => d.deviceId) });
  }

  async onTelemetryPull(deviceId) {
    const { raw, history } = fetchRaw(deviceId);
    const metrics = translateTelemetry(raw);
    const { healthStatus, activeAlerts } = computeHealth(metrics);
    L.miner.debug('Telemetry', {
      deviceId,
      healthStatus,
      alerts:   activeAlerts?.length ?? 0,
      hashrate: metrics.hashrate_gh?.toFixed(1),
      temp:     metrics.temperature_out,
    });
    return { metrics, healthStatus, activeAlerts, history };
  }

  async onCommand(deviceId, commandName, params) {
    L.miner.info('Command received', { deviceId, commandName, params });
    const result = await executeCommand(deviceId, commandName, params);
    L.miner.info('Command result', { deviceId, commandName, status: result.status ?? 'OK', result });
    return result;
  }
}

// ── Standalone bootstrap ───────────────────────────────────────────────────

if (process.argv[1] === toPath(import.meta.url)) {
  const worker = new MinerWorker();
  worker.start().catch((err) => {
    L.miner.error('Fatal startup error', { error: err.message });
    process.exit(1);
  });
}
