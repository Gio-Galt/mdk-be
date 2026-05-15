/**
 * Powermeter Worker — Layer 4 (hld.md §4.4)
 * Manages 10 Schneider PM8000 smart power meters (pm001–pm010).
 *
 * Standalone: node src/index.mjs [--port=3851] [--ork=http://127.0.0.1:3848]
 * Embedded:   import { PowermeterWorker } and call new PowermeterWorker({ port, orkUrl }).start()
 */

import '../../../lib/load-env.mjs';  // load poc/.env before reading process.env
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { MDKWorkerBase } from '../../mdk-worker-base/src/MDKWorkerBase.mjs';
import { getDevices, fetchRaw, executeCommand } from './hardware.mjs';
import { translateTelemetry, computeHealth } from './mapping.mjs';
import { L } from '../../../lib/logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT  = join(__dirname, '../mdk-contract.json');

export class PowermeterWorker extends MDKWorkerBase {
  /**
   * @param {{ port?: number, orkUrl?: string }} [options]
   *   Defaults to CLI args --port= / --ork=, then 3851 / localhost:3848.
   */
  constructor(options = {}) {
    const port   = options.port   ?? Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? 3851);
    const orkUrl = options.orkUrl ?? (process.argv.find((a) => a.startsWith('--ork='))?.split('=')[1] ?? 'http://127.0.0.1:3848');
    super('powermeter-worker', CONTRACT, { port, orkUrl });
  }

  async onInit() {
    this.devices = getDevices();
    L.powermtr.info('Devices loaded', { count: this.devices.length, ids: this.devices.map((d) => d.deviceId) });
  }

  async onTelemetryPull(deviceId) {
    const { raw, history } = fetchRaw(deviceId);
    const metrics = translateTelemetry(raw);
    const { healthStatus, activeAlerts } = computeHealth(metrics);
    L.powermtr.debug('Telemetry', {
      deviceId,
      healthStatus,
      alerts:      activeAlerts?.length ?? 0,
      power_kw:    metrics.power_kw?.toFixed(2),
      power_factor:metrics.power_factor?.toFixed(3),
      energy_kwh:  metrics.energy_kwh?.toFixed(1),
    });
    return { metrics, healthStatus, activeAlerts, history };
  }

  async onCommand(deviceId, commandName, params) {
    L.powermtr.info('Command received', { deviceId, commandName, params });
    const result = await executeCommand(deviceId, commandName, params);
    L.powermtr.info('Command result', { deviceId, commandName, status: result.status ?? 'OK', result });
    return result;
  }
}

// ── Standalone bootstrap ───────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const worker = new PowermeterWorker();
  worker.start().catch((err) => {
    L.powermtr.error('Fatal startup error', { error: err.message });
    process.exit(1);
  });
}
