/**
 * MDK Agent Studio — contract-driven HTML UI renderer
 * Generates self-contained HTML pages from live telemetry + an agent plan.
 *
 * Visualization types:
 *   thermal_grid   — gauge cards sorted by outlet temp
 *   fleet_summary  — KPI boxes + per-site table + alert list
 *   full_table     — sortable metrics table (all contract telemetry fields)
 *   action_result  — command dispatch result per targeted device
 *   metric_focus   — horizontal bar focus on arbitrary telemetry fields
 *   health_status  — health board with status badges and alert log
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * SVG semi-circle gauge.
 * Track: upper semicircle from left (10,62) through top (60,12) to right (110,62).
 * Formula: for percentage p, arc endpoint angle = π*(1-p), sweep=0 (CCW in SVG).
 */
function semiGauge(value, maxVal, { unit = '', warnPct = 0.65, critPct = 0.85 } = {}) {
  const pct = Math.max(0, Math.min(1, Number(value) / Number(maxVal)));
  const color =
    pct >= critPct ? '#e85d4c' : pct >= warnPct ? '#d4a017' : '#3fb950';

  const cx = 60, cy = 62, r = 50;
  let fillPath = '';
  if (pct >= 1) {
    fillPath = `M 10 62 A 50 50 0 0 0 110 62`;
  } else if (pct > 0) {
    const angle = Math.PI * (1 - pct);
    const ex = cx + r * Math.cos(angle);
    const ey = cy - r * Math.sin(angle);
    fillPath = `M 10 62 A 50 50 0 0 0 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
  }

  const disp =
    value == null || value === ''
      ? '—'
      : typeof value === 'number'
        ? value % 1 === 0
          ? value
          : value.toFixed(1)
        : value;

  return `<svg viewBox="0 0 120 72" width="110" height="66" style="display:block;margin:0 auto">
  <path d="M 10 62 A 50 50 0 0 0 110 62" fill="none" stroke="#232d3c" stroke-width="9" stroke-linecap="round"/>
  ${fillPath ? `<path d="${fillPath}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"/>` : ''}
  <text x="60" y="57" text-anchor="middle" font-size="19" font-weight="700" fill="${color}" font-family="ui-monospace,monospace">${esc(disp)}</text>
  <text x="60" y="68" text-anchor="middle" font-size="8.5" fill="#8b98a8" font-family="ui-sans-serif,sans-serif">${esc(unit)}</text>
</svg>`;
}

/** Thin horizontal bar for a percentage. */
function hbar(value, maxVal, { color = '#58a6ff', height = 6 } = {}) {
  const pct = (Math.max(0, Math.min(1, Number(value) / Number(maxVal))) * 100).toFixed(1);
  return `<div style="background:#1a2230;border-radius:4px;height:${height}px;overflow:hidden">
  <div style="width:${pct}%;height:100%;background:${color};border-radius:4px"></div>
</div>`;
}

/** Tiny inline sparkline SVG. */
function sparkline(values, width = 64, height = 20, color = '#8b98a8') {
  if (!values?.length || values.length < 2) return '';
  const nums = values.map(Number);
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const pts = nums
    .map((v, i) => {
      const x = (i / (nums.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="overflow:visible;display:inline-block;vertical-align:middle">
  <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
</svg>`;
}

const STATUS_STYLE = {
  HEALTHY:  { bg: 'rgba(63,185,80,0.15)',   fg: '#3fb950', dot: '#3fb950' },
  WARNING:  { bg: 'rgba(212,160,23,0.15)',  fg: '#d4a017', dot: '#d4a017' },
  DEGRADED: { bg: 'rgba(212,160,23,0.15)',  fg: '#d4a017', dot: '#d4a017' },
  CRITICAL: { bg: 'rgba(232,93,76,0.15)',   fg: '#e85d4c', dot: '#e85d4c' },
  OFFLINE:  { bg: 'rgba(139,152,163,0.15)', fg: '#8b98a8', dot: '#8b98a8' },
};

function statusBadge(status) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.HEALTHY;
  return `<span style="background:${s.bg};color:${s.fg};padding:2px 8px;border-radius:999px;font-size:0.68rem;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;display:inline-flex;align-items:center;gap:4px">
  <span style="width:5px;height:5px;border-radius:50%;background:${s.dot};display:inline-block"></span>${esc(status)}
</span>`;
}

