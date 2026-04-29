/**
 * Mining Widget — MDK App Widget (React)
 * ───────────────────────────────────────
 * The UI half of the MDK App, built with React using MDK UI Kit primitives.
 *
 * Route binding (hld-mdk-app.md §4.5):
 *   Fetches from /mining/stats and /mining/alerts — routes registered by MiningPlugin.
 *   The App Node proxies these to the Plugin automatically. No HRPC or ORK code needed here.
 */

import { useState, useEffect, useCallback } from 'react';

const PLUGIN_BASE = '/mining';
const REFRESH_INTERVAL_MS = 30_000;

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, color }) {
  return (
    <div style={{
      background: '#161b22',
      border: '1px solid #30363d',
      borderRadius: 8,
      padding: '1.2rem 1.5rem',
    }}>
      <div style={{ fontSize: '0.75rem', color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: '0.3rem', color }}>
        {value ?? '—'}
      </div>
    </div>
  );
}

function AlertItem({ alert }) {
  return (
    <div style={{
      background: '#1f1411',
      border: '1px solid #f85149',
      borderRadius: 6,
      padding: '0.75rem 1rem',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      fontSize: '0.875rem',
    }}>
      <span>
        <strong>{alert.deviceId}</strong> — {alert.siteId}
      </span>
      <span style={{
        fontSize: '0.7rem',
        fontWeight: 600,
        padding: '0.2rem 0.5rem',
        borderRadius: 4,
        background: '#f85149',
        color: '#fff',
      }}>
        {alert.reason}
      </span>
    </div>
  );
}

// ─── Main Widget ──────────────────────────────────────────────────────────────

export default function MiningWidget() {
  const [stats, setStats]   = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [error, setError]   = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, alertsRes] = await Promise.all([
        fetch(`${PLUGIN_BASE}/stats`),
        fetch(`${PLUGIN_BASE}/alerts`),
      ]);

      const { stats }  = await statsRes.json();
      const { alerts } = await alertsRes.json();

      setStats(stats);
      setAlerts(alerts);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchAll]);

  return (
    <div style={{
      fontFamily: "'Inter', system-ui, sans-serif",
      background: '#0d1117',
      color: '#e6edf3',
      minHeight: '100vh',
      padding: '2rem',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 600, color: '#58a6ff' }}>
          ⛏ Mining Fleet Dashboard
        </h1>
        <button
          onClick={fetchAll}
          disabled={loading}
          style={{
            background: '#21262d',
            border: '1px solid #30363d',
            color: '#e6edf3',
            padding: '0.5rem 1.2rem',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: '0.875rem',
            opacity: loading ? 0.5 : 1,
          }}
        >
          {loading ? 'Loading...' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ color: '#f85149', marginBottom: '1rem', fontSize: '0.875rem' }}>
          Error: {error}
        </div>
      )}

      {/* Stats Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
        <StatCard label="Total Hashrate"  value={stats ? `${stats.totalHashrateTHs} TH/s` : '—'} color="#3fb950" />
        <StatCard label="Total Power Draw" value={stats ? `${stats.totalPowerKW} kW`      : '—'} color="#d29922" />
        <StatCard label="Avg Temperature"  value={stats ? `${stats.avgTempC}°C`            : '—'} color="#f85149" />
        <StatCard label="Active Devices"   value={stats ? stats.deviceCount                : '—'} color="#58a6ff" />
      </div>

      {/* Alerts */}
      <h2 style={{ fontSize: '1rem', fontWeight: 600, color: '#8b949e', marginBottom: '1rem' }}>
        🚨 Active Alerts
      </h2>

      {!alerts || alerts.length === 0 ? (
        <p style={{ color: '#8b949e', fontStyle: 'italic', fontSize: '0.875rem' }}>No active alerts ✓</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {alerts.map(a => <AlertItem key={`${a.siteId}-${a.deviceId}`} alert={a} />)}
        </div>
      )}
    </div>
  );
}
