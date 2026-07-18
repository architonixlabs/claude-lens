// main.js — bootstrap. Wires the WebSocket stream to the 3D scene and the log,
// and drives the multi-session picker: pick a session, watch it build live.
// Everything here is read-only: we render what Claude is doing, we never touch it.

import { initScene } from './scene.js';
import { initLog } from './log.js';
import { connect } from './ws.js';

const canvas = document.getElementById('scene');
const scene = initScene(canvas);
const log = initLog(document);

const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const statAgents = document.getElementById('stat-agents');
const statActive = document.getElementById('stat-active');
const tooltip = document.getElementById('tooltip');
const pauseBtn = document.getElementById('log-pause');
const countEl = document.getElementById('sessions-count');
const sessLists = {
  active: document.getElementById('sess-active'),
  idle: document.getElementById('sess-idle'),
  ended: document.getElementById('sess-ended'),
};
const sessSections = {
  active: document.querySelector('.sess-section[data-status="active"]'),
  idle: document.querySelector('.sess-section[data-status="idle"]'),
  ended: document.querySelector('.sess-section[data-status="ended"]'),
};

let currentSessionId = null;
let seenEventIds = new Set();

// Client-side event buffer for the currently-selected session (drives the node
// inspector). Reset on snapshot / session switch, appended on update, capped.
const MAX_SESSION_EVENTS = 2000;
let sessionEvents = [];
let currentGraph = null; // latest graph for the selected session (parent lookup)

// Timeline (record / scrub / replay) state. In 'live' we follow new events; in
// 'replay' the view is frozen at `timelineIndex` while recording continues.
let timelineMode = 'live';
let timelineIndex = -1;
let playTimer = null;
let allMode = false; // combined "all sessions on one canvas" mode (declared early: used by syncTimelineMax at init)

// Read-only introspection seam for E2E tests (mutates nothing).
window.__agentviz = {
  get nodes() { return scene.nodeCount; },
  get session() { return currentSessionId; },
  state: 'connecting',
  sessions: 0,
  events: 0,
  tools: 0,
  inspectedAgent: null,
  get agentIds() { return currentGraph && currentGraph.agents ? Object.keys(currentGraph.agents) : []; },
  // Test hook: exercises the SAME open path a real canvas click triggers.
  openInspector: (id) => openInspector(id),
  // Timeline (record / scrub / replay) introspection seam.
  timelineMode: 'live',
  timelineIndex: -1,
  scrubTo: (i) => scrubTo(i),
};

function setStatus(state) {
  statusEl.dataset.state = state;
  statusText.textContent = state === 'live' ? 'live' : state === 'closed' ? 'reconnecting…' : 'connecting…';
  window.__agentviz.state = state;
}

function updateStats(graph) {
  const agents = graph && graph.agents ? Object.values(graph.agents) : [];
  const real = agents.filter((a) => a.type !== 'user');
  statAgents.textContent = real.length;
  statActive.textContent = real.filter((a) => a.status === 'active').length;
  renderTaskBoxes(graph);
}

// ---------- canvas task boxes: Ongoing / Completed / Pipeline ----------
const tbLists = {
  ongoing: document.getElementById('tb-ongoing'),
  completed: document.getElementById('tb-completed'),
};
const tbCounts = {
  ongoing: document.getElementById('tb-ongoing-count'),
  completed: document.getElementById('tb-completed-count'),
};

// Subagents + skills grouped by status. (No "pipeline" box — a live event stream
// only reveals a task once it starts, so there's no forward-looking queue.)
function renderTaskBoxes(graph) {
  const agents = graph && graph.agents ? Object.values(graph.agents) : [];
  const tasks = agents.filter((a) => a.type === 'subagent' || a.type === 'skill');
  const groups = { ongoing: [], completed: [] };
  for (const a of tasks) {
    if (a.status === 'active') groups.ongoing.push(a);
    else if (a.status === 'done' || a.status === 'error') groups.completed.push(a);
  }
  for (const k of ['ongoing', 'completed']) {
    fillTaskList(tbLists[k], groups[k]);
    tbCounts[k].textContent = String(groups[k].length);
  }
}

function fillTaskList(el, items) {
  el.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li'); li.className = 'tb-empty'; li.textContent = '—';
    el.append(li); return;
  }
  for (const a of items) {
    const li = document.createElement('li');
    const statusCls = a.type === 'skill' ? 'skill' : (a.status || 'idle');
    li.className = 'tb-item st-' + statusCls;
    const nm = document.createElement('span'); nm.className = 'tb-item-name';
    nm.textContent = (a.type === 'skill' ? '◆ ' : '') + (a.name || a.id);
    li.append(nm);
    if (a.toolCount > 0) {
      const tc = document.createElement('span'); tc.className = 'tb-item-tc'; tc.textContent = `${a.toolCount}⚙`;
      li.append(tc);
    }
    li.title = `${a.type} · ${a.status}` + (a.toolCount ? ` · ${a.toolCount} tools` : '');
    li.addEventListener('click', () => {
      if (allMode && a._sid) exitAllMode(a._sid);
      else { openInspector(a.id); scene.pulse(a.id); }
    });
    el.append(li);
  }
}

