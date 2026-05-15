/**
 * Powermeter mapping layer — normalizes raw PM8000 readings into
 * the MDK Contract schema (mdk-contract.json §capabilities.telemetry).
 *
 * Computes healthStatus and activeAlerts based on PM-specific thresholds
 * so ORK and App Node consume a uniform device row format.
 */

const VOLT_MAX    = 250;   // V — overvoltage threshold
const VOLT_MIN    = 200;   // V — undervoltage threshold
const PF_MIN      = 0.90;  // power factor minimum
const PF_WARN     = 0.92;  // power factor warning

export function translateTelemetry(raw) {
  return {
    voltage_v:          parseFloat(raw.voltage_v.toFixed(1)),
    current_a:          parseFloat(raw.current_a.toFixed(1)),
    power_kw:           parseFloat(raw.power_kw.toFixed(2)),
    power_factor:       parseFloat(raw.power_factor.toFixed(3)),
    energy_kwh:         parseFloat(raw.energy_kwh.toFixed(1)),
    frequency_hz:       parseFloat(raw.frequency_hz.toFixed(2)),
    circuit_enabled:    raw.circuit_enabled,
    alert_threshold_kw: parseFloat(raw.alert_threshold_kw.toFixed(1)),
  };
}

export function computeHealth(metrics) {
  const {
    voltage_v, current_a, power_kw, power_factor,
    circuit_enabled, alert_threshold_kw,
  } = metrics;

  if (!circuit_enabled) {
    return {
      healthStatus:  'DEGRADED',
      activeAlerts:  [{ code: 'alert.circuit_open', msg: 'Circuit breaker is open — rack has no power (load shed or manual lockout)' }],
    };
  }

  const alerts = [];

  if (voltage_v > VOLT_MAX) {
    alerts.push({ code: 'E_OVERVOLT', msg: `Voltage ${voltage_v}V exceeds safe upper bound (${VOLT_MAX}V)` });
  }
  if (voltage_v < VOLT_MIN && current_a > 0) {
    alerts.push({ code: 'E_UNDERVOLT', msg: `Voltage ${voltage_v}V below safe lower bound (${VOLT_MIN}V)` });
  }
  if (power_factor < PF_MIN && current_a > 5) {
    alerts.push({ code: 'E_LOW_PF', msg: `Power factor ${power_factor.toFixed(2)} below minimum (${PF_MIN}) — check rack PSUs` });
  }
  if (power_kw > alert_threshold_kw) {
    alerts.push({ code: 'alert.threshold_exceeded', msg: `Power ${power_kw.toFixed(1)} kW exceeds threshold ${alert_threshold_kw} kW` });
  }

  let healthStatus = 'HEALTHY';
  if (alerts.some((a) => a.code === 'alert.threshold_exceeded' || a.code === 'E_OVERVOLT')) {
    healthStatus = 'CRITICAL';
  } else if (alerts.some((a) => a.code === 'E_LOW_PF' || a.code === 'E_UNDERVOLT')) {
    healthStatus = 'DEGRADED';
  } else if (power_factor < PF_WARN && current_a > 5) {
    healthStatus = 'WARNING';
  } else if (voltage_v > 245) {
    healthStatus = 'WARNING';
  }

  return { healthStatus, activeAlerts: alerts };
}
