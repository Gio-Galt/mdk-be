/**
 * Miner Hardware Simulator
 * Manages 10 physical Whatsminer devices with realistic mock state.
 * In production this would use the Whatsminer CGMiner API (TCP port 4028) or REST API.
 *
 * Device roster — covers varied operational scenarios for rich UI visualization:
 *   wm001  M60S  HEALTHY   — top performer, high hashrate
 *   wm002  M56S  HEALTHY   — normal operation
 *   wm003  M50S  HEALTHY   — normal operation
 *   wm004  M50S  HEALTHY   — slightly warm ambient
 *   wm005  M50S  CRITICAL  — overheating (temp >90C)
 *   wm006  M30S  DEGRADED  — inlet fan failure (<2000 RPM)
 *   wm007  M56S  HEALTHY   — power-throttled (setPowerLimit applied)
 *   wm008  M30S  OFFLINE   — unreachable (hashrate 0, minimal power)
 *   wm009  M50S  WARNING   — high temp approaching critical (82C)
 *   wm010  M60S  HEALTHY   — recently rebooted, hashrate climbing
 */

const HISTORY_LEN = 20;

function jitter(range) { return (Math.random() - 0.5) * 2 * range; }
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function mkRolling(current, variance, len = HISTORY_LEN) {
  const arr = [];
  let v = current * 0.85;
  for (let i = 0; i < len; i++) {
    v = clamp(v + jitter(variance), 0, current * 1.15);
    arr.push(parseFloat(v.toFixed(1)));
  }
  arr[arr.length - 1] = parseFloat(current.toFixed(1));
  return arr;
}

class MinerDevice {
  constructor({ deviceId, model, ip, nominal }) {
    this.deviceId = deviceId;
    this.model    = model;
    this.ip       = ip;

    // Nominal spec for this unit
    this._nom = nominal;

    // Live state (mutated by commands)
    this.state = { ...nominal };

    // Rolling history buffers
    this._history = {
      hashrate_rt:    mkRolling(nominal.hashrate,    5),
      temperature_out: mkRolling(nominal.temperature_out, 2),
      power_draw:     mkRolling(nominal.power_draw,  80),
    };

    // Reboot animation state
    this._rebootUntil = 0;
    this._rebootPhase = 0; // 0..10 → climbing hashrate
  }

  _tick() {
    const now = Date.now();

    // Reboot sequence: zero out for 3 min, then climb back
    if (this._rebootUntil > now) {
      this.state.hashrate    = 0;
      this.state.power_draw  = 60;
      this.state.temperature_out = 0;
      this.state.fan_speed_in    = 0;
      this.state.fan_speed_out   = 0;
      return;
    }
    if (this._rebootUntil && now > this._rebootUntil) {
      // Recovery ramp (takes ~2 minutes after reboot completes)
      this._rebootPhase = Math.min(10, this._rebootPhase + 1);
      const frac = this._rebootPhase / 10;
      this.state.hashrate         = parseFloat((this._nom.hashrate * frac).toFixed(1));
      this.state.power_draw       = parseFloat((this._nom.power_draw * (0.3 + 0.7 * frac)).toFixed(0));
      this.state.temperature_out  = parseFloat((this._nom.temperature_out * frac).toFixed(1));
      this.state.fan_speed_in     = parseFloat((this._nom.fan_speed_in * (0.5 + 0.5 * frac)).toFixed(0));
      this.state.fan_speed_out    = parseFloat((this._nom.fan_speed_out * (0.5 + 0.5 * frac)).toFixed(0));
      if (this._rebootPhase >= 10) { this._rebootUntil = 0; this._rebootPhase = 0; }
      return;
    }

    // Normal jitter
    if (this.state.hashrate > 0) {
      this.state.hashrate = parseFloat(clamp(this.state.hashrate + jitter(1.2), 0, this._nom.hashrate * 1.05).toFixed(1));
    }
    this.state.power_draw = parseFloat(clamp(this.state.power_draw + jitter(40), 0, this._nom.power_draw * 1.1).toFixed(0));
    if (!this.state._fanBroken) {
      this.state.temperature_out = parseFloat(clamp(this.state.temperature_out + jitter(0.8), 0, 100).toFixed(1));
      this.state.fan_speed_in    = parseFloat(clamp(this.state.fan_speed_in  + jitter(60), 0, 6000).toFixed(0));
      this.state.fan_speed_out   = parseFloat(clamp(this.state.fan_speed_out + jitter(60), 0, 6000).toFixed(0));
    }
    this.state.temperature_in = parseFloat(clamp(this.state.temperature_in + jitter(0.3), 15, 50).toFixed(1));
  }

