const $ = (id) => document.getElementById(id);
const AUTH = { Authorization: 'Bearer mdk-agent-demo', 'Content-Type': 'application/json' };

let traceAll = [];

// ── API ───────────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...AUTH, ...opts.headers } });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`${r.status}: ${txt}`);
  }
  return r.json();
}

// ── Escape ────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  tab.addEventListener('click', () => switchTab(tab.id));
});

// ── Trace rendering ───────────────────────────────────────────────────────────

function appendTrace(events) {
  traceAll.push(...events);
  const list = $('traceList');
  events.forEach((e) => {
    const div = document.createElement('div');
    const lc = String(e.layer ?? '').toLowerCase().replace(/[^a-z-]/g, '-');
    div.className = `trace-item ${lc}`;
    div.innerHTML = `
      <div class="trace-layer">${esc(e.layer)}</div>
      <div class="trace-msg">${esc(e.message)}</div>
      ${e.detail != null ? `<div class="trace-detail">${esc(typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail, null, 2))}</div>` : ''}
    `.trim();
    list.appendChild(div);
  });
  list.scrollTop = list.scrollHeight;
  $('traceCount').textContent = `${traceAll.length} events`;
}

$('clearTrace').addEventListener('click', () => {
  traceAll = [];
  $('traceList').innerHTML = '';
  $('traceCount').textContent = '0 events';
});

// ── Preview pane ──────────────────────────────────────────────────────────────

function setPreview(html, title) {
  const frame = $('previewFrame');
  const empty = $('previewEmpty');
  frame.srcdoc = html;
  frame.style.display = 'block';
  empty.style.display = 'none';
  switchTab('tab-preview');
}

// ── Chat message builders ─────────────────────────────────────────────────────

function appendUserMsg(text) {
  const el = document.createElement('div');
  el.className = 'msg msg-user';
  el.innerHTML = `<div class="msg-bubble">${esc(text)}</div>`;
  $('chatMessages').appendChild(el);
  scrollChat();
  return el;
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
    : `<span class="msg-mode">heuristic</span>`;

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
  return el;
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
  const input = $('promptInput');
  const prompt = input.value.trim();
  if (!prompt) return;

  hideEmptyState();
  input.value = '';
  input.style.height = '';

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
      mode: result.mode,
      title: result.title,
      html: result.html,
      llm: result.llm,
    });

    if (result.html) setPreview(result.html, result.title);
    if (result.trace?.length) appendTrace(result.trace);
  } catch (err) {
    typing.remove();
    appendAgentMsg({
      message: `Error: ${err.message}`,
      mode: 'error',
      title: 'Error',
      html: null,
      llm: null,
    });
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
  // auto-resize
  setTimeout(() => {
    const el = ev.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  });
});

// ── Load meta + capabilities ──────────────────────────────────────────────────

async function loadMeta() {
  try {
    const meta = await api('/api/v1/meta');
    const dot = $('llmDot');
    const label = $('llmLabel');
    if (meta.llm?.enabled) {
      dot.className = 'status-dot on';
      label.textContent = `${meta.llm.provider} / ${meta.llm.model}`;
      label.classList.remove('muted');
    } else {
      dot.className = 'status-dot off';
      label.textContent = 'Heuristic mode';
      label.classList.add('muted');
    }
  } catch {
    $('llmLabel').textContent = 'LLM unknown';
  }
}

async function loadCapabilities() {
  const capEl = $('capContent');
  try {
    const data = await api('/api/v1/capabilities');
    const merged = data.merged ?? {};
    const tel = merged.telemetry ?? [];
    const cmds = merged.commands ?? [];

    // Update device count badge
    try {
      const rows = await api('/api/v1/capabilities');
      const devCount = rows.registrations?.reduce((s, r) => s, 0) ?? 0;
    } catch {}

    const telHtml = tel.map((t) => `
      <div class="cap-field">
        <span class="cap-name">${esc(t.name)}</span>
        <span class="cap-unit">${esc(t.unit ?? '')}</span>
      </div>`).join('');

    const cmdHtml = cmds.map((c) => `
      <div class="cap-field">
        <span class="cap-name">${esc(c.name)}</span>
        <span class="cap-unit">${(c.params ?? []).map((p) => esc(p.name)).join(', ')}</span>
      </div>`).join('');

    capEl.innerHTML = `
      <div class="cap-group">
        <div class="cap-group-title">Telemetry (${tel.length} channels)</div>
        ${telHtml || '<p class="muted-text">None</p>'}
      </div>
      <div class="cap-group">
        <div class="cap-group-title">Commands (${cmds.length})</div>
        ${cmdHtml || '<p class="muted-text">None</p>'}
      </div>`;

    $('deviceCount').textContent = `${data.registrations?.length ?? 0} workers`;
  } catch (err) {
    capEl.innerHTML = `<p class="muted-text">Failed: ${esc(err.message)}</p>`;
  }
}

loadMeta();
loadCapabilities();
