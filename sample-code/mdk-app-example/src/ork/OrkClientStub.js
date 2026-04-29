/**
 * ORK Client Stub — Reference / Testing
 * ----------------------------------------
 * In production this would be an HRPC client connecting to a real ORK
 * instance over the Hyperswarm mesh using the MDK Protocol.
 *
 * This stub simulates ORK responses so the Plugin can be developed
 * and tested without a live ORK deployment.
 */

export class OrkClientStub {
  constructor(siteId) {
    this.siteId = siteId;
  }

  /**
   * Simulates telemetry.pull — ORK pulling aggregated data from workers.
   * Returns an array of normalised device telemetry records.
   */
  async pullTelemetry() {
    console.log(`[OrkClientStub:${this.siteId}] telemetry.pull`);

    // Simulated payload matching mdk-contract telemetry schema
    return [
      {
        deviceId: 'wm001',
        workerType: 'whatsminer-worker',
        timestamp: Date.now(),
        metrics: { hashrateGHs: 110.4, powerW: 3480, tempC: 72 }
      },
      {
        deviceId: 'wm002',
        workerType: 'whatsminer-worker',
        timestamp: Date.now(),
        metrics: { hashrateGHs: 108.1, powerW: 3510, tempC: 75 }
      },
      {
        deviceId: 'am001',
        workerType: 'antminer-worker',
        timestamp: Date.now(),
        metrics: { hashrateGHs: 140.0, powerW: 3400, tempC: 68 }
      }
    ];
  }

  /**
   * Simulates command.request — ORK dispatching a command to a worker.
   */
  async sendCommand(deviceId, command, params = {}) {
    console.log(`[OrkClientStub:${this.siteId}] command.request → ${deviceId} :: ${command}`, params);
    return { status: 'accepted', deviceId, command };
  }
}
