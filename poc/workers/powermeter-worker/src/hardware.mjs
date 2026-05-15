/**
 * Powermeter Hardware Simulator
 * Manages 10 Schneider PM8000 smart meters — one per mining rack.
 * In production this would use Modbus TCP or the EcoStruxure REST API.
 *
 * Device roster — diverse operational scenarios for rich visualization:
 *   pm001  Rack-01  HEALTHY         — stable, typical load ~8 kW
 *   pm002  Rack-02  HEALTHY         — stable, slightly higher load ~9 kW
 *   pm003  Rack-03  HEALTHY         — stable, low load (6 miners on rack)
 *   pm004  Rack-04  HEALTHY         — stable, full rack 10 kW
 *   pm005  Rack-05  WARNING         — approaching threshold (9.8 kW, limit 10 kW)
 *   pm006  Rack-06  CRITICAL        — threshold exceeded (11.2 kW, limit 10 kW)
 *   pm007  Rack-07  DEGRADED        — circuit breaker open (load shed)
 *   pm008  Rack-08  WARNING         — overvoltage (248 V)
 *   pm009  Rack-09  DEGRADED        — low power factor (0.83)
 *   pm010  Rack-10  HEALTHY         — new rack, low energy counter
 */

const HISTORY_LEN = 20;

function jitter(range) { return (Math.random() - 0.5) * 2 * range; }
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function mkRolling(base, variance, len = HISTORY_LEN) {
  const arr = [];
  let v = base;
  for (let i = 0; i < len; i++) {
    v = clamp(v + jitter(variance), 0, base * 1.3);
    arr.push(parseFloat(v.toFixed(2)));
  }
  arr[arr.length - 1] = parseFloat(base.toFixed(2));
  return arr;
}

class PowermeterDevice {
  constructor({ deviceId, rackLabel, ip, nominal, circuit = true }) {
    this.deviceId  = deviceId;
    this.rackLabel = rackLabel;
    this.ip        = ip;

    this._nom = { ...nominal };
    this.state = {
      voltage_v:        nominal.voltage_v,
      current_a:        nominal.current_a,
      power_factor:     nominal.power_factor,
      energy_kwh:       nominal.energy_kwh,
      frequency_hz:     nominal.frequency_hz,
      circuit_enabled:  circuit,
      alert_threshold_kw: nominal.alert_threshold_kw ?? 10.0,
    };

    this._history = {
      power_kw:    mkRolling(this._computePower(nominal), 0.3),
      current_a:   mkRolling(nominal.current_a, 0.8),
      voltage_v:   mkRolling(nominal.voltage_v, 0.5),
    };
  }

  _computePower(s) {
    return parseFloat(((s.voltage_v * s.current_a * s.power_factor) / 1000).toFixed(2));
  }

  _tick() {
    if (!this.state.circuit_enabled) {
      // No load — just keep voltage present
      this.state.current_a = 0;
      this.state.energy_kwh = parseFloat((this.state.energy_kwh + 0).toFixed(2));
      return;
    }

    this.state.voltage_v    = parseFloat(clamp(this.state.voltage_v    + jitter(0.4), 195, 260).toFixed(1));
    this.state.current_a    = parseFloat(clamp(this.state.current_a    + jitter(0.5), 0,   60) .toFixed(1));
    this.state.power_factor = parseFloat(clamp(this.state.power_factor + jitter(0.005), 0.7, 1.0).toFixed(3));
    this.state.frequency_hz = parseFloat(clamp(this.state.frequency_hz + jitter(0.02), 49.5, 50.5).toFixed(2));

    // Accumulate energy at realistic rate (~10 kWh/hour → 0.00028 kWh/second → ~2.8 per tick at 10s)
    const kw = this._computePower(this.state);
    this.state.energy_kwh   = parseFloat((this.state.energy_kwh + kw * (10 / 3600)).toFixed(2));
  }

  _updateHistory() {
    const push = (arr, v) => { arr.push(v); if (arr.length > HISTORY_LEN) arr.shift(); };
    push(this._history.power_kw,  this._computePower(this.state));
    push(this._history.current_a, this.state.current_a);
    push(this._history.voltage_v, this.state.voltage_v);
  }

  getRaw() {
    this._tick();
    this._updateHistory();
    return {
      voltage_v:          this.state.voltage_v,
      current_a:          this.state.current_a,
      power_kw:           this._computePower(this.state),
      power_factor:       this.state.power_factor,
      energy_kwh:         this.state.energy_kwh,
      frequency_hz:       this.state.frequency_hz,
      circuit_enabled:    this.state.circuit_enabled,
      alert_threshold_kw: this.state.alert_threshold_kw,
    };
  }

  getHistory() {
    return {
      power_kw:  [...this._history.power_kw],
      current_a: [...this._history.current_a],
      voltage_v: [...this._history.voltage_v],
    };
  }

