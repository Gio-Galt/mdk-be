const $ = (id) => document.getElementById(id);
const AUTH = { Authorization: 'Bearer mdk-agent-demo', 'Content-Type': 'application/json' };

let traceAll      = [];
let traceRunStart = null;   // timestamp of first event in current run

// ── API ───────────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...AUTH, ...opts.headers } });
  if (!r.ok) { const txt = await r.text(); throw new Error(`${r.status}: ${txt}`); }
  return r.json();
}

// ── Escape ────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(tabId) {
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.id === tabId;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active);
  });
  document.querySelectorAll('.tab-pane').forEach((p) => {
    const active = 'tab-' + p.id.replace('pane-', '') === tabId;
    p.classList.toggle('active', active);
    p.hidden = !active;
  });
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    switchTab(tab.id);
    if (tab.id === 'tab-workers') loadWorkers();
  });
});

// ── Collapsible "Start stack" section ─────────────────────────────────────────

$('startStackToggle')?.addEventListener('click', () => {
  $('startStackSection').classList.toggle('open');
});

// ── Trace rendering ───────────────────────────────────────────────────────────

function appendTrace(events) {
  if (!events?.length) return;

  // Insert a run separator before first batch
  if (traceAll.length === 0 || traceRunStart === null) {
    traceRunStart = events[0]?.ts ?? Date.now();
    const sep = document.createElement('div');
    sep.className = 'trace-separator';
    sep.textContent = new Date(traceRunStart).toLocaleTimeString();
    $('traceList').appendChild(sep);
  }

  traceAll.push(...events);

  events.forEach((e) => {
    const lc = String(e.layer ?? '').toLowerCase().replace(/[^a-z-]/g, '-');
    const relMs = e.ts && traceRunStart ? `+${e.ts - traceRunStart}ms` : '';
    const hasDetail = e.detail != null;
    const detailStr = hasDetail
      ? (typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail, null, 2))
      : '';

    const item = document.createElement('div');
    item.className = `trace-item ${lc}`;

    item.innerHTML = `
      <div class="trace-item-head">
        <span class="trace-layer">${esc(e.layer)}</span>
        <span class="trace-msg">${esc(e.message)}</span>
        ${relMs ? `<span class="trace-ts">${esc(relMs)}</span>` : ''}
        ${hasDetail ? `<span class="trace-chevron">▶</span>` : ''}
      </div>
      ${hasDetail ? `
      <div class="trace-detail">
        <button class="trace-copy-btn" title="Copy to clipboard">Copy</button>
        <pre class="trace-detail-pre">${esc(detailStr)}</pre>
      </div>` : ''}
    `.trim();

    if (hasDetail) {
      const head = item.querySelector('.trace-item-head');
      head.addEventListener('click', () => item.classList.toggle('expanded'));

      const copyBtn = item.querySelector('.trace-copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          navigator.clipboard.writeText(detailStr).then(() => {
            copyBtn.textContent = '✓ Copied';
            copyBtn.classList.add('copied');
            setTimeout(() => {
              copyBtn.textContent = 'Copy';
              copyBtn.classList.remove('copied');
            }, 1800);
          });
        });
      }
    }

    $('traceList').appendChild(item);
  });

  const list = $('traceList');
  list.scrollTop = list.scrollHeight;
  $('traceCount').textContent = `${traceAll.length} events`;
  $('traceBadge').textContent = traceAll.length;
}

$('clearTrace').addEventListener('click', () => {
  traceAll      = [];
  traceRunStart = null;
  $('traceList').innerHTML  = '';
  $('traceCount').textContent = '0 events';
  $('traceBadge').textContent = '0';
});

// ── Preview (inline in chat only — no dedicated pane) ─────────────────────────

function setPreview(_html) {
  // Preview is shown inline inside the chat bubble; no separate pane needed.
}

// ── Chat message builders ─────────────────────────────────────────────────────