function alertChip(code) {
  return `<span style="background:rgba(232,93,76,0.15);color:#e85d4c;padding:1px 6px;border-radius:4px;font-size:0.65rem;font-weight:600;font-family:ui-monospace,monospace">${esc(code)}</span>`;
}

/** Common page wrapper with MDK dark theme. */
function pageWrapper(body, { title = '', narrative = '', rationale = '', generatedBy = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>
:root{--bg:#0a0b0d;--surface:#10151e;--elevated:#171d27;--border:#252e3c;--text:#e6ecf3;--muted:#8b98a8;--accent:#f7931a;--red:#e85d4c;--yellow:#d4a017;--green:#3fb950;--blue:#58a6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:"DM Sans",ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.5;padding:16px}
h1{margin:0 0 4px;font-size:1.15rem;font-weight:700;letter-spacing:-0.01em}
h2{margin:16px 0 8px;font-size:0.82rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted)}
.narrative{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:0.88rem;line-height:1.6}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}
.card{background:var(--elevated);border:1px solid var(--border);border-radius:10px;padding:12px}
.card-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px;margin-bottom:10px}
.device-id{font-weight:700;font-size:0.95rem}
.pill{background:rgba(255,255,255,0.05);color:var(--muted);border-radius:999px;padding:1px 7px;font-size:0.65rem}
.metric-row{display:flex;align-items:center;justify-content:space-between;margin-top:6px}
.metric-label{font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em}
.metric-val{font-size:0.88rem;font-weight:600}
.alerts{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px}
.divider{border:none;border-top:1px solid var(--border);margin:12px 0}
table{width:100%;border-collapse:collapse;font-size:0.82rem}
th{text-align:left;padding:6px 10px;color:var(--muted);font-size:0.68rem;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border)}
td{padding:7px 10px;border-bottom:1px solid rgba(37,46,60,0.6)}
tr:hover td{background:rgba(255,255,255,0.02)}
.td-crit{color:var(--red);font-weight:600}
.td-warn{color:var(--yellow);font-weight:600}
.td-ok{color:var(--green)}
.kpi-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));margin-bottom:16px}
.kpi{background:var(--elevated);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center}
.kpi-val{font-size:1.6rem;font-weight:800;letter-spacing:-0.03em;color:var(--accent)}
.kpi-label{font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin-top:2px}
.kpi-sub{font-size:0.75rem;color:var(--muted);margin-top:4px}
.bar-row{display:grid;grid-template-columns:80px 1fr 50px;gap:8px;align-items:center;margin-bottom:8px}
.bar-device{font-size:0.78rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-val{font-size:0.78rem;text-align:right;color:var(--muted)}
.result-box{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px}
.cmd-badge{background:rgba(247,147,26,0.15);color:var(--accent);padding:2px 8px;border-radius:6px;font-family:ui-monospace,monospace;font-size:0.8rem;font-weight:600;display:inline-block;margin-bottom:6px}
.ok-badge{background:rgba(63,185,80,0.15);color:var(--green);padding:2px 8px;border-radius:6px;font-size:0.75rem;font-weight:600}
.rationale{margin-top:14px;font-size:0.72rem;color:var(--muted);border-top:1px solid var(--border);padding-top:8px}
footer{margin-top:16px;font-size:0.68rem;color:var(--muted)}
</style>
</head>
<body>
${narrative ? `<div class="narrative">${esc(narrative)}</div>` : ''}
<h1>${esc(title)}</h1>
${body}
${rationale ? `<p class="rationale">LLM rationale: ${esc(rationale)}</p>` : ''}
<footer>${esc(generatedBy)}</footer>
</body>
</html>`;
}

// ── Visualization: thermal_grid ──────────────────────────────────────────────

function renderThermalGrid(rows, contractDoc) {
  const TEMP_MAX = 100;
  const TEMP_CRIT = 85;
  const telemetry = contractDoc?.capabilities?.telemetry ?? [];

  const sorted = [...rows].sort(
    (a, b) => (b.metrics?.temperature_out ?? 0) - (a.metrics?.temperature_out ?? 0)
  );

  const cards = sorted.map((row) => {
    const m = row.metrics ?? {};
    const tempOut = m.temperature_out ?? 0;
    const tempIn = m.temperature_in ?? 0;
    const fanIn = m.fan_speed_in ?? 0;
    const fanOut = m.fan_speed_out ?? 0;
    const status = row.healthStatus ?? 'HEALTHY';
    const alerts = row.activeAlerts ?? [];
    const hist = row.history?.temperature_out;
    const histColor =
      tempOut > TEMP_CRIT ? '#e85d4c' : tempOut > 75 ? '#d4a017' : '#3fb950';

    return `<div class="card">
  <div class="card-header">
    <span class="device-id">${esc(row.deviceId)}</span>
    ${statusBadge(status)}
  </div>
  <span class="pill">${esc(row.siteId)} · ${esc(row.workerType ?? 'worker')}</span>
  <div style="margin:10px 0 4px">
    ${semiGauge(tempOut, TEMP_MAX, { unit: '°C  outlet', warnPct: 0.75, critPct: 0.88 })}
    <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:4px">
      ${hist ? sparkline(hist, 64, 18, histColor) : ''}
      <span style="font-size:0.7rem;color:var(--muted)">last 10 reads</span>
    </div>
  </div>
  <hr class="divider"/>
  <div class="metric-row"><span class="metric-label">Inlet temp</span><span class="metric-val">${esc(tempIn)}°C</span></div>
  <div style="margin:6px 0">${hbar(tempIn, 80, { color: tempIn > 45 ? '#d4a017' : '#58a6ff' })}</div>
  <div class="metric-row"><span class="metric-label">Fan in</span><span class="metric-val ${fanIn < 2000 ? 'td-crit' : ''}">${esc(fanIn)} RPM</span></div>
  <div style="margin:4px 0">${hbar(fanIn, 6000, { color: fanIn < 2000 ? '#e85d4c' : '#3fb950' })}</div>
  <div class="metric-row"><span class="metric-label">Fan out</span><span class="metric-val ${fanOut < 2000 ? 'td-crit' : ''}">${esc(fanOut)} RPM</span></div>
  <div style="margin:4px 0">${hbar(fanOut, 6000, { color: fanOut < 2000 ? '#e85d4c' : '#3fb950' })}</div>
  ${alerts.length ? `<div class="alerts">${alerts.map((a) => alertChip(a.code)).join('')}</div>` : ''}
</div>`;
  }).join('\n');

  return `<div class="grid">${cards}</div>`;
}

// ── Visualization: fleet_summary ─────────────────────────────────────────────

function renderFleetSummary(rows, contractDoc) {
  const online = rows.filter((r) => r.healthStatus !== 'OFFLINE');
  const critical = rows.filter((r) => r.healthStatus === 'CRITICAL');
  const degraded = rows.filter((r) => r.healthStatus === 'DEGRADED');

  const totalHash = online.reduce((s, r) => s + (r.metrics?.hashrate_rt ?? 0), 0);
  const totalPowerKw = rows.reduce((s, r) => s + (r.metrics?.power_draw ?? 0), 0) / 1000;
  const avgTempOut =
    online.length
      ? (online.reduce((s, r) => s + (r.metrics?.temperature_out ?? 0), 0) / online.length).toFixed(1)
      : '—';

  const kpis = `<div class="kpi-grid">
  <div class="kpi">
    <div class="kpi-val">${totalHash.toFixed(1)}</div>
    <div class="kpi-label">Hashrate TH/s</div>
    <div class="kpi-sub">${online.length} active devices</div>
  </div>
  <div class="kpi">
    <div class="kpi-val" style="color:${critical.length ? '#e85d4c' : '#3fb950'}">${rows.length - critical.length - degraded.length}</div>
    <div class="kpi-label">Healthy devices</div>
    <div class="kpi-sub">${rows.length} total</div>
  </div>
  <div class="kpi">
    <div class="kpi-val" style="color:${Number(avgTempOut) > 75 ? '#d4a017' : 'var(--accent)'}">${avgTempOut}°C</div>
    <div class="kpi-label">Avg outlet temp</div>
    <div class="kpi-sub">online devices only</div>
  </div>
  <div class="kpi">
    <div class="kpi-val">${totalPowerKw.toFixed(1)}</div>
    <div class="kpi-label">Total kW</div>
    <div class="kpi-sub">all sites</div>
  </div>
</div>`;

  const sites = [...new Set(rows.map((r) => r.siteId))];
  const siteRows = sites.map((site) => {
    const sr = rows.filter((r) => r.siteId === site);
    const sOnline = sr.filter((r) => r.healthStatus !== 'OFFLINE');
    const sHash = sOnline.reduce((s, r) => s + (r.metrics?.hashrate_rt ?? 0), 0);
    const sAvgT = sOnline.length
      ? (sOnline.reduce((s, r) => s + (r.metrics?.temperature_out ?? 0), 0) / sOnline.length).toFixed(1)
      : '—';
    return `<tr><td><strong>${esc(site)}</strong></td><td>${sOnline.length}/${sr.length}</td><td>${sHash.toFixed(1)} TH/s</td><td>${sAvgT}°C</td></tr>`;
  });

  const alertRows = rows
    .flatMap((r) =>
      (r.activeAlerts ?? []).map(
        (a) => `<tr><td>${esc(r.deviceId)}</td><td>${alertChip(a.code)}</td><td>${esc(a.msg)}</td></tr>`
      )
    )
    .join('');

  return `${kpis}
<h2>Site breakdown</h2>
<table>
  <tr><th>Site</th><th>Devices (online/total)</th><th>Hashrate</th><th>Avg outlet</th></tr>
  ${siteRows.join('\n')}
</table>
${alertRows ? `<h2>Active alerts</h2>
<table>
  <tr><th>Device</th><th>Code</th><th>Description</th></tr>
  ${alertRows}
</table>` : '<h2>Active alerts</h2><p style="color:var(--muted);font-size:0.85rem">No active alerts.</p>'}`;
}

// ── Visualization: full_table ────────────────────────────────────────────────

function renderFullTable(rows, focusFields, contractDoc) {
  const TEMP_CRIT = 85;
  const telemetry = contractDoc?.capabilities?.telemetry ?? [];
  const allKeys =
    focusFields?.length
      ? focusFields
      : telemetry.map((t) => t.name);

  function cellClass(key, val) {
    if (key === 'temperature_out' && val > TEMP_CRIT) return 'td-crit';
    if (key === 'temperature_out' && val > 75) return 'td-warn';
    if ((key === 'fan_speed_in' || key === 'fan_speed_out') && val < 2000) return 'td-crit';
    if (key === 'hashrate_rt' && val === 0) return 'td-warn';
    return '';
  }

  const sorted = [...rows].sort((a, b) => {
    const order = { CRITICAL: 0, DEGRADED: 1, WARNING: 2, OFFLINE: 3, HEALTHY: 4 };
    return (order[a.healthStatus] ?? 9) - (order[b.healthStatus] ?? 9);
  });

  const headerCols = allKeys.map((k) => {
    const spec = telemetry.find((t) => t.name === k);
    return `<th title="${esc(spec?.description ?? k)}">${esc(k)}${spec?.unit ? ` (${esc(spec.unit)})` : ''}</th>`;
  }).join('');

  const bodyRows = sorted.map((row) => {
    const m = row.metrics ?? {};
    const dataCells = allKeys.map((k) => {
      const val = m[k];
      const disp = val == null ? '—' : typeof val === 'number' ? val.toFixed(1) : val;
      const cls = val != null ? cellClass(k, Number(val)) : '';
      return `<td class="${cls}">${esc(disp)}</td>`;
    }).join('');
    return `<tr>
  <td><strong>${esc(row.deviceId)}</strong></td>
  <td>${esc(row.siteId)}</td>
  <td>${statusBadge(row.healthStatus ?? 'HEALTHY')}</td>
  ${dataCells}
</tr>`;
  }).join('\n');

  return `<div style="overflow-x:auto">
<table>
  <thead><tr><th>Device</th><th>Site</th><th>Status</th>${headerCols}</tr></thead>
  <tbody>${bodyRows}</tbody>
</table>
</div>`;
}

// ── Visualization: metric_focus ──────────────────────────────────────────────

function renderMetricFocus(rows, focusFields, contractDoc) {
  const telemetry = contractDoc?.capabilities?.telemetry ?? [];
  const fields = focusFields?.length
    ? focusFields
    : telemetry.slice(0, 3).map((t) => t.name);

  const sections = fields.map((field) => {
    const spec = telemetry.find((t) => t.name === field);
    const label = field.replace(/_/g, ' ');
    const unit = spec?.unit ?? '';

    const vals = rows.map((r) => r.metrics?.[field] ?? 0);
    const maxVal = Math.max(...vals, 1);

    const barColor =
      field.includes('temp') ? '#f7931a' :
      field.includes('hash') ? '#58a6ff' :
      field.includes('power') ? '#a371f7' :
      field.includes('fan') ? '#3fb950' : '#8b98a8';

    const sorted = [...rows].sort((a, b) => (b.metrics?.[field] ?? 0) - (a.metrics?.[field] ?? 0));

    const barRows = sorted.map((row) => {
      const val = row.metrics?.[field] ?? 0;
      const disp = typeof val === 'number' ? (val % 1 === 0 ? val : val.toFixed(1)) : val;
      return `<div class="bar-row">
  <span class="bar-device">${esc(row.deviceId)}</span>
  <div>${hbar(val, maxVal, { color: row.healthStatus === 'OFFLINE' ? '#8b98a8' : barColor, height: 7 })}</div>
  <span class="bar-val">${esc(disp)} ${esc(unit)}</span>
</div>`;
    }).join('');

    const total = vals.reduce((s, v) => s + v, 0);
    const avg = total / (vals.filter((v) => v > 0).length || 1);

    return `<h2>${esc(label)}</h2>
<div style="display:flex;gap:12px;margin-bottom:10px;flex-wrap:wrap">
  <span style="font-size:0.8rem;color:var(--muted)">Total: <strong style="color:var(--text)">${total.toFixed(1)} ${esc(unit)}</strong></span>
  <span style="font-size:0.8rem;color:var(--muted)">Avg: <strong style="color:var(--text)">${avg.toFixed(1)} ${esc(unit)}</strong></span>
  <span style="font-size:0.8rem;color:var(--muted)">Max: <strong style="color:var(--text)">${maxVal.toFixed(1)} ${esc(unit)}</strong></span>
</div>
${barRows}`;
  }).join('<hr class="divider"/>');

  return sections;
}

// ── Visualization: health_status ─────────────────────────────────────────────

function renderHealthStatus(rows, contractDoc) {
  const counts = { HEALTHY: 0, WARNING: 0, DEGRADED: 0, CRITICAL: 0, OFFLINE: 0 };
  rows.forEach((r) => { counts[r.healthStatus ?? 'HEALTHY'] = (counts[r.healthStatus ?? 'HEALTHY'] || 0) + 1; });

  const statusCards = rows
    .sort((a, b) => {
      const o = { CRITICAL: 0, DEGRADED: 1, WARNING: 2, OFFLINE: 3, HEALTHY: 4 };
      return (o[a.healthStatus] ?? 9) - (o[b.healthStatus] ?? 9);
    })
    .map((row) => {
      const s = STATUS_STYLE[row.healthStatus ?? 'HEALTHY'];
      const alerts = row.activeAlerts ?? [];
      return `<div class="card" style="border-color:${s.fg}33">
  <div class="card-header">
    <span class="device-id">${esc(row.deviceId)}</span>
    ${statusBadge(row.healthStatus ?? 'HEALTHY')}
  </div>
  <span class="pill">${esc(row.siteId)} · ${esc(row.workerType ?? 'worker')}</span>
  ${alerts.length ? `<div class="alerts" style="margin-top:8px">${alerts.map((a) => alertChip(a.code)).join(' ')}</div>
  ${alerts.map((a) => `<p style="font-size:0.72rem;color:var(--muted);margin:3px 0">${esc(a.msg)}</p>`).join('')}` : '<p style="font-size:0.72rem;color:var(--muted);margin-top:6px">No active alerts</p>'}
</div>`;
    }).join('\n');

  const summaryRow = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => {
      const s = STATUS_STYLE[k];
      return `<div style="text-align:center;padding:10px 14px;background:${s.bg};border-radius:10px">
  <div style="font-size:1.4rem;font-weight:800;color:${s.fg}">${v}</div>
  <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.06em;color:${s.fg}">${k}</div>
</div>`;
    }).join('');

  return `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">${summaryRow}</div>
<div class="grid">${statusCards}</div>`;
}

// ── Visualization: action_result ─────────────────────────────────────────────

function renderActionResult(commandResults, rows, contractDoc) {
  const results = Array.isArray(commandResults) ? commandResults : [commandResults].filter(Boolean);

  if (!results.length) {
    return `<div class="result-box" style="border-color:#3fb950">
  <div class="ok-badge">No action taken</div>
  <p style="margin:8px 0 0;font-size:0.85rem">No devices matched the action criteria.</p>
</div>`;
  }

  const cards = results.map((res) => {
    const row = rows.find((r) => r.deviceId === res.deviceId);
    const m = row?.metrics ?? {};
    const cmd = `${esc(res.command)} ${esc(JSON.stringify(res.params ?? {}))}`;

    return `<div class="result-box">
  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
    <strong>${esc(res.deviceId)}</strong>
    ${row ? statusBadge(row.healthStatus ?? 'HEALTHY') : ''}
    <span class="cmd-badge">${esc(res.command)}</span>
    <span class="${res.status === 'SUCCESS' ? 'ok-badge' : ''}">${esc(res.status)}</span>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.82rem">
    <div>
      <div style="color:var(--muted);margin-bottom:3px">Command</div>
      <code style="font-size:0.78rem;color:var(--accent)">${cmd}</code>
    </div>
    <div>
      <div style="color:var(--muted);margin-bottom:3px">Pre-action outlet</div>
      <span style="font-weight:600;color:${(m.temperature_out ?? 0) > 85 ? '#e85d4c' : 'var(--text)'}">${m.temperature_out ?? '—'}°C</span>
    </div>
  </div>
  <div style="margin-top:8px;font-size:0.72rem;color:var(--muted)">${esc(res.workerAck?.message ?? 'Worker acknowledged')}</div>
</div>`;
  }).join('\n');

  return `${cards}
<div style="background:rgba(247,147,26,0.08);border:1px solid rgba(247,147,26,0.25);border-radius:8px;padding:10px 12px;font-size:0.8rem;color:var(--muted)">
  Monitor <code>temperature_out</code> over the next 60–90 seconds. Per contract: allow time for metrics to settle after power adjustment.
</div>`;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {{ plan, rows, contractDoc, commandResults, narrative, rationale }} opts
 * @returns {string} Self-contained HTML page
 */
export function renderPage({ plan, rows, contractDoc, commandResults, narrative, rationale } = {}) {
  const vis = plan?.visualization ?? 'full_table';
  const focusFields = plan?.focus_fields ?? [];
  const title = plan?.title ?? 'Fleet Data';

  let body = '';
  switch (vis) {
    case 'thermal_grid':
      body = renderThermalGrid(rows, contractDoc);
      break;
    case 'fleet_summary':
      body = renderFleetSummary(rows, contractDoc);
      break;
    case 'metric_focus':
      body = renderMetricFocus(rows, focusFields, contractDoc);
      break;
    case 'health_status':
      body = renderHealthStatus(rows, contractDoc);
      break;
    case 'action_result':
      body = renderActionResult(commandResults, rows, contractDoc);
      break;
    case 'full_table':
    default:
      body = renderFullTable(rows, focusFields, contractDoc);
      break;
  }

  return pageWrapper(body, {
    title,
    narrative,
    rationale,
    generatedBy: `MDK Agent Studio · visualization: ${vis} · ${rows.length} devices · contract-driven layout`,
  });
}

/**
 * Compute narrative text from plan + live data (runs server-side, after telemetry fetch).
 */
export function buildNarrative(plan, rows, commandResults, tempLimit, contractMeta) {
  const vis = plan?.visualization ?? 'full_table';
  const online = rows.filter((r) => r.healthStatus !== 'OFFLINE');
  const critical = rows.filter((r) => r.healthStatus === 'CRITICAL');
  const degraded = rows.filter((r) => r.healthStatus === 'DEGRADED');
  const totalHash = online.reduce((s, r) => s + (r.metrics?.hashrate_rt ?? 0), 0);
  const hottest = [...rows].sort(
    (a, b) => (b.metrics?.temperature_out ?? 0) - (a.metrics?.temperature_out ?? 0)
  )[0];
  const totalPower = rows.reduce((s, r) => s + (r.metrics?.power_draw ?? 0), 0);
  const allAlerts = rows.flatMap((r) => r.activeAlerts ?? []);

  if (commandResults?.length) {
    const targets = commandResults.map((r) => r.deviceId).join(', ');
    const cmdName = commandResults[0].command;
    return `Dispatched ${cmdName} to ${commandResults.length} device${commandResults.length > 1 ? 's' : ''} (${targets}). Monitor outlet temperature over the next 60–90 seconds.`;
  }

  switch (vis) {
    case 'thermal_grid': {
      const hot = rows.filter((r) => (r.metrics?.temperature_out ?? 0) > tempLimit);
      if (critical.length) {
        return `${critical.length} device${critical.length > 1 ? 's' : ''} critically overheating: ${critical.map((r) => `${r.deviceId} (${r.metrics?.temperature_out}°C)`).join(', ')}. Immediate action recommended per contract.`;
      }
      if (hot.length) {
        return `${hot.length} device${hot.length > 1 ? 's' : ''} above ${tempLimit}°C outlet threshold. Hottest: ${hottest?.deviceId} at ${hottest?.metrics?.temperature_out}°C.`;
      }
      return `All ${rows.length} devices within thermal limits. Fleet max outlet: ${hottest?.metrics?.temperature_out}°C.`;
    }
    case 'fleet_summary':
      return `Fleet total: ${totalHash.toFixed(1)} TH/s across ${online.length}/${rows.length} active devices, ${(totalPower / 1000).toFixed(1)} kW total draw.${critical.length ? ` ⚠ ${critical.length} critical alert${critical.length > 1 ? 's' : ''} require attention.` : ''}`;
    case 'full_table':
      return `${rows.length} devices across ${[...new Set(rows.map((r) => r.siteId))].join(', ')}. ${rows.length - online.length} offline · ${critical.length} critical · ${degraded.length} degraded.`;
    case 'metric_focus': {
      const ff = plan?.focus_fields ?? [];
      if (ff.includes('hashrate_rt')) return `Fleet hashrate: ${totalHash.toFixed(1)} TH/s total (${online.length} active miners).`;
      if (ff.includes('power_draw')) return `Total fleet draw: ${(totalPower / 1000).toFixed(1)} kW across ${rows.length} devices.`;
      if (ff.includes('fan_speed_in') || ff.includes('fan_speed_out')) {
        const fanFaults = rows.filter((r) => (r.metrics?.fan_speed_in ?? 9999) < 2000 || (r.metrics?.fan_speed_out ?? 9999) < 2000);
        return fanFaults.length ? `${fanFaults.length} device${fanFaults.length > 1 ? 's' : ''} with fan RPM below 2000 threshold: ${fanFaults.map((r) => r.deviceId).join(', ')}.` : 'All fans operating above 2000 RPM threshold.';
      }
      return `Showing ${ff.join(', ')} across ${rows.length} devices.`;
    }
    case 'health_status':
      return `Fleet: ${online.length}/${rows.length} online. ${critical.length} critical, ${degraded.length} degraded. ${allAlerts.length} active alert${allAlerts.length !== 1 ? 's' : ''}.`;
    default:
      return `${rows.length} devices across ${[...new Set(rows.map((r) => r.siteId))].join(', ')}.`;
  }
}