  _updateHistory() {
    const push = (arr, v) => { arr.push(v); if (arr.length > HISTORY_LEN) arr.shift(); };
    push(this._history.hashrate_rt,     this.state.hashrate);
    push(this._history.temperature_out, this.state.temperature_out);
    push(this._history.power_draw,      this.state.power_draw);
  }

  getRaw() {
    this._tick();
    this._updateHistory();
    return {
      hashrate_rt:     this.state.hashrate,
      hashrate_avg:    parseFloat((this.state.hashrate * 0.97 + jitter(0.5)).toFixed(1)),
      power_draw:      this.state.power_draw,
      temperature_in:  this.state.temperature_in,
      temperature_out: this.state.temperature_out,
      fan_speed_in:    this.state.fan_speed_in,
      fan_speed_out:   this.state.fan_speed_out,
    };
  }

  getHistory() {
    return {
      hashrate_rt:     [...this._history.hashrate_rt],
      temperature_out: [...this._history.temperature_out],
      power_draw:      [...this._history.power_draw],
    };
  }

  executeCommand(commandName, params) {
    switch (commandName) {
      case 'reboot': {
        console.log(`[MinerHW ${this.deviceId}] Initiating reboot...`);
        this._rebootUntil = Date.now() + 3 * 60 * 1000; // 3 min
        this._rebootPhase = 0;
        return { ack: 'REBOOTING', estimatedDowntimeMs: 180000 };
      }
      case 'setPowerLimit': {
        const { limit_watts } = params;
        if (limit_watts < 2000) throw new Error('limit_watts below minimum 2000W');
        if (limit_watts > 4000) throw new Error('limit_watts exceeds maximum 4000W');
        const ratio = limit_watts / this._nom.power_draw;
        this.state.power_draw      = limit_watts - parseFloat(jitter(50).toFixed(0));
        this.state.hashrate        = parseFloat((this._nom.hashrate * clamp(ratio, 0.6, 1)).toFixed(1));
        this.state.temperature_out = parseFloat((this._nom.temperature_out * clamp(ratio, 0.7, 1)).toFixed(1));
        console.log(`[MinerHW ${this.deviceId}] Power limit set → ${limit_watts}W`);
        return { ack: 'APPLIED', limit_watts, effectiveHashrateTH: this.state.hashrate };
      }
      case 'setPools': {
        const { pool1_url, pool1_user } = params;
        console.log(`[MinerHW ${this.deviceId}] Pools updated → ${pool1_url} / ${pool1_user}`);
        return { ack: 'POOL_UPDATED', pool1_url };
      }
      default:
        throw new Error(`Command not supported: ${commandName}`);
    }
  }
}

// ── Device registry ────────────────────────────────────────────────────────