function appendUserMsg(text) {
  const el = document.createElement('div');
  el.className = 'msg msg-user';
  el.innerHTML = `<div class="msg-bubble">${esc(text)}</div>`;
  $('chatMessages').appendChild(el);
  scrollChat();
}

function appendTyping() {
  const el = document.createElement('div');
  el.className = 'msg msg-agent';
  el.id = 'typingIndicator';
  el.innerHTML = `<div class="typing-indicator">
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
  </div>`;
  $('chatMessages').appendChild(el);
  scrollChat();
  return el;
}

function appendAgentMsg({ message, mode, title, html, llm }) {
  const el = document.createElement('div');
  el.className = 'msg msg-agent';

  const llmTag = llm
    ? `<span class="msg-mode">${esc(llm.provider)}/${esc(llm.model)}</span>`
    : `<span class="msg-mode">no llm key</span>`;

  el.innerHTML = `
    <div class="msg-bubble">${esc(message)}</div>
    <div class="msg-meta">
      ${llmTag}
      <span>${esc(mode)}</span>
    </div>
    ${html ? `
    <div class="msg-vis-wrap">
      <div class="msg-vis-header">
        <span class="msg-vis-title">${esc(title || mode)}</span>
        <span class="msg-vis-badge">contract-driven</span>
      </div>
      <iframe class="msg-vis-iframe" sandbox="allow-same-origin" srcdoc="${esc(html)}" title="${esc(title)}"></iframe>
    </div>` : ''}
  `.trim();

  $('chatMessages').appendChild(el);
  scrollChat();
}

function scrollChat() {
  const msgs = $('chatMessages');
  msgs.scrollTop = msgs.scrollHeight;
}

// ── Empty state ───────────────────────────────────────────────────────────────

function hideEmptyState() {
  const es = $('emptyState');
  if (es) es.remove();
}

// ── Starter chips ─────────────────────────────────────────────────────────────

document.querySelectorAll('.starter').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('promptInput').value = btn.dataset.prompt ?? '';
    sendPrompt();
  });
});

// ── Send prompt ───────────────────────────────────────────────────────────────

async function sendPrompt() {
  const input  = $('promptInput');
  const prompt = input.value.trim();
  if (!prompt) return;

  hideEmptyState();
  input.value = '';
  input.style.height = '';

  // Reset trace run so next batch gets a fresh separator
  traceRunStart = null;

  appendUserMsg(prompt);
  const typing = appendTyping();
  $('sendBtn').disabled = true;

  try {
    const result = await api('/api/v1/agent/run', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });

    typing.remove();
    appendAgentMsg({
      message: result.message ?? '(no response)',
      mode:    result.mode,
      title:   result.title,
      html:    result.html,
      llm:     result.llm,
    });

    if (result.trace?.length) appendTrace(result.trace);
  } catch (err) {
    typing.remove();
    appendAgentMsg({ message: `Error: ${err.message}`, mode: 'error', title: 'Error', html: null, llm: null });
  } finally {
    $('sendBtn').disabled = false;
    input.focus();
  }
}

$('sendBtn').addEventListener('click', sendPrompt);

$('promptInput').addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
    ev.preventDefault();
    sendPrompt();
  }
  setTimeout(() => {
    const el = ev.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  });
});

// ── Load meta (topbar status) ─────────────────────────────────────────────────

async function loadMeta() {
  try {
    const meta = await api('/api/v1/meta');

    const orkDot   = $('orkDot');
    const orkLabel = $('orkLabel');
    if (meta.ork?.live) {
      orkDot.className     = 'status-dot on';
      orkLabel.textContent = 'Live ORK';
      orkLabel.classList.remove('muted');
    } else {
      orkDot.className     = 'status-dot off';
      orkLabel.textContent = 'ORK (stub)';
      orkLabel.classList.add('muted');
    }

    const llmDot   = $('llmDot');
    const llmLabel = $('llmLabel');
    if (meta.llm?.enabled) {
      llmDot.className     = 'status-dot on';
      llmLabel.textContent = `${meta.llm.provider} / ${meta.llm.model}`;
      llmLabel.classList.remove('muted');
    } else {
      llmDot.className     = 'status-dot off';
      llmLabel.textContent = 'no LLM key';
      llmLabel.classList.add('muted');
    }
  } catch {
    $('llmLabel').textContent = 'meta error';
  }
}