function visualizeEvent(ev) {
  if (ev.callId && ev.type === 'tool_use') {
    scene.toolCall(ev.agentId, ev.callId, ev.kind, ev.tool, ev.detail);
    window.__agentviz.tools = scene.toolCount;
    return;
  }
  if (ev.callId && ev.type === 'tool_result') {
    const dur = ev.durationMs ? '  ' + fmtDur(ev.durationMs) : '';
    scene.toolReturn(ev.callId, ev.agentId, (ev.detail || '') + dur, ev.error);
    return;
  }
  if (ev.from && ev.to && ev.from !== ev.to) scene.beam(ev.from, ev.to, ev.type);
  else scene.pulse(ev.agentId, undefined);
}

// ---------- model + token formatting ----------
function fmtTokens(n) {
  if (!n) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}
function fmtDur(ms) {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}
function prettyModel(id) {
  if (!id) return '';
  const s = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[1m\]$/, '');
  const famMatch = s.match(/opus|sonnet|haiku|fable/i);
  const verMatch = s.match(/(\d+)-(\d+)/);
  if (famMatch) {
    const fam = famMatch[0];
    const name = fam[0].toUpperCase() + fam.slice(1).toLowerCase();
    return verMatch ? `${name} ${verMatch[1]}.${verMatch[2]}` : name;
  }
  return s;
}

const modelPill = document.getElementById('model-pill');
const modelName = document.getElementById('model-name');
const statTokens = document.getElementById('stat-tokens');
const statErrors = document.getElementById('stat-errors');
const errTile = document.getElementById('stat-errors-tile');
const statCache = document.getElementById('stat-cache');
const cacheTile = document.getElementById('stat-cache-tile');
const viewingPill = document.getElementById('viewing-pill');
const viewingName = document.getElementById('viewing-name');

function updateViewing(label) {
  if (label) { viewingName.textContent = label; viewingPill.hidden = false; }
  else { viewingPill.hidden = true; }
}

// Latest summary for the selected session — drives the HUD + inspector stats.
let currentSummary = null;

function updateSessionHud(summary) {
  if (!summary) return;
  currentSummary = summary;
  updateViewing(summary.label || summary.id);
  const m = prettyModel(summary.model);
  if (m) { modelName.textContent = m; modelPill.hidden = false; }
  else { modelPill.hidden = true; }
  statTokens.textContent = fmtTokens(summary.usage ? summary.usage.total : 0);
  const errs = summary.errors || 0;
  statErrors.textContent = String(errs);
  errTile.classList.toggle('has-errors', errs > 0);
  const cache = summary.cacheHitPct || 0;
  statCache.textContent = `${cache}%`;
  cacheTile.classList.toggle('good', cache >= 50);
  refreshInspector();
}

// Record an event into the client-side buffer (dedup + cap). Returns true if it
// was newly recorded. Used by BOTH the live and replay paths — replay keeps
// recording so the scrubber's range grows, it just doesn't drive the view.
function recordEvent(ev) {
  if (seenEventIds.has(ev.id)) return false;
  seenEventIds.add(ev.id);
  if (seenEventIds.size > 5000) seenEventIds = new Set([...seenEventIds].slice(-2000));
  sessionEvents.push(ev);
  window.__agentviz.events++;
  return true;
}

function applyEvents(events, graph) {
  if (timelineMode === 'replay') {
    // Frozen at the scrub point: keep recording (so the timeline stays complete
    // and the scrubber max advances) but do NOT touch the scene or the log.
    if (graph) currentGraph = graph;
    for (const ev of events) recordEvent(ev);
    if (sessionEvents.length > MAX_SESSION_EVENTS) sessionEvents = sessionEvents.slice(-MAX_SESSION_EVENTS);
    syncTimelineMax();
    return;
  }
  // LIVE path — follow new events.
  if (graph) { scene.setGraph(graph); updateStats(graph); currentGraph = graph; }
  for (const ev of events) {
    if (!recordEvent(ev)) continue;
    log.add(ev);
    visualizeEvent(ev);
  }
  if (sessionEvents.length > MAX_SESSION_EVENTS) sessionEvents = sessionEvents.slice(-MAX_SESSION_EVENTS);
  refreshInspector();
  syncTimelineMax();
}