  executeCommand(commandName, params) {
    switch (commandName) {
      case 'setCircuitBreaker': {
        const { enabled } = params;
        if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
        this.state.circuit_enabled = enabled;
        if (!enabled) { this.state.current_a = 0; }
        console.log(`[PowermeterHW ${this.deviceId}] Circuit breaker → ${enabled ? 'CLOSED' : 'OPEN'}`);
        return { ack: enabled ? 'CIRCUIT_CLOSED' : 'CIRCUIT_OPEN', circuit_enabled: enabled };
      }
      case 'resetEnergyCounter': {
        const prev = this.state.energy_kwh;
        this.state.energy_kwh = 0;
        console.log(`[PowermeterHW ${this.deviceId}] Energy counter reset (was ${prev} kWh)`);
        return { ack: 'COUNTER_RESET', previousValue_kwh: prev };
      }
      case 'setAlertThreshold': {
        const { power_kw_limit } = params;
        if (power_kw_limit < 1 || power_kw_limit > 50) throw new Error('power_kw_limit out of range 1–50 kW');
        this.state.alert_threshold_kw = power_kw_limit;
        console.log(`[PowermeterHW ${this.deviceId}] Alert threshold → ${power_kw_limit} kW`);
        return { ack: 'THRESHOLD_UPDATED', alert_threshold_kw: power_kw_limit };
      }
      default:
        throw new Error(`Command not supported: ${commandName}`);
    }
  }
}

// ── Device registry ────────────────────────────────────────────────────────

const DEVICES = [
  new PowermeterDevice({
    deviceId: 'pm001', rackLabel: 'Rack-01', ip: '10.0.2.1',
    nominal: { voltage_v: 231, current_a: 35.2, power_factor: 0.97, energy_kwh: 12840, frequency_hz: 50.01, alert_threshold_kw: 10.0 },
  }),
  new PowermeterDevice({
    deviceId: 'pm002', rackLabel: 'Rack-02', ip: '10.0.2.2',
    nominal: { voltage_v: 230, current_a: 38.5, power_factor: 0.97, energy_kwh: 14220, frequency_hz: 49.99, alert_threshold_kw: 10.0 },
  }),
  new PowermeterDevice({
    deviceId: 'pm003', rackLabel: 'Rack-03', ip: '10.0.2.3',
    nominal: { voltage_v: 232, current_a: 28.0, power_factor: 0.98, energy_kwh: 9600, frequency_hz: 50.02, alert_threshold_kw: 8.0 },
  }),
  new PowermeterDevice({
    deviceId: 'pm004', rackLabel: 'Rack-04', ip: '10.0.2.4',
    nominal: { voltage_v: 229, current_a: 43.8, power_factor: 0.97, energy_kwh: 16100, frequency_hz: 50.00, alert_threshold_kw: 11.0 },
  }),
  (() => {
    // pm005 — approaching threshold
    const d = new PowermeterDevice({
      deviceId: 'pm005', rackLabel: 'Rack-05', ip: '10.0.2.5',
      nominal: { voltage_v: 231, current_a: 44.5, power_factor: 0.96, energy_kwh: 18400, frequency_hz: 49.98, alert_threshold_kw: 10.0 },
    });
    d.state.current_a = 44.5;
    return d;
  })(),
  (() => {
    // pm006 — threshold exceeded (11.2 kW, limit 10 kW)
    const d = new PowermeterDevice({
      deviceId: 'pm006', rackLabel: 'Rack-06', ip: '10.0.2.6',
      nominal: { voltage_v: 233, current_a: 48.0, power_factor: 0.95, energy_kwh: 22700, frequency_hz: 50.00, alert_threshold_kw: 10.0 },
    });
    d.state.current_a = 48.0;
    d._history.power_kw  = mkRolling(10.6, 0.4);
    d._history.current_a = mkRolling(48, 1.2);
    return d;
  })(),
  new PowermeterDevice({
    deviceId: 'pm007', rackLabel: 'Rack-07', ip: '10.0.2.7',
    nominal: { voltage_v: 230, current_a: 0, power_factor: 0.0, energy_kwh: 11250, frequency_hz: 50.01, alert_threshold_kw: 10.0 },
    circuit: false,
  }),
  (() => {
    // pm008 — overvoltage
    const d = new PowermeterDevice({
      deviceId: 'pm008', rackLabel: 'Rack-08', ip: '10.0.2.8',
      nominal: { voltage_v: 248, current_a: 37.2, power_factor: 0.95, energy_kwh: 13900, frequency_hz: 50.00, alert_threshold_kw: 10.0 },
    });
    d.state.voltage_v = 248;
    d._history.voltage_v = mkRolling(248, 1.5);
    return d;
  })(),
  (() => {
    // pm009 — low power factor
    const d = new PowermeterDevice({
      deviceId: 'pm009', rackLabel: 'Rack-09', ip: '10.0.2.9',
      nominal: { voltage_v: 230, current_a: 40.5, power_factor: 0.83, energy_kwh: 17600, frequency_hz: 49.97, alert_threshold_kw: 10.0 },
    });
    d.state.power_factor = 0.83;
    return d;
  })(),
  new PowermeterDevice({
    deviceId: 'pm010', rackLabel: 'Rack-10', ip: '10.0.2.10',
    nominal: { voltage_v: 231, current_a: 24.8, power_factor: 0.98, energy_kwh: 142, frequency_hz: 50.01, alert_threshold_kw: 10.0 },
  }),
];

const DEVICE_MAP = new Map(DEVICES.map((d) => [d.deviceId, d]));

export function getDevices() {
  return DEVICES.map((d) => ({ deviceId: d.deviceId, rackLabel: d.rackLabel, ip: d.ip }));
}

export function fetchRaw(deviceId) {
  const d = DEVICE_MAP.get(deviceId);
  if (!d) throw new Error(`Unknown deviceId: ${deviceId}`);
  return { raw: d.getRaw(), history: d.getHistory() };
}

export function executeCommand(deviceId, commandName, params) {
  const d = DEVICE_MAP.get(deviceId);
  if (!d) throw new Error(`Unknown deviceId: ${deviceId}`);
  return d.executeCommand(commandName, params);
}