// ── Workers panel ─────────────────────────────────────────────────────────────

function workerIcon(workerType = '') {
  const t = workerType.toLowerCase();
  if (t.includes('miner'))      return { emoji: '⛏', cls: 'icon-miner' };
  if (t.includes('power') || t.includes('meter')) return { emoji: '⚡', cls: 'icon-power' };
  return { emoji: '◈', cls: 'icon-generic' };
}

function healthPillClass(h) {
  return `health-pill health-${['HEALTHY','SICK','DEAD'].includes(h) ? h : 'UNKNOWN'}`;
}

function relativeTime(ts) {
  if (!ts) return null;
  const diff = Math.round((Date.now() - ts) / 1000);
  if (diff < 5)  return 'just now';
  if (diff < 60) return `${diff}s ago`;
  return `${Math.round(diff / 60)}m ago`;
}

async function loadWorkers() {
  const bannerEl = $('orkBanner');
  const listEl   = $('workersList');
  listEl.innerHTML = '<p class="muted-text" style="padding:12px">Loading…</p>';

  try {
    const data = await api('/api/v1/workers');

    if (!data.orkLive) {
      bannerEl.innerHTML = `<div class="ork-banner ork-offline">
        <span class="ork-dot"></span>
        <span><strong>ORK offline</strong> — stub mode active. Start the live stack to connect real workers.</span>
      </div>`;
      listEl.innerHTML = `<div class="no-workers-hint">No live workers. Use the panel below to start the stack.</div>`;
      $('workersBadge').textContent = '0';
      return;
    }

    const workers = data.workers ?? [];
    bannerEl.innerHTML = `<div class="ork-banner ork-online">
      <span class="ork-dot"></span>
      <span><strong>ORK connected</strong> — <code>${esc(data.orkUrl)}</code> &nbsp;·&nbsp; ${workers.length} worker(s)</span>
    </div>`;
    $('workersBadge').textContent = workers.length;

    if (!workers.length) {
      listEl.innerHTML = `<div class="no-workers-hint">No workers registered yet. Start a worker to see it here.</div>`;
      return;
    }

    listEl.innerHTML = '';
    workers.forEach((w) => {
      const ic   = workerIcon(w.workerType);
      const last = relativeTime(w.lastTelemetryAt);
      const card = document.createElement('div');
      card.className = 'worker-card';
      card.innerHTML = `
        <div class="worker-card-head">
          <div class="worker-icon ${ic.cls}">${ic.emoji}</div>
          <div class="worker-title">
            <div class="worker-type">${esc(w.workerType)}</div>
            <div class="worker-id">${esc(w.workerId)}</div>
          </div>
          <span class="${healthPillClass(w.health)}">${esc(w.health ?? 'UNKNOWN')}</span>
        </div>
        <div class="worker-card-body">
          <div class="worker-stat-row">
            <div class="worker-stat">
              <div class="worker-stat-label">Devices</div>
              <div class="worker-stat-value">${esc(w.deviceCount ?? 0)}</div>
            </div>
            <div class="worker-stat">
              <div class="worker-stat-label">Endpoint</div>
              <div class="worker-stat-value">${esc(w.endpoint ?? '—')}</div>
            </div>
          </div>
          ${(w.deviceIds?.length) ? `
          <div class="device-chips">
            ${(w.deviceIds ?? []).map((id) => `<span class="device-chip">${esc(id)}</span>`).join('')}
          </div>` : ''}
        </div>
        ${last ? `<div class="worker-footer">Last telemetry: ${esc(last)}</div>` : ''}
      `.trim();
      listEl.appendChild(card);
    });
  } catch (err) {
    bannerEl.innerHTML = '';
    listEl.innerHTML   = `<p class="muted-text" style="padding:12px">Error: ${esc(err.message)}</p>`;
  }
}

