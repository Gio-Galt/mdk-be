import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import HardwareService from './hardware.js';
import { translateTelemetry, translateHealth } from './mapping.js';
import MDKWorkerBase from '@mdk/worker-base';

// Setup file paths to load static contract
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONTRACT_PATH = path.join(__dirname, '../mdk-contract.json');

class WhatsminerWorker extends MDKWorkerBase {
  constructor() {
    // Pass the workerType identifier and absolute path to the generic loader
    super("whatsminer-worker", CONTRACT_PATH);
    this.hardwareServices = new Map(); // deviceId -> HardwareService
  }

  async onInit() {
    console.log(`[WhatsminerWorker] Hook: Discovering hardware endpoints...`);
    
    // In a real scenario, this could be from ENV, a local config file, or network scan.
    // Here we inject a mock device for the simulation.
    this.devices = [
      { deviceId: "wm-001", ip: "192.168.1.100", port: 8080 }
    ];

    // Initialize the hardware connection services for each device
    for (const dev of this.devices) {
      this.hardwareServices.set(dev.deviceId, new HardwareService(dev.deviceId, dev.ip));
    }
  }

  async pullTelemetry(deviceId) {
    const hw = this.hardwareServices.get(deviceId);
    if (!hw) throw new Error(`[WhatsminerWorker] No hardware service mapped for ${deviceId}`);
    
    // Fetch raw hardware data
    const rawTelemetry = await hw.fetchRawTelemetry();
    const rawHealth = await hw.fetchHardwareHealth();
    
    // Translate into MDK Schema via mapping.js
    const normalizedTelemetry = translateTelemetry(rawTelemetry);
    const normalizedHealth = translateHealth(rawHealth);
    
    // The base class will transmit this block via HRPC
    return {
       telemetry: normalizedTelemetry,
       health: normalizedHealth
    };
  }

  async executeCommand(deviceId, commandName, parameters) {
    // Stubbed for future REST/SSH invocation
    console.log(`[WhatsminerWorker] Execute command ${commandName} on ${deviceId} mapping parameters:`, parameters);
  }
}

// Bootstrap
const worker = new WhatsminerWorker();
// Kick off the generic architecture pattern
worker.initBase().catch(err => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
