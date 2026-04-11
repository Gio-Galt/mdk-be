/**
 * mapping.js
 * 
 * Maps the raw responses from Whatsminer's CGMiner summary logic (hardware.js)
 * down to the rigid MDK Contract required by ORK. Look at mdk-contract.json telemetry schema
 * for expected keys.
 */

export function translateTelemetry(rawResponse) {
  const summary = rawResponse.SUMMARY[0];

  return {
    hashrate_rt: summary["GHS 5s"] / 1000, // Convert GHS to THS
    hashrate_avg: summary["GHS av"] / 1000,
    power_draw: summary["Power"],
    temperature_in: summary["Temp In"],
    temperature_out: summary["Temp Out"],
    fan_speed_in: summary["Fan In"],
    fan_speed_out: summary["Fan Out"]
  };
}

export function translateHealth(rawHealth) {
  let mappedState = "OK";
  let activeAlerts = [];

  if (rawHealth.status === 'Booting') {
    mappedState = "DEGRADED";
  }

  if (rawHealth.errors.includes('E_TEMP_HIGH')) {
    activeAlerts.push('alert.overheat');
    mappedState = "DEGRADED";
  }

  return {
    state: mappedState,
    alerts: activeAlerts
  };
}