// ---------- timeline: reconstruct graph state from the event stream ----------
// Pure, client-side rebuild of {agents, edges} as of events[0..N]. Mirrors the
// server graph closely enough for the tidy-tree layout, which only needs
// id/name/type/parentId/status + edges.
function buildStateFromEvents(events) {
  const agents = {
    user: { id: 'user', name: 'You', type: 'user', parentId: null, status: 'idle', toolCount: 0 },
    root: { id: 'root', name: 'Claude', type: 'orchestrator', parentId: 'user', status: 'active', toolCount: 0 },
  };
  const edges = [];
  const edgeKeys = new Set();
  const addEdge = (from, to) => {
    if (!from || !to || from === to) return;
    const key = `${from}|${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to });
  };
  addEdge('user', 'root');

  const upsert = (id) => {
    if (!id) return null;
    let a = agents[id];
    if (!a) { a = { id, name: id, type: 'subagent', parentId: 'root', status: 'idle', toolCount: 0 }; agents[id] = a; }
    return a;
  };

  for (const ev of events || []) {
    const a = upsert(ev.agentId);
    if (a) {
      if (ev.agentName != null) a.name = ev.agentName;
      if (ev.agentType != null) a.type = ev.agentType;
      if (ev.parentId != null) a.parentId = ev.parentId;
      if (ev.status != null) a.status = ev.status;
    }
    if (ev.type === 'agent_spawn' && ev.from && ev.to) {
      addEdge(ev.from, ev.to);
      const child = upsert(ev.to);
      if (child) child.parentId = ev.from;
    }
    if (ev.type === 'agent_done' && a) a.status = 'done';
    if (ev.type === 'agent_error' && a) a.status = 'error';
    if (ev.type === 'tool_use' && a) a.toolCount = (a.toolCount || 0) + 1;
    // keep parent edges consistent for any agent that declares a parent
    if (a && a.parentId) addEdge(a.parentId, a.id);
  }
  return { graph: { agents, edges } };
}

// ---------- session picker ----------
function fmtAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// Diff-based render: cards are created once per session id and updated in place
// (stable order, no full rebuild) so the picker never flickers and clicks never
// race a re-render.
const cardsById = new Map();

function createCard(s) {
  const li = document.createElement('li');
  const card = document.createElement('button');
  card.type = 'button';
  card.addEventListener('click', () => selectSession(s.id));

  const top = document.createElement('div');
  top.className = 'sc-top';
  const dot = document.createElement('span'); dot.className = 'sc-dot';
  const label = document.createElement('span'); label.className = 'sc-label';
  top.append(dot, label);

  const title = document.createElement('div'); title.className = 'sc-title';

  const meta = document.createElement('div'); meta.className = 'sc-meta';
  const agents = metaSpan('agents');
  const events = metaSpan('events');
  const errs = document.createElement('span'); errs.className = 'sc-errors';
  const ago = document.createElement('span');
  meta.append(agents.span, events.span, errs, ago);

  const usage = document.createElement('div'); usage.className = 'sc-usage';
  const modelBadge = document.createElement('span'); modelBadge.className = 'model-badge';
  const tokens = document.createElement('span'); tokens.className = 'sc-tokens';
  usage.append(modelBadge, tokens);

  card.append(top, title, meta, usage);
  li.append(card);
  const rec = { li, card, dot, label, title, agentsB: agents.b, eventsB: events.b, errs, ago, modelBadge, tokens, usage, section: null };
  cardsById.set(s.id, rec);
  return rec;
}

function updateCardFields(rec, s) {
  rec.card.className = `session-card st-${s.status}` + (s.id === currentSessionId ? ' selected' : '');
  rec.label.textContent = s.label || s.id;
  rec.title.textContent = s.title || '(no prompt yet)';
  rec.agentsB.textContent = String(s.agents);
  rec.eventsB.textContent = String(s.events);
  rec.ago.textContent = fmtAgo(s.lastActivityAt);
  if (s.errors > 0) { rec.errs.textContent = `⚠ ${s.errors}`; rec.errs.style.display = ''; }
  else { rec.errs.style.display = 'none'; }
  const pm = prettyModel(s.model);
  rec.modelBadge.textContent = pm;
  rec.modelBadge.style.display = pm ? '' : 'none';
  const tot = s.usage ? s.usage.total : 0;
  rec.tokens.textContent = tot ? `${fmtTokens(tot)} tokens` : '';
}

// Hide obviously-temporary sessions: the no-session_id fallback ('default') and
// scratch/temp working dirs. Kept conservative so real sessions are never hidden.
function isTempSession(s) {
  if (!s) return true;
  if (s.id === 'default') return true;
  const cwd = (s.cwd || '').toLowerCase();
  return cwd.includes('scratchpad') || /[\\/]temp[\\/]/.test(cwd) || cwd.includes('appdata\\local\\temp');
}

let latestSessions = [];

function renderSessions(sessions) {
  sessions = (sessions || []).filter((s) => !isTempSession(s));
  latestSessions = sessions;
  if (allMode) { aggregateHud(); pruneAllGraphs(sessions); }
  window.__agentviz.sessions = sessions.length;
  countEl.textContent = sessions.length;

  // Auto-select the most recent session if we have none (or ours vanished).
  const stillThere = sessions.some((s) => s.id === currentSessionId);
  if ((!currentSessionId || !stillThere) && sessions.length) {
    selectSession(sessions[0].id);
  }

  const present = new Set();
  const counts = { active: 0, idle: 0, ended: 0 };
  for (const s of sessions) {
    present.add(s.id);
    const status = sessLists[s.status] ? s.status : 'idle';
    counts[status]++;
    let rec = cardsById.get(s.id);
    if (!rec) rec = createCard(s);
    updateCardFields(rec, s);
    // move a card into its section only when the section changes → stable order
    if (rec.section !== status) { sessLists[status].appendChild(rec.li); rec.section = status; }
    if (!allMode && s.id === currentSessionId) updateSessionHud(s);
  }
  // remove cards for sessions that disappeared
  for (const [id, rec] of cardsById) {
    if (!present.has(id)) { rec.li.remove(); cardsById.delete(id); }
  }
  // section headers: counts + hide empties
  for (const status of ['active', 'idle', 'ended']) {
    sessSections[status].hidden = counts[status] === 0;
    sessSections[status].querySelector('.sec-count').textContent = counts[status];
  }
}

function metaSpan(label) {
  const span = document.createElement('span');
  const b = document.createElement('b');
  span.append(b, document.createTextNode(' ' + label));
  return { span, b };
}

function markSelectedCard() {
  for (const [id, rec] of cardsById) rec.card.classList.toggle('selected', id === currentSessionId);
}

function selectSession(id) {
  if (id === currentSessionId) return;
  currentSessionId = id;
  scene.reset();
  log.reset();
  seenEventIds = new Set();
  sessionEvents = [];
  currentGraph = null;
  // reset the timeline back to live for the new session
  stopPlayback();
  timelineMode = 'live';
  timelineIndex = -1;
  timelineEl.classList.remove('replaying');
  window.__agentviz.timelineMode = 'live';
  syncTimelineMax();
  closeInspector();
  updateStats({ agents: {} });
  currentSummary = null;
  statTokens.textContent = '0'; modelPill.hidden = true;
  statErrors.textContent = '0'; errTile.classList.remove('has-errors');
  statCache.textContent = '0%'; cacheTile.classList.remove('good');
  ws.send({ type: 'subscribe', sessionId: id });
  markSelectedCard(); // reflect selection immediately
}

// ---------- timeline UI ----------
const timelineEl = document.getElementById('timeline');
const tlPlay = document.getElementById('tl-play');
const tlRange = document.getElementById('tl-range');
const tlPos = document.getElementById('tl-pos');
const tlTime = document.getElementById('tl-time');
const tlLive = document.getElementById('tl-live');

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function stopPlayback() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  tlPlay.textContent = '▶';
  tlPlay.setAttribute('aria-label', 'Play');
}

function enterReplay() {
  if (timelineMode !== 'replay') {
    timelineMode = 'replay';
    timelineEl.classList.add('replaying');
    tlLive.classList.remove('is-live');
  }
  window.__agentviz.timelineMode = 'replay';
}

// Reflect current mode/index into the timeline controls (does not rebuild scene).
function updateTimelineUI() {
  const len = sessionEvents.length;
  tlRange.max = String(Math.max(0, len - 1));
  const idx = timelineMode === 'replay' ? timelineIndex : len - 1;
  if (idx >= 0) tlRange.value = String(idx);
  tlPos.textContent = `${len === 0 ? 0 : idx + 1} / ${len}`;
  const ev = idx >= 0 ? sessionEvents[idx] : null;
  tlTime.textContent = ev ? fmtClock(ev.ts) : '--:--:--';
  tlLive.classList.toggle('is-live', timelineMode === 'live');
  tlLive.textContent = timelineMode === 'live' ? '● LIVE' : 'LIVE';
  window.__agentviz.timelineMode = timelineMode;
  window.__agentviz.timelineIndex = idx;
}

// Called whenever the buffer grows (or a session loads): show/hide the bar, keep
// the scrubber max in sync, and in live mode ride the leading edge.
function syncTimelineMax() {
  if (allMode) { timelineEl.hidden = true; return; } // timeline is per-session
  const len = sessionEvents.length;
  timelineEl.hidden = len === 0;
  if (len === 0) { stopPlayback(); timelineIndex = -1; updateTimelineUI(); return; }
  if (timelineMode === 'live') timelineIndex = len - 1;
  updateTimelineUI();
}

// Rebuild the scene + log AS OF `index` (static — no beam replay). Cheap enough
// to call on every scrub tick.
function renderUpTo(index) {
  const len = sessionEvents.length;
  if (len === 0) return;
  index = Math.max(0, Math.min(len - 1, index));
  const slice = sessionEvents.slice(0, index + 1);
  scene.reset();
  log.reset();
  const rebuilt = buildStateFromEvents(slice);
  scene.setGraph(rebuilt.graph);
  updateStats(rebuilt.graph);
  for (const ev of slice) log.add(ev);
  const cur = slice[slice.length - 1];
  if (cur && cur.agentId) scene.pulse(cur.agentId);
  timelineIndex = index;
  window.__agentviz.timelineIndex = index;
}

// Enter replay and jump to a specific event index (used by the scrubber + tests).
function scrubTo(index) {
  if (sessionEvents.length === 0) return;
  stopPlayback();
  enterReplay();
  renderUpTo(index);
  updateTimelineUI();
}

// Snap back to the latest live state and resume following new events.
function goLive() {
  stopPlayback();
  timelineMode = 'live';
  timelineEl.classList.remove('replaying');
  window.__agentviz.timelineMode = 'live';
  scene.reset();
  log.reset();
  if (currentGraph) { scene.setGraph(currentGraph); updateStats(currentGraph); }
  else { const r = buildStateFromEvents(sessionEvents); scene.setGraph(r.graph); updateStats(r.graph); }
  for (const ev of sessionEvents) log.add(ev);
  timelineIndex = sessionEvents.length - 1;
  refreshInspector();
  syncTimelineMax();
}

function togglePlay() {
  if (playTimer) { stopPlayback(); return; }
  const len = sessionEvents.length;
  if (len === 0) return;
  enterReplay();
  if (timelineIndex >= len - 1) renderUpTo(0); // at the end → replay from the start
  updateTimelineUI();
  tlPlay.textContent = '⏸';
  tlPlay.setAttribute('aria-label', 'Pause');
  playTimer = setInterval(() => {
    if (timelineIndex >= sessionEvents.length - 1) { stopPlayback(); return; }
    renderUpTo(timelineIndex + 1);
    updateTimelineUI();
  }, 250);
}

tlRange.addEventListener('input', () => scrubTo(Number(tlRange.value)));
tlPlay.addEventListener('click', togglePlay);
tlLive.addEventListener('click', () => { if (timelineMode !== 'live') goLive(); });
syncTimelineMax();

// ---------- socket ----------
const ws = connect({
  onState: setStatus,
  onMessage: (msg) => {
    if (msg.type === 'sessions') {
      renderSessions(msg.sessions || []);
      return;
    }
    // combined "all sessions on one canvas" mode
    if (allMode) {
      if (msg.type === 'allSnapshot') applyAllSnapshot(msg.sessions || []);
      else if (msg.type === 'update') applyAllUpdate(msg);
      return;
    }
    if (msg.type === 'snapshot') {
      if (msg.sessionId !== currentSessionId) return;
      scene.reset();
      log.reset();
      seenEventIds = new Set();
      sessionEvents = (msg.events || []).slice(-MAX_SESSION_EVENTS);
      currentGraph = msg.graph || null;
      if (msg.graph) { scene.setGraph(msg.graph); updateStats(msg.graph); }
      for (const ev of msg.events || []) { seenEventIds.add(ev.id); log.add(ev); }
      window.__agentviz.events = (msg.events || []).length;
      // a fresh snapshot re-seats the timeline at the live leading edge
      timelineMode = 'live';
      timelineEl.classList.remove('replaying');
      window.__agentviz.timelineMode = 'live';
      syncTimelineMax();
      refreshInspector();
      if (msg.meta) updateSessionHud(msg.meta);
      if (msg.graph) {
        for (const a of Object.values(msg.graph.agents)) {
          if (a.status === 'active') scene.pulse(a.id, undefined);
        }
      }
    } else if (msg.type === 'update') {
      if (msg.sessionId !== currentSessionId) return;
      applyEvents(msg.events || [], msg.graph);
      if (msg.meta) updateSessionHud(msg.meta);
    }
  },
});

// ---------- hover tooltip ----------
canvas.addEventListener('pointermove', (e) => {
  const agent = scene.pick(e.clientX, e.clientY);
  if (agent) {
    tooltip.hidden = false;
    tooltip.style.left = e.clientX + 14 + 'px';
    tooltip.style.top = e.clientY + 14 + 'px';
    tooltip.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = agent.name || agent.id;
    const meta = document.createElement('div');
    meta.style.color = 'var(--muted)';
    meta.style.fontSize = '11px';
    meta.textContent = `${agent.type} · ${agent.status}` + (agent.toolCount ? ` · ${agent.toolCount} tools` : '');
    tooltip.append(strong, meta);
    if (agent.summary) {
      const sm = document.createElement('div');
      sm.style.marginTop = '3px';
      sm.textContent = agent.summary;
      tooltip.append(sm);
    }
    canvas.style.cursor = 'pointer';
  } else {
    tooltip.hidden = true;
    canvas.style.cursor = 'grab';
  }
});
canvas.addEventListener('pointerleave', () => { tooltip.hidden = true; });

// ---------- node inspector ----------
const inspector = document.getElementById('inspector');
const inspDot = document.getElementById('insp-dot');
const inspName = document.getElementById('insp-name');
const inspMeta = document.getElementById('insp-meta');
const inspStats = document.getElementById('insp-stats');
const inspEvents = document.getElementById('insp-events');
const inspEvCount = document.getElementById('insp-ev-count');
let inspectedId = null;

const STATUS_COLOR = { active: 'var(--active)', error: 'var(--error)', done: 'var(--active)', idle: 'var(--idle)' };
function shortType(type) { return String(type || '').replace(/_/g, ' '); }

function metaRow(key, value, cls) {
  const k = document.createElement('span'); k.className = 'k'; k.textContent = key;
  const v = document.createElement('span'); v.className = 'v' + (cls ? ' ' + cls : ''); v.textContent = value;
  inspMeta.append(k, v);
}

function renderInspectorMeta(agent) {
  inspName.textContent = agent.name || agent.id;
  inspDot.style.color = STATUS_COLOR[agent.status] || 'var(--muted)';
  inspMeta.replaceChildren();
  metaRow('type', agent.type || '—');
  metaRow('status', agent.status || 'idle', 'st-' + (agent.status || 'idle'));
  const parent = agent.parentId && currentGraph && currentGraph.agents && currentGraph.agents[agent.parentId];
  metaRow('parent', parent ? (parent.name || parent.id) : '—');
  metaRow('tools', String(agent.toolCount || 0));
}

// Session-wide analysis (cache-hit %, memory trimming, tool breakdown) shown when
// the orchestrator/root node is inspected. Hidden for individual subagents.
function renderInspectorStats(agent) {
  const isRoot = agent.type === 'orchestrator' || agent.id === 'root';
  const s = currentSummary;
  if (!isRoot || !s) { inspStats.hidden = true; inspStats.replaceChildren(); return; }
  inspStats.replaceChildren();

  const line = document.createElement('div');
  line.className = 'insp-stat-row';
  const cache = s.cacheHitPct || 0;
  const cacheEl = document.createElement('span');
  cacheEl.className = 'insp-chip' + (cache >= 50 ? ' good' : '');
  cacheEl.textContent = `cache ${cache}%`;
  line.append(cacheEl);
  if (s.trimmed > 0) {
    const tr = document.createElement('span');
    tr.className = 'insp-chip';
    tr.textContent = `⋯ ${s.trimmed} trimmed`;
    line.append(tr);
  }
  inspStats.append(line);

  const breakdown = s.toolBreakdown || {};
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  if (entries.length) {
    const tools = document.createElement('div');
    tools.className = 'insp-tools';
    entries.forEach(([name, count], i) => {
      if (i > 0) tools.append(document.createTextNode(' · '));
      const t = document.createElement('span');
      t.className = 'insp-tool';
      t.textContent = `${name} ×${count}`;
      tools.append(t);
    });
    inspStats.append(tools);
  }
  inspStats.hidden = false;
}

function renderInspectorEvents(id) {
  inspEvents.replaceChildren();
  const evs = sessionEvents.filter((e) => e.agentId === id);
  inspEvCount.textContent = String(evs.length);
  if (!evs.length) {
    const empty = document.createElement('li'); empty.className = 'insp-events-empty';
    empty.textContent = 'No events for this agent yet.';
    inspEvents.append(empty);
    return;
  }
  for (const ev of evs) {
    const li = document.createElement('li');
    li.className = `insp-ev type-${ev.type}` + (ev.error ? ' err' : '');

    const head = document.createElement('div'); head.className = 'insp-ev-head';
    const tag = document.createElement('span'); tag.className = 'type-tag'; tag.textContent = shortType(ev.type);
    const title = document.createElement('span'); title.className = 'insp-ev-title';
    title.textContent = ev.tool || ev.title || '';
    head.append(tag, title);
    if (ev.retry) {
      const rb = document.createElement('span'); rb.className = 'insp-retry';
      rb.textContent = '↻ retry'; rb.title = 'repeated call';
      head.append(rb);
    }
    if (ev.durationMs) {
      const dur = document.createElement('span'); dur.className = 'insp-ev-dur';
      dur.textContent = fmtDur(ev.durationMs);
      head.append(dur);
    }
    li.append(head);

    const detail = ev.detail || '';
    if (detail) {
      const d = document.createElement('div'); d.className = 'insp-ev-detail'; d.textContent = detail;
      li.append(d);
    }
    if (typeof ev.error === 'string' && ev.error) {
      const er = document.createElement('div'); er.className = 'insp-ev-error'; er.textContent = ev.error;
      li.append(er);
    }
    inspEvents.append(li);
  }
}

function openInspector(id) {
  const agent = currentGraph && currentGraph.agents && currentGraph.agents[id];
  if (!agent) return;
  inspectedId = id;
  inspector.hidden = false;
  renderInspectorMeta(agent);
  renderInspectorStats(agent);
  renderInspectorEvents(id);
  window.__agentviz.inspectedAgent = id;
}

function closeInspector() {
  inspectedId = null;
  inspector.hidden = true;
  window.__agentviz.inspectedAgent = null;
}

// re-render the open inspector as fresh events / graph arrive
function refreshInspector() {
  if (!inspectedId) return;
  const agent = currentGraph && currentGraph.agents && currentGraph.agents[inspectedId];
  if (!agent) { closeInspector(); return; }
  renderInspectorMeta(agent);
  renderInspectorStats(agent);
  renderInspectorEvents(inspectedId);
}

document.getElementById('insp-close').addEventListener('click', closeInspector);

// Click a node → open its inspector; click empty canvas → close. The canvas also
// pans on drag, so ignore clicks that moved more than a few px since pointerdown.
let clickDownX = 0, clickDownY = 0;
canvas.addEventListener('pointerdown', (e) => { clickDownX = e.clientX; clickDownY = e.clientY; });
canvas.addEventListener('click', (e) => {
  if (Math.abs(e.clientX - clickDownX) + Math.abs(e.clientY - clickDownY) > 6) return; // was a drag
  const agent = scene.pick(e.clientX, e.clientY);
  // in combined mode, clicking any node drills into that session's own canvas
  if (allMode) { if (agent && agent._sid) exitAllMode(agent._sid); return; }
  if (agent) openInspector(agent.id);
  else closeInspector();
});

// ---------- fit graph to view ----------
pauseBtn.addEventListener('click', () => { scene.fit(); });

// ---------- collapsible panels ----------
for (const btn of document.querySelectorAll('.panel-collapse')) {
  btn.addEventListener('click', () => {
    const panel = document.getElementById(btn.dataset.target);
    if (panel) panel.classList.toggle('collapsed');
  });
}

// ---------- clear inactive / done sessions ----------
for (const btn of document.querySelectorAll('.sec-clear')) {
  btn.addEventListener('click', () => {
    fetch('/api/sessions/clear', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: btn.dataset.status }),
    }).catch(() => {});
  });
}

// ---------- combined view: ALL sessions on one canvas ----------
// One shared "You" node; each session hangs off it as  You → <session> → its
// agents. Node ids are namespaced by session (`sid::agentId`) so they never
// collide. Clicking any node drills into that session's single-canvas view.
const overviewToggle = document.getElementById('overview-toggle');
const allGraphs = new Map(); // sessionId -> { graph, label }

function buildMergedGraph() {
  const agents = { you: { id: 'you', name: 'You', type: 'user', parentId: null, status: 'idle', toolCount: 0 } };
  const edges = [];
  for (const [sid, rec] of allGraphs) {
    const g = rec.graph;
    if (!g || !g.agents) continue;
    for (const a of Object.values(g.agents)) {
      if (a.type === 'user') continue; // fold every session's user into shared "You"
      const nid = sid + '::' + a.id;
      const parentId = a.id === 'root' ? 'you' : sid + '::' + (a.parentId || 'root');
      const name = a.id === 'root' ? (rec.label || a.name || 'Claude') : a.name;
      agents[nid] = { id: nid, name, type: a.type, parentId, status: a.status, toolCount: a.toolCount || 0, _sid: sid };
      edges.push({ from: parentId, to: nid });
    }
  }
  return { agents, edges };
}

function renderMerged() {
  const merged = buildMergedGraph();
  scene.setGraph(merged);
  updateStats(merged); // agent/active counts + task boxes span every session
}

function aggregateHud() {
  const tot = latestSessions.reduce((n, s) => n + (s.usage ? s.usage.total : 0), 0);
  const errs = latestSessions.reduce((n, s) => n + (s.errors || 0), 0);
  statTokens.textContent = fmtTokens(tot);
  statErrors.textContent = String(errs); errTile.classList.toggle('has-errors', errs > 0);
  statCache.textContent = '—'; cacheTile.classList.remove('good');
  modelPill.hidden = true;
  updateViewing(`All sessions (${latestSessions.length})`);
}

function logMergedEvents(label, events) {
  for (const e of events || []) log.add({ ...e, agentName: `[${label}] ${e.agentName || ''}` });
}

function applyAllSnapshot(sessions) {
  allGraphs.clear();
  scene.reset(); log.reset();
  const evs = [];
  for (const s of sessions) {
    allGraphs.set(s.id, { graph: s.graph, label: s.label });
    for (const e of s.events || []) evs.push({ ...e, agentName: `[${s.label}] ${e.agentName || ''}` });
  }
  renderMerged();
  evs.sort((a, b) => a.ts - b.ts);
  for (const e of evs.slice(-400)) log.add(e);
  aggregateHud();
}

// map a session-local agent/edge id into the merged namespace
const mid = (sid, id) => (id === 'user' ? 'you' : `${sid}::${id}`);

// drive tool chips / beams / activity for one session's event on the merged
// canvas — same visuals as the single view, just namespaced by session.
function mergedVisualize(sid, ev) {
  if (ev.callId && ev.type === 'tool_use') {
    scene.toolCall(mid(sid, ev.agentId), `${sid}::${ev.callId}`, ev.kind, ev.tool, ev.detail);
    window.__agentviz.tools = scene.toolCount;
    return;
  }
  if (ev.callId && ev.type === 'tool_result') {
    const dur = ev.durationMs ? '  ' + fmtDur(ev.durationMs) : '';
    scene.toolReturn(`${sid}::${ev.callId}`, mid(sid, ev.agentId), (ev.detail || '') + dur, ev.error);
    return;
  }
  if (ev.from && ev.to && ev.from !== ev.to) scene.beam(mid(sid, ev.from), mid(sid, ev.to), ev.type);
  else scene.pulse(mid(sid, ev.agentId));
}

function applyAllUpdate(msg) {
  const label = msg.meta ? msg.meta.label : (allGraphs.get(msg.sessionId)?.label || msg.sessionId);
  allGraphs.set(msg.sessionId, { graph: msg.graph, label });
  renderMerged();
  for (const ev of msg.events || []) mergedVisualize(msg.sessionId, ev); // tool chips, beams, activity
  logMergedEvents(label, msg.events);
  aggregateHud();
}

// drop cleared/removed sessions from the merged canvas
function pruneAllGraphs(sessions) {
  const ids = new Set(sessions.map((s) => s.id));
  let changed = false;
  for (const sid of [...allGraphs.keys()]) if (!ids.has(sid)) { allGraphs.delete(sid); changed = true; }
  if (changed && allMode) renderMerged();
}

function enterAllMode() {
  if (allMode) return;
  allMode = true;
  window.__agentviz.allMode = true;
  overviewToggle.classList.add('active');
  stopPlayback();
  timelineEl.hidden = true;      // timeline is per-session; not meaningful merged
  closeInspector();
  scene.reset(); log.reset();
  updateViewing('All sessions');
  ws.send({ type: 'subscribeAll' });      // live updates for every session
  // Populate immediately over HTTP too — robust if the WS snapshot is slow or the
  // running server predates subscribeAll (in which case, please restart it).
  fetch('/api/all').then((r) => r.json()).then((d) => {
    if (allMode && d && d.sessions && d.sessions.length) applyAllSnapshot(d.sessions);
  }).catch(() => {});
}

function exitAllMode(toSessionId) {
  if (!allMode) return;
  allMode = false;
  allGraphs.clear();
  window.__agentviz.allMode = false;
  overviewToggle.classList.remove('active');
  const sid = toSessionId || currentSessionId;
  currentSessionId = null; // force a full re-subscribe/rebuild of the single view
  if (sid) selectSession(sid);
}

// ---------- cross-session search ----------
const searchEl = document.getElementById('search');
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
let searchTimer = null;

function openSearch() { searchEl.hidden = false; searchInput.value = ''; searchResults.replaceChildren(); searchInput.focus(); window.__agentviz.searchOpen = true; }
function closeSearch() { searchEl.hidden = true; window.__agentviz.searchOpen = false; }

function runSearch(q) {
  if (!q.trim()) { searchResults.replaceChildren(); return; }
  fetch('/api/search?limit=60&q=' + encodeURIComponent(q)).then((r) => r.json()).then((d) => {
    searchResults.replaceChildren();
    for (const hit of d.results || []) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'search-hit' + (hit.error ? ' err' : '');
      const top = document.createElement('div'); top.className = 'sh-top';
      const label = document.createElement('span'); label.className = 'sh-label'; label.textContent = hit.label;
      const type = document.createElement('span'); type.className = 'sh-type'; type.textContent = (hit.tool || hit.type || '').replace(/_/g, ' ');
      const time = document.createElement('span'); time.className = 'sh-time'; time.textContent = new Date(hit.ts).toLocaleTimeString([], { hour12: false });
      top.append(label, type, time);
      const det = document.createElement('div'); det.className = 'sh-detail';
      det.textContent = hit.title + (hit.detail ? ' — ' + hit.detail : '');
      btn.append(top, det);
      btn.addEventListener('click', () => { closeSearch(); if (allMode) exitAllMode(hit.sessionId); else selectSession(hit.sessionId); });
      li.append(btn); searchResults.append(li);
    }
  }).catch(() => {});
}

document.getElementById('search-btn').addEventListener('click', () => (searchEl.hidden ? openSearch() : closeSearch()));
document.getElementById('search-close').addEventListener('click', closeSearch);
searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(searchInput.value), 200); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !searchEl.hidden) closeSearch(); });
window.__agentviz.searchOpen = false;

// download the current session (or all, in combined mode) as JSON
document.getElementById('export-btn').addEventListener('click', () => {
  let url = '/api/export';
  if (allMode) url += '?all=1';
  else if (currentSessionId) url += '?session=' + encodeURIComponent(currentSessionId);
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.click();
});

overviewToggle.addEventListener('click', () => (allMode ? exitAllMode() : enterAllMode()));
viewingPill.addEventListener('click', () => (allMode ? exitAllMode() : enterAllMode()));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && allMode) exitAllMode(); });

window.__agentviz.allMode = false;
window.__agentviz.enterAllMode = () => enterAllMode();
