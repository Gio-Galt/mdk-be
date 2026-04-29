import test from 'node:test';
import assert from 'node:assert';
import { translateTelemetry, translateHealth } from '../src/mapping.js';
import mockResponse from './hardware.mock.js';

test('Mapping translates raw CGMiner API response to MDK Contract Schema', (t) => {
  const normalized = translateTelemetry(mockResponse);

  // Assert schema mapping matches mdk-contract.json rules
  assert.strictEqual(normalized.hashrate_rt, 110.5); // TH/s
  assert.strictEqual(normalized.hashrate_avg, 110.5); // TH/s
  assert.strictEqual(normalized.power_draw, 3100); // W
  assert.strictEqual(normalized.temperature_in, 25);
  assert.strictEqual(normalized.temperature_out, 78);
  assert.strictEqual(normalized.fan_speed_in, 4500);
  assert.strictEqual(normalized.fan_speed_out, 4600);
});

test('Health states match contract states', (t) => {
  const norm1 = translateHealth({ status: 'Booting', errors: [] });
  assert.strictEqual(norm1.state, 'DEGRADED');
  assert.strictEqual(norm1.alerts.length, 0);

  const norm2 = translateHealth({ status: 'Normal', errors: ['E_TEMP_HIGH'] });
  assert.strictEqual(norm2.state, 'DEGRADED');
  assert.deepStrictEqual(norm2.alerts, ['alert.overheat']);
});
