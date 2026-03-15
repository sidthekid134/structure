/**
 * Studio UI — Frontend Application
 *
 * Vanilla JS single-page application providing:
 *   - Dashboard overview with stats
 *   - Provisioning timeline with real-time updates
 *   - Drift viewer with reconciliation controls
 *   - Secret status panel
 *   - Architecture dependency graph
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  activePanel: 'dashboard',
  runs: [],
  wsConnections: new Map(), // runId → WebSocket
  wsStatus: 'disconnected',
  feedEntries: [],
  driftStatus: null,
  secrets: null,
  architecture: null,
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fmt(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtShort(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusBadge(status) {
  const map = {
    success: 'badge-success',
    failure: 'badge-failure',
    running: 'badge-running',
    partial: 'badge-partial',
    pending: 'badge-pending',
    skipped: 'badge-skipped',
    reconciling: 'badge-running',
    resuming: 'badge-running',
    synced: 'badge-synced',
    drift: 'badge-drift',
    warning: 'badge-warning',
  };
  const cls = map[status] ?? 'badge-pending';
  return `<span class="badge ${cls}">${status}</span>`;
}

function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function apiFetch(path, opts = {}) {
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error ?? resp.statusText);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function navigate(panelId) {
  state.activePanel = panelId;

  // Update nav active state
  document.querySelectorAll('nav li').forEach(li => {
    li.classList.toggle('active', li.dataset.panel === panelId);
  });

  // Show/hide panels
  document.querySelectorAll('.panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${panelId}`);
  });

  // Load panel data
  switch (panelId) {
    case 'dashboard':   loadDashboard(); break;
    case 'timeline':    loadTimeline(); break;
    case 'drift':       loadDrift(); break;
    case 'secrets':     loadSecrets(); break;
    case 'arch':        loadArchitecture(); break;
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function loadDashboard() {
  try {
    const [runs, drift, arch] = await Promise.all([
      apiFetch('/api/provisioning'),
      apiFetch('/api/drift'),
      apiFetch('/api/architecture'),
    ]);

    const total = runs.total;
    const success = runs.runs.filter(r => r.status === 'success').length;
    const failed  = runs.runs.filter(r => r.status === 'failure').length;
    const partial = runs.runs.filter(r => r.status === 'partial').length;
    const running = runs.runs.filter(r => r.status === 'running').length;

    document.getElementById('stat-total').textContent    = total;
    document.getElementById('stat-success').textContent  = success;
    document.getElementById('stat-failed').textContent   = failed + partial;
    document.getElementById('stat-running').textContent  = running;

    // Drift status
    const driftEl = document.getElementById('drift-summary');
    if (driftEl) {
      driftEl.innerHTML = `
        <div class="drift-row">
          <span class="drift-field">Status</span>
          <span>${statusBadge(drift.status === 'drift_possible' ? 'warning' : 'synced')}</span>
        </div>
        <div class="drift-row">
          <span class="drift-field">Last checked</span>
          <span class="drift-value">${fmt(drift.last_checked)}</span>
        </div>
        <div class="drift-row">
          <span class="drift-field">Recent failures</span>
          <span class="drift-value">${drift.recent_failures.length}</span>
        </div>
        <p style="margin-top:10px;font-size:12px;color:var(--text-muted)">${drift.message}</p>
      `;
    }

    // Recent runs
    const recentEl = document.getElementById('recent-runs');
    if (recentEl) {
      if (runs.runs.length === 0) {
        recentEl.innerHTML = '<div class="empty-state"><p>No provisioning runs yet.</p></div>';
      } else {
        recentEl.innerHTML = runs.runs.slice(0, 5).map(r => `
          <div class="drift-row" style="cursor:pointer" onclick="navigate('timeline')">
            <span class="run-app-id">${escHtml(r.app_id)}</span>
            ${statusBadge(r.status)}
            <span class="event-time">${fmt(r.created_at)}</span>
          </div>
        `).join('');
      }
    }

    // Architecture summary
    if (arch) {
      renderArchitectureMini(arch, 'arch-mini');
    }

  } catch (err) {
    toast(`Dashboard load failed: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Provisioning Timeline
// ---------------------------------------------------------------------------

async function loadTimeline() {
  const container = document.getElementById('timeline-list');
  if (!container) return;

  container.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

  try {
    const data = await apiFetch('/api/provisioning');
    state.runs = data.runs;

    if (data.runs.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No provisioning runs found.</p></div>';
      return;
    }

    container.innerHTML = '';
    for (const run of data.runs) {
      container.appendChild(buildRunCard(run));
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>Error: ${escHtml(err.message)}</p></div>`;
    toast(`Timeline load failed: ${err.message}`, 'error');
  }
}

function buildRunCard(run, events = null) {
  const li = document.createElement('li');
  li.className = 'timeline-run';
  li.dataset.runId = run.id;

  li.innerHTML = `
    <div class="timeline-run-header" onclick="toggleRun(this)">
      <span class="run-app-id">${escHtml(run.app_id)}</span>
      ${statusBadge(run.status)}
      <span class="run-id">${escHtml(run.id)}</span>
      <span class="run-timestamp">${fmt(run.created_at)}</span>
      ${canResume(run.status) ? `<button class="btn btn-secondary" style="padding:4px 10px;font-size:11px" onclick="event.stopPropagation();openResumeModal('${escHtml(run.id)}')">Resume</button>` : ''}
      <span class="run-chevron">▶</span>
    </div>
    <div class="timeline-events">
      ${events ? renderEvents(events) : '<div style="color:var(--text-muted);font-size:12px">Click to expand and load events…</div>'}
    </div>
  `;

  return li;
}

function canResume(status) {
  return status === 'failure' || status === 'partial';
}

async function toggleRun(header) {
  const card = header.closest('.timeline-run');
  const wasExpanded = card.classList.contains('expanded');
  card.classList.toggle('expanded', !wasExpanded);

  if (!wasExpanded) {
    const eventsDiv = card.querySelector('.timeline-events');
    const runId = card.dataset.runId;

    // Load events if not yet loaded
    if (!eventsDiv.dataset.loaded) {
      eventsDiv.innerHTML = '<div class="spinner"></div>';
      try {
        const detail = await apiFetch(`/api/provisioning/${encodeURIComponent(runId)}`);
        eventsDiv.innerHTML = renderEvents(detail.events || []);
        eventsDiv.dataset.loaded = '1';

        // Subscribe to WebSocket for running/partial runs
        if (detail.status === 'running' || detail.status === 'partial') {
          subscribeToRun(runId);
        }
      } catch (err) {
        eventsDiv.innerHTML = `<p style="color:var(--error);font-size:12px">Failed to load events: ${escHtml(err.message)}</p>`;
      }
    }
  }
}

function renderEvents(events) {
  if (!events || events.length === 0) {
    return '<p style="color:var(--text-muted);font-size:12px;padding:8px 0">No events recorded.</p>';
  }
  return `
    <ul class="event-list">
      ${events.map(e => `
        <li class="event-item">
          <span class="event-provider">${escHtml(e.provider)}</span>
          <span class="event-step">${escHtml(e.step)}</span>
          ${statusBadge(e.status)}
          <span class="event-time">${fmtShort(e.timestamp)}</span>
          ${e.error_message ? `<div class="event-error">${escHtml(e.error_message)}</div>` : ''}
        </li>
      `).join('')}
    </ul>
  `;
}

// ---------------------------------------------------------------------------
// Resume Modal
// ---------------------------------------------------------------------------

function openResumeModal(runId) {
  const modal = document.getElementById('resume-modal');
  modal.dataset.runId = runId;
  document.getElementById('resume-run-id').textContent = runId;
  modal.style.display = 'flex';
}

function closeResumeModal() {
  document.getElementById('resume-modal').style.display = 'none';
}

async function submitResume() {
  const modal = document.getElementById('resume-modal');
  const runId = modal.dataset.runId;
  const choice = document.getElementById('resume-choice').value;

  try {
    const result = await apiFetch(`/api/provisioning/${encodeURIComponent(runId)}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice }),
    });
    closeResumeModal();
    toast(result.message, 'success');

    // Subscribe to WebSocket for live updates
    subscribeToRun(runId);
    loadTimeline();
  } catch (err) {
    toast(`Resume failed: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function subscribeToRun(runId) {
  if (state.wsConnections.has(runId)) return;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws/provisioning/${encodeURIComponent(runId)}`);

  state.wsConnections.set(runId, ws);
  updateWsStatus('connecting');

  ws.onopen = () => {
    updateWsStatus('connected');
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      handleWsMessage(runId, msg);
    } catch { /* ignore parse errors */ }
  };

  ws.onclose = () => {
    state.wsConnections.delete(runId);
    if (state.wsConnections.size === 0) updateWsStatus('disconnected');
  };

  ws.onerror = () => {
    updateWsStatus('error');
    toast(`WebSocket error for run ${runId}`, 'error');
  };
}

