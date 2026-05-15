/**
 * Miner mapping layer — translates raw Whatsminer hardware output into
 * the normalized MDK Contract schema (mdk-contract.json §capabilities.telemetry).
 *
 * hld.md §4.4.2: the Worker is the Source of Truth for hardware state.
 * Computes healthStatus and activeAlerts here so ORK/App Node can consume
 * them without knowing miner-specific thresholds.
 */

const TEMP_CRITICAL_C     = 90;
const TEMP_WARNING_C      = 85;
const FAN_FAILURE_RPM     = 2000;
const HASHRATE_OFFLINE_TH = 1;  // below this = considered offline

export function translateTelemetry(raw) {
  return {
    hashrate_rt:     parseFloat(raw.hashrate_rt.toFixed(2)),
    hashrate_avg:    parseFloat(raw.hashrate_avg.toFixed(2)),
    power_draw:      Math.round(raw.power_draw),
    temperature_in:  parseFloat(raw.temperature_in.toFixed(1)),
    temperature_out: parseFloat(raw.temperature_out.toFixed(1)),
    fan_speed_in:    Math.round(raw.fan_speed_in),
    fan_speed_out:   Math.round(raw.fan_speed_out),
  };
}

export function computeHealth(metrics) {
  const { hashrate_rt, temperature_out, fan_speed_in, fan_speed_out, power_draw } = metrics;

  // Offline: no hash, negligible power
  if (hashrate_rt < HASHRATE_OFFLINE_TH && power_draw < 200) {
    return { healthStatus: 'OFFLINE', activeAlerts: [] };
  }

  const alerts = [];

  if (temperature_out > TEMP_CRITICAL_C) {
    alerts.push({ code: 'E_TEMP_HIGH', msg: `Outlet ${temperature_out}°C exceeds critical threshold (${TEMP_CRITICAL_C}°C)` });
  }
  if (fan_speed_in < FAN_FAILURE_RPM) {
    alerts.push({ code: 'E_FAN_FAIL', msg: `Inlet fan ${fan_speed_in} RPM — below 2000 RPM threshold` });
  }
  if (fan_speed_out < FAN_FAILURE_RPM) {
    alerts.push({ code: 'E_FAN_FAIL', msg: `Outlet fan ${fan_speed_out} RPM — below 2000 RPM threshold` });
  }

  let healthStatus = 'HEALTHY';
  if (alerts.some((a) => a.code === 'E_TEMP_HIGH' && temperature_out > TEMP_CRITICAL_C)) {
    healthStatus = 'CRITICAL';
  } else if (alerts.some((a) => a.code === 'E_FAN_FAIL')) {
    healthStatus = 'DEGRADED';
  } else if (temperature_out > TEMP_WARNING_C) {
    healthStatus = 'WARNING';
  }

  return { healthStatus, activeAlerts: alerts };
}