const DEVICES = [
  new MinerDevice({
    deviceId: 'wm001', model: 'M60S', ip: '10.0.1.1',
    nominal: { hashrate: 120.0, power_draw: 3800, temperature_in: 28, temperature_out: 68, fan_speed_in: 5200, fan_speed_out: 5300 },
  }),
  new MinerDevice({
    deviceId: 'wm002', model: 'M56S', ip: '10.0.1.2',
    nominal: { hashrate: 110.5, power_draw: 3520, temperature_in: 31, temperature_out: 72, fan_speed_in: 4800, fan_speed_out: 4850 },
  }),
  new MinerDevice({
    deviceId: 'wm003', model: 'M50S', ip: '10.0.1.3',
    nominal: { hashrate: 104.2, power_draw: 3200, temperature_in: 33, temperature_out: 70, fan_speed_in: 4600, fan_speed_out: 4680 },
  }),
  new MinerDevice({
    deviceId: 'wm004', model: 'M50S', ip: '10.0.1.4',
    nominal: { hashrate: 105.0, power_draw: 3210, temperature_in: 42, temperature_out: 79, fan_speed_in: 4350, fan_speed_out: 4400 },
  }),
  (() => {
    // wm005 — overheating scenario
    const d = new MinerDevice({
      deviceId: 'wm005', model: 'M50S', ip: '10.0.1.5',
      nominal: { hashrate: 92.0, power_draw: 3300, temperature_in: 45, temperature_out: 93, fan_speed_in: 4200, fan_speed_out: 4150 },
    });
    d.state.temperature_out = 93.5;
    d._history.temperature_out = mkRolling(93.5, 1);
    return d;
  })(),
  (() => {
    // wm006 — fan failure scenario
    const d = new MinerDevice({
      deviceId: 'wm006', model: 'M30S', ip: '10.0.1.6',
      nominal: { hashrate: 72.0, power_draw: 2500, temperature_in: 38, temperature_out: 85, fan_speed_in: 1100, fan_speed_out: 4450 },
    });
    d.state._fanBroken = true;
    d.state.fan_speed_in   = 1100;
    d.state.temperature_out = 85;
    return d;
  })(),
  (() => {
    // wm007 — throttled via setPowerLimit
    const d = new MinerDevice({
      deviceId: 'wm007', model: 'M56S', ip: '10.0.1.7',
      nominal: { hashrate: 98.0, power_draw: 2800, temperature_in: 32, temperature_out: 71, fan_speed_in: 4700, fan_speed_out: 4750 },
    });
    d.state.power_draw = 2800;
    return d;
  })(),
  (() => {
    // wm008 — offline
    const d = new MinerDevice({
      deviceId: 'wm008', model: 'M30S', ip: '10.0.1.8',
      nominal: { hashrate: 0, power_draw: 45, temperature_in: 26, temperature_out: 0, fan_speed_in: 0, fan_speed_out: 0 },
    });
    d.state.hashrate = 0;
    d.state.power_draw = 45;
    d._history.hashrate_rt    = [72, 70, 65, 40, 12, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    d._history.temperature_out = [68, 60, 45, 25, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    return d;
  })(),
  new MinerDevice({
    deviceId: 'wm009', model: 'M50S', ip: '10.0.1.9',
    nominal: { hashrate: 100.0, power_draw: 3200, temperature_in: 40, temperature_out: 83, fan_speed_in: 4100, fan_speed_out: 4050 },
  }),
  (() => {
    // wm010 — recently rebooted, climbing back up
    const d = new MinerDevice({
      deviceId: 'wm010', model: 'M60S', ip: '10.0.1.10',
      nominal: { hashrate: 118.0, power_draw: 3750, temperature_in: 29, temperature_out: 66, fan_speed_in: 5100, fan_speed_out: 5150 },
    });
    // Start mid-recovery
    d.state.hashrate        = 72.0;
    d.state.power_draw      = 2100;
    d.state.temperature_out = 42.0;
    d._rebootUntil = 0;
    d._rebootPhase = 6; // ~60% recovered
    d._history.hashrate_rt    = [118, 115, 0, 0, 0, 0, 15, 35, 55, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72];
    d._history.temperature_out = [65, 60, 0, 0, 0, 0, 12, 28, 38, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42];
    return d;
  })(),
];

const DEVICE_MAP = new Map(DEVICES.map((d) => [d.deviceId, d]));

export function getDevices() {
  return DEVICES.map((d) => ({ deviceId: d.deviceId, model: d.model, ip: d.ip }));
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