$('refreshWorkers')?.addEventListener('click', loadWorkers);

// ── Capabilities panel ────────────────────────────────────────────────────────

async function loadCapabilities() {
  const capEl  = $('capContent');
  const metaEl = $('capMeta');
  try {
    const data  = await api('/api/v1/capabilities');
    const regs  = data.registrations ?? [];
    const merged = data.merged ?? {};

    // Update topbar device-count and cap pane meta
    $('deviceCount').textContent = `${regs.length} worker${regs.length !== 1 ? 's' : ''}`;
    metaEl.textContent = `${merged.telemetry?.length ?? 0} fields · ${merged.commands?.length ?? 0} commands`;

    if (!regs.length) {
      capEl.innerHTML = '<p class="muted-text">No workers registered.</p>';
      return;
    }

    capEl.innerHTML = '';

    // Per-worker capability block
    regs.forEach((reg) => {
      const wtype = reg.metadata?.workerType ?? reg.siteId ?? 'Unknown';
      const tel   = reg.capabilities?.telemetry ?? [];
      const cmds  = reg.capabilities?.commands  ?? [];
      const ic    = workerIcon(wtype);

      const block = document.createElement('div');
      block.className = 'cap-worker-block';
      block.innerHTML = `
        <div class="cap-worker-head">
          <span>${ic.emoji}</span>
          <span class="cap-worker-name">${esc(wtype)}</span>
          <span class="cap-worker-badge">${tel.length} fields · ${cmds.length} cmd${cmds.length !== 1 ? 's' : ''}</span>
        </div>

        ${tel.length ? `
        <div class="cap-section-label">Telemetry</div>
        ${tel.map((t) => `
          <div class="cap-field-row">
            <span class="cap-field-name">${esc(t.name)}</span>
            <span class="cap-field-desc">${esc(t.description ?? '')}</span>
            ${t.unit ? `<span class="cap-field-unit">${esc(t.unit)}</span>` : ''}
          </div>`).join('')}` : ''}

        ${cmds.length ? `
        <div class="cap-section-label">Commands</div>
        ${cmds.map((c) => `
          <div class="cap-cmd-row">
            <span class="cap-cmd-name">${esc(c.name)}</span>
            ${c.params?.length ? `<span class="cap-cmd-params">params: ${c.params.map((p) => `${esc(p.name)} (${esc(p.type)}${p.min != null ? ', ' + p.min + '–' + p.max : ''})`).join(', ')}</span>` : ''}
          </div>`).join('')}` : ''}
      `.trim();

      capEl.appendChild(block);
    });

    // Architecture flow card
    const archBlock = document.createElement('div');
    archBlock.className = 'arch-flow';
    archBlock.innerHTML = `
      <div class="arch-flow-head">Architecture flow</div>
      <div class="arch-flow-body">
        <ol class="arch-list">
          <li><strong>UI</strong> — Operator sends a natural-language prompt</li>
          <li><strong>Agent</strong> — LLM resolves intent using full <code>mdk-contract.json</code> as context</li>
          <li><strong>MCP tools</strong> — <code>get_worker_capabilities</code>, <code>get_fleet_telemetry</code>, optionally <code>execute_device_command</code></li>
          <li><strong>App Node</strong> — Auth / RBAC, fan-out to ORK</li>
          <li><strong>ORK</strong> — Routes by <code>deviceId</code>, dispatches to worker</li>
          <li><strong>Worker</strong> — Returns telemetry / executes command per contract</li>
        </ol>
      </div>
    `.trim();
    capEl.appendChild(archBlock);

  } catch (err) {
    capEl.innerHTML = `<p class="muted-text">Failed: ${esc(err.message)}</p>`;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

loadMeta();
loadCapabilities();
loadWorkers();