function handleWsMessage(runId, msg) {
  // Add to live feed
  addFeedEntry(msg);

  // Update timeline card if visible
  const card = document.querySelector(`.timeline-run[data-run-id="${CSS.escape(runId)}"]`);
  if (card) {
    const d = msg.data || {};
    if (msg.type === 'progress') {
      // Append event to events list
      const eventsDiv = card.querySelector('.timeline-events');
      if (eventsDiv && eventsDiv.dataset.loaded) {
        const ul = eventsDiv.querySelector('.event-list') || (() => {
          const u = document.createElement('ul');
          u.className = 'event-list';
          eventsDiv.innerHTML = '';
          eventsDiv.appendChild(u);
          return u;
        })();

        const li = document.createElement('li');
        li.className = 'event-item';
        li.innerHTML = `
          <span class="event-provider">${escHtml(d.provider || '')}</span>
          <span class="event-step">${escHtml(d.step || '')}</span>
          ${statusBadge(d.status || 'running')}
          <span class="event-time">${fmtShort(msg.timestamp)}</span>
        `;
        ul.appendChild(li);
      }
    }

    if (msg.type === 'status_update') {
      // Update badge
      const badge = card.querySelector('.timeline-run-header .badge');
      if (badge) badge.outerHTML = statusBadge(d.status || 'running');
    }
  }

  // Update reconcile panel if active
  if (msg.type === 'reconcile_progress' && state.activePanel === 'drift') {
    updateReconcileProgress(msg.data);
  }
}

function updateWsStatus(status) {
  state.wsStatus = status;
  const dot = document.getElementById('ws-dot');
  const label = document.getElementById('ws-label');
  if (dot) {
    dot.className = `ws-dot ${status}`;
  }
  if (label) {
    label.textContent = status === 'connected' ? 'Live' :
                        status === 'connecting' ? 'Connecting…' :
                        status === 'error' ? 'Error' : 'Offline';
  }
}

function addFeedEntry(msg) {
  const feed = document.getElementById('live-feed');
  if (!feed) return;

  const d = msg.data || {};
  const entry = document.createElement('div');
  entry.className = 'feed-entry';
  entry.innerHTML = `
    <span class="feed-time">${fmtShort(msg.timestamp)}</span>
    <span class="feed-provider">[${escHtml(msg.runId)}]</span>
    <span class="feed-status-${d.status || 'running'}">${escHtml(d.provider || msg.type)} — ${escHtml(d.status || msg.type)}</span>
  `;
  feed.insertBefore(entry, feed.firstChild);

  // Keep feed at 50 entries
  while (feed.children.length > 50) feed.removeChild(feed.lastChild);
}

// ---------------------------------------------------------------------------
// Drift Viewer
// ---------------------------------------------------------------------------

async function loadDrift() {
  try {
    const drift = await apiFetch('/api/drift');
    state.driftStatus = drift;

    const container = document.getElementById('drift-content');
    if (!container) return;

    const hasFailures = drift.recent_failures.length > 0;

    container.innerHTML = `
      <div class="card">
        <div class="card-title">Current State</div>
        <div class="drift-row">
          <span class="drift-field">Status</span>
          ${statusBadge(hasFailures ? 'warning' : 'synced')}
        </div>
        <div class="drift-row">
          <span class="drift-field">Last checked</span>
          <span class="drift-value">${fmt(drift.last_checked)}</span>
        </div>
        <p style="margin-top:12px;font-size:13px;color:var(--text-secondary)">${escHtml(drift.message)}</p>
      </div>

      ${hasFailures ? `
        <div class="card">
          <div class="card-title">Recent Failures</div>
          ${drift.recent_failures.map(f => `
            <div class="drift-row">
              <span class="run-app-id">${escHtml(f.app_id)}</span>
              ${statusBadge(f.status)}
              <span class="run-id">${escHtml(f.run_id)}</span>
              <span class="run-timestamp">${fmt(f.failed_at)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div class="card">
        <div class="card-title">Reconciliation</div>
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">
          Choose a sync direction to reconcile manifest vs. live provider state.
          Changes execute in dependency order: Firebase → GitHub → EAS/Apple/Google Play → Cloudflare/OAuth.
        </p>
        <div class="drift-controls">
          <select id="reconcile-direction">
            <option value="manifest-to-live">Manifest → Live (apply manifest to provider)</option>
            <option value="live-to-manifest">Live → Manifest (update manifest from provider)</option>
          </select>
          <button class="btn btn-primary" onclick="startReconcile()">Start Reconciliation</button>
        </div>
        <div id="reconcile-progress" style="display:none">
          <div class="card-title" style="margin-top:16px">Progress</div>
          <ul id="reconcile-list" class="event-list"></ul>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Side-by-Side Comparison</div>
        <div class="drift-split">
          <div class="drift-pane">
            <div class="drift-pane-title">Manifest (desired)</div>
            <div class="drift-row">
              <span class="drift-field">firebase.services</span>
              <span class="drift-value">auth, firestore, fcm</span>
            </div>
            <div class="drift-row">
              <span class="drift-field">github.branch_protection</span>
              <span class="drift-value">main (require reviews)</span>
            </div>
            <div class="drift-row">
              <span class="drift-field">eas.build_profile</span>
              <span class="drift-value">production</span>
            </div>
            <div class="drift-row drift-diff">
              <span class="drift-field">cloudflare.ssl_mode</span>
              <span class="drift-value">full-strict</span>
            </div>
          </div>
          <div class="drift-pane">
            <div class="drift-pane-title">Live (actual)</div>
            <div class="drift-row">
              <span class="drift-field">firebase.services</span>
              <span class="drift-value">auth, firestore, fcm</span>
            </div>
            <div class="drift-row">
              <span class="drift-field">github.branch_protection</span>
              <span class="drift-value">main (require reviews)</span>
            </div>
            <div class="drift-row">
              <span class="drift-field">eas.build_profile</span>
              <span class="drift-value">production</span>
            </div>
            <div class="drift-row drift-diff">
              <span class="drift-field">cloudflare.ssl_mode</span>
              <span class="drift-value" style="color:var(--error)">flexible ⚠</span>
            </div>
          </div>
        </div>
        <p style="font-size:12px;color:var(--text-muted)">
          Note: This preview shows example drift. Run actual detection to compare live provider state.
        </p>
      </div>
    `;
  } catch (err) {
    toast(`Drift load failed: ${err.message}`, 'error');
  }
}

async function startReconcile() {
  const direction = document.getElementById('reconcile-direction').value;
  const runId = `reconcile-${Date.now()}`;

  try {
    const result = await apiFetch('/api/drift/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction, runId }),
    });

    document.getElementById('reconcile-progress').style.display = 'block';
    document.getElementById('reconcile-list').innerHTML = '';
    toast('Reconciliation started', 'info');

    // Subscribe to WebSocket for live progress
    subscribeToRun(runId);
  } catch (err) {
    toast(`Reconcile failed: ${err.message}`, 'error');
  }
}

function updateReconcileProgress(data) {
  const list = document.getElementById('reconcile-list');
  if (!list) return;

  const li = document.createElement('li');
  li.className = 'event-item';
  li.innerHTML = `
    <span class="event-provider">${escHtml(data.provider || '')}</span>
    ${statusBadge(data.reconciled ? 'success' : 'failure')}
    ${data.error ? `<span class="event-error">${escHtml(data.error)}</span>` : ''}
    <span class="event-time">${fmtShort(new Date().toISOString())}</span>
  `;
  list.appendChild(li);
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

async function loadSecrets() {
  const container = document.getElementById('secrets-content');
  if (!container) return;

  container.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

  try {
    const data = await apiFetch('/api/secrets');
    state.secrets = data;

    container.innerHTML = data.providers.map(p => `
      <div class="card provider-secrets">
        <div class="provider-header">
          <span class="provider-name">${escHtml(p.provider)}</span>
          <span class="badge badge-pending">${p.secrets.length} secrets</span>
        </div>
        <ul class="secret-list">
          ${p.secrets.map(s => `
            <li class="secret-item">
              <span class="secret-name">${escHtml(s.name)}</span>
              <div class="secret-meta">
                ${statusBadge('pending')}
                <span>${s.last_updated ? fmt(s.last_updated) : 'Not stored'}</span>
              </div>
            </li>
          `).join('')}
        </ul>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>Error: ${escHtml(err.message)}</p></div>`;
    toast(`Secrets load failed: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Architecture Graph
// ---------------------------------------------------------------------------

async function loadArchitecture() {
  try {
    const arch = await apiFetch('/api/architecture');
    state.architecture = arch;
    renderArchitectureGraph(arch, 'arch-graph-main');
  } catch (err) {
    toast(`Architecture load failed: ${err.message}`, 'error');
  }
}

const NODE_POSITIONS = {
  firebase:     { x: 340, y: 60 },
  github:       { x: 340, y: 180 },
  eas:          { x: 200, y: 300 },
  apple:        { x: 340, y: 300 },
  'google-play':{ x: 480, y: 300 },
  cloudflare:   { x: 120, y: 180 },
  oauth:        { x: 560, y: 180 },
};

const NODE_COLORS = {
  firebase:     '#f59e0b',
  github:       '#6366f1',
  eas:          '#22c55e',
  apple:        '#94a3b8',
  'google-play':'#3b82f6',
  cloudflare:   '#f97316',
  oauth:        '#a855f7',
};

function renderArchitectureMini(arch, containerId) {
  renderSvgGraph(arch, containerId, 300, 160, 0.42);
}

function renderArchitectureGraph(arch, containerId) {
  renderSvgGraph(arch, containerId, 720, 400, 1);
}

function renderSvgGraph(arch, containerId, width, height, scale) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const edges = arch.edges.map(e => {
    const from = NODE_POSITIONS[e.from];
    const to   = NODE_POSITIONS[e.to];
    if (!from || !to) return '';
    return `<line x1="${from.x * scale}" y1="${from.y * scale}" x2="${to.x * scale}" y2="${to.y * scale}"
      stroke="#2d3148" stroke-width="1.5" marker-end="url(#arrow)"/>`;
  }).join('');

  const nodes = arch.nodes.map(n => {
    const pos = NODE_POSITIONS[n.id];
    if (!pos) return '';
    const color = NODE_COLORS[n.id] ?? '#6366f1';
    const rx = pos.x * scale;
    const ry = pos.y * scale;
    return `
      <g>
        <circle cx="${rx}" cy="${ry}" r="${12 * scale}" fill="${color}" opacity="0.9"/>
        <text x="${rx}" y="${ry + 4 * scale}" text-anchor="middle"
          font-size="${9 * scale}" fill="#fff" font-family="system-ui">${n.id}</text>
      </g>
    `;
  }).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
      <defs>
        <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 Z" fill="#4b5563"/>
        </marker>
      </defs>
      ${edges}
      ${nodes}
    </svg>
  `;
}

// ---------------------------------------------------------------------------
// XSS protection
// ---------------------------------------------------------------------------

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Wire nav buttons
  document.querySelectorAll('[data-panel]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.panel));
  });

  // Wire resume modal
  document.getElementById('resume-cancel')?.addEventListener('click', closeResumeModal);
  document.getElementById('resume-submit')?.addEventListener('click', submitResume);

  // Initial panel
  navigate('dashboard');

  // Health check polling every 30s
  setInterval(async () => {
    try {
      const h = await apiFetch('/api/health');
      const dot = document.getElementById('ws-dot');
      const label = document.getElementById('ws-label');
      if (dot && state.wsConnections.size === 0) {
        dot.className = 'ws-dot';
        if (label) label.textContent = `${h.websocket_connections} WS`;
      }
    } catch { /* ignore */ }
  }, 30000);
});
