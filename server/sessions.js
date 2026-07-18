// sessions.js — multi-session state. Each Claude Code session (keyed by its
// session_id) gets its own Normalizer/graph and event ring buffer. The
// SessionManager routes every ingested hook payload to the right session and
// publishes (a) a lightweight session list and (b) per-session updates.

import { Normalizer, ROOT_ID, USER_ID } from './normalize.js';
import { readUsage } from './transcript.js';
import { detectStalls } from './analysis.js';

const MAX_EVENTS = 3000;
const MAX_SESSIONS = 300;      // cap live sessions in memory (evict oldest inactive)
const ACTIVE_WINDOW_MS = 90_000;
const TRANSCRIPT_THROTTLE_MS = 1200;

function basename(p) {
  if (!p) return '';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

function deriveLabel(meta) {
  return meta.customLabel || basename(meta.cwd)
    || (meta.source ? `session (${meta.source})` : `session ${meta.id.slice(0, 6)}`);
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, lastOutput: 0 };
}

export class Session {
  constructor(id) {
    this.id = id;
    this.normalizer = new Normalizer();
    this.events = [];
    this.meta = {
      id, label: `session ${id.slice(0, 6)}`, customLabel: '', title: '', cwd: '', source: '',
      startedAt: Date.now(), lastActivityAt: Date.now(), ended: false,
      model: '', usage: emptyUsage(), errors: 0, tools: 0,
      trimmed: 0, toolBreakdown: {},
    };
    // internals for incremental transcript reading (real sessions)
    this._transcriptPath = '';
    this._offset = 0;
    this._tail = '';
    this._accOut = 0;
    this._lastRead = 0;
  }

  ingest(payload) {
    const produced = this.normalizer.process(payload) || [];
    const now = Number(payload.__ts) || Date.now();
    this.meta.lastActivityAt = now;

    // Claude Code includes these on (almost) every hook event — capture always so
    // labels/model fill in even for sessions that started before hooks were wired.
    if (payload.cwd) this.meta.cwd = payload.cwd;
    if (payload.label) this.meta.customLabel = String(payload.label).slice(0, 40);
    if (payload.transcript_path) this._transcriptPath = payload.transcript_path;
    if (payload.model) this.meta.model = payload.model;
    if (payload.usage) this.applyUsage(payload.usage);           // absolute snapshot (demo)
    if (payload.usageDelta) this.applyUsageDelta(payload.usageDelta); // incremental (SDK)

    switch (payload.hook_event_name) {
      case 'SessionStart':
        this.meta.source = payload.source || this.meta.source;
        this.meta.ended = false;
        this.meta.startedAt = this.meta.startedAt || now;
        break;
      case 'UserPromptSubmit':
        if (payload.prompt) this.meta.title = String(payload.prompt).slice(0, 90);
        break;
      case 'SessionEnd':
        this.meta.ended = true;
        break;
      default:
        break;
    }
    this.meta.label = deriveLabel(this.meta);
    for (const e of produced) {
      this.events.push(e);
      if (e.error) this.meta.errors++;
      if (e.type === 'tool_use') {
        this.meta.tools++;
        const key = e.tool || 'tool';
        this.meta.toolBreakdown[key] = (this.meta.toolBreakdown[key] || 0) + 1;
      }
    }
    // Ring-buffer trim — but never silently: track a cumulative trimmed count and
    // synthesize a visible note the first time (and every +500 dropped after) so
    // the log reflects that older activity was compacted out of memory.
    const over = this.events.length - MAX_EVENTS;
    if (over > 0) {
      this.events.splice(0, over);
      const prev = this.meta.trimmed;
      this.meta.trimmed += over;
      if (prev === 0 || Math.floor(this.meta.trimmed / 500) > Math.floor(prev / 500)) {
        const note = this._trimNote(this.meta.trimmed);
        this.events.push(note);
        produced.push(note);
      }
    }
    return produced;
  }

  // A synthetic 'note' event (on the orchestrator) announcing memory trimming.
  _trimNote(trimmed) {
    const ts = Date.now();
    return {
      id: `trim-${trimmed}`, ts, type: 'note',
      agentId: ROOT_ID, parentId: USER_ID,
      agentName: 'Claude (orchestrator)', agentType: 'orchestrator', status: 'idle',
      tool: null, kind: null, callId: null, from: ROOT_ID, to: ROOT_ID,
      title: `⋯ compacted ${trimmed} older events (memory)`, detail: '',
      error: null, durationMs: 0,
    };
  }

  // Absolute usage snapshot (used by the demo and by explicit hook payloads).
  applyUsage(u) {
    const usg = this.meta.usage;
    if (u.input != null) usg.input = u.input;
    if (u.output != null) usg.output = u.output;
    if (u.cacheRead != null) usg.cacheRead = u.cacheRead;
    if (u.cacheCreation != null) usg.cacheCreation = u.cacheCreation;
    if (u.lastOutput != null) usg.lastOutput = u.lastOutput;
    usg.total = usg.input + usg.output + usg.cacheRead + usg.cacheCreation;
  }

  // Incremental usage from an SDK assistant message: output accumulates; input +
  // cache reflect the latest message's context.
  applyUsageDelta(u) {
    const usg = this.meta.usage;
    usg.output += u.output || 0;
    usg.lastOutput = u.output || 0;
    if (u.input != null) usg.input = u.input;
    if (u.cacheRead != null) usg.cacheRead = u.cacheRead;
    if (u.cacheCreation != null) usg.cacheCreation = u.cacheCreation;
    usg.total = usg.input + usg.output + usg.cacheRead + usg.cacheCreation;
  }

  reset() {
    this.normalizer = new Normalizer();
    this.events = [];
    this.meta.title = '';
    this.meta.startedAt = Date.now();
    this.meta.lastActivityAt = Date.now();
    this.meta.ended = false;
    this.meta.usage = emptyUsage();
    this.meta.errors = 0; this.meta.tools = 0;
    this.meta.trimmed = 0; this.meta.toolBreakdown = {};
    this._offset = 0; this._tail = ''; this._accOut = 0;
  }

  summary() {
    const now = Date.now();
    const agents = Object.values(this.normalizer.graph.agents).filter((a) => a.type !== 'user');
    const active = agents.filter((a) => a.status === 'active').length;
    let status = 'idle';
    if (this.meta.ended) status = 'ended';
    else if (now - this.meta.lastActivityAt < ACTIVE_WINDOW_MS) status = 'active';
    const u = this.meta.usage;
    const cacheDenom = u.cacheRead + u.input + u.cacheCreation;
    const cacheHitPct = cacheDenom > 0 ? Math.round((100 * u.cacheRead) / cacheDenom) : 0;
    // compact "what's happening now" for the combined overview tiles
    const last = this.events[this.events.length - 1];
    const lastEvent = last
      ? { type: last.type, tool: last.tool || null, title: last.title || '', detail: last.detail || '', error: !!last.error }
      : null;
    const activeAgents = agents.filter((a) => a.status === 'active').map((a) => a.name);
    return {
      id: this.id, label: this.meta.label, title: this.meta.title, cwd: this.meta.cwd,
      agents: agents.length, active, events: this.events.length, status,
      startedAt: this.meta.startedAt, lastActivityAt: this.meta.lastActivityAt,
      model: this.meta.model, usage: this.meta.usage,
      errors: this.meta.errors, tools: this.meta.tools,
      cacheHitPct, trimmed: this.meta.trimmed, toolBreakdown: this.meta.toolBreakdown,
      lastEvent, activeAgents,
      // Cheap enough for the hot path (timestamp comparison only). The richer
      // judgements — loops, health score — scan events, so they stay on-demand
      // behind /api/report and /api/alerts rather than running per broadcast.
      stalled: detectStalls(this, now).stalled,
    };
  }

  snapshot() {
    return {
      type: 'snapshot',
      sessionId: this.id,
      graph: this.normalizer.graph,
      events: this.events.slice(-800),
      meta: this.summary(),
    };
  }
}

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.subscribers = new Set();
    this.stats = { ingested: 0, dropped: 0 };
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _emit(msg) {
    for (const fn of this.subscribers) {
      try { fn(msg); } catch { /* isolate subscriber errors */ }
    }
  }

  _idOf(payload) {
    return String((payload && (payload.session_id || payload.sessionId)) || 'default');
  }

  ingest(payload) {
    const id = this._idOf(payload || {});
    let session = this.sessions.get(id);
    const isNew = !session;
    if (!session) { session = new Session(id); this.sessions.set(id, session); this._evictIfNeeded(id); }

    let produced;
    try { produced = session.ingest(payload) || []; }
    catch { this.stats.dropped++; produced = []; }

    if (produced.length) {
      this.stats.ingested += produced.length;
      this._emit({ type: 'update', sessionId: id, events: produced, graph: session.normalizer.graph, meta: session.summary() });
    }
    // also refresh the session list when only metadata (model/tokens/label) changed
    const metaOnly = !!(payload.model || payload.usage || payload.usageDelta || payload.label);
    if (produced.length || isNew || metaOnly) {
      this._emit({ type: 'sessions', sessions: this.list() });
    }
    this._maybeReadTranscript(session);
    return produced;
  }

  // Throttled, non-blocking: pull the latest model + token usage from the
  // session's transcript file and re-broadcast the session list if it changed.
  _maybeReadTranscript(session) {
    const now = Date.now();
    if (!session._transcriptPath) return;
    if (now - session._lastRead < TRANSCRIPT_THROTTLE_MS) return;
    session._lastRead = now;
    readUsage(session)
      .then((changed) => { if (changed) this._emit({ type: 'sessions', sessions: this.list() }); })
      .catch(() => {});
  }

  list() {
    return [...this.sessions.values()]
      .map((s) => s.summary())
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  get(id) { return this.sessions.get(id); }

  // Bound memory: once over the cap, drop the least-recently-active session that
  // isn't the one we just touched (prefer inactive; disk history is untouched).
  _evictIfNeeded(keepId) {
    if (this.sessions.size <= MAX_SESSIONS) return;
    let victim = null;
    let victimActive = null;
    for (const s of this.sessions.values()) {
      if (s.id === keepId) continue;
      const inactive = (Date.now() - s.meta.lastActivityAt) >= ACTIVE_WINDOW_MS || s.meta.ended;
      if (inactive) { if (!victim || s.meta.lastActivityAt < victim.meta.lastActivityAt) victim = s; }
      else if (!victimActive || s.meta.lastActivityAt < victimActive.meta.lastActivityAt) victimActive = s;
    }
    const drop = victim || victimActive;
    if (drop) { this.sessions.delete(drop.id); this._emit({ type: 'sessions', sessions: this.list() }); }
  }

  // Cross-session full-text search over recorded events. Returns newest-first.
  search(q, limit = 50) {
    const needle = String(q || '').toLowerCase().trim();
    if (!needle) return [];
    const cap = Math.min(500, Math.max(1, limit));
    const results = [];
    outer:
    for (const s of this.sessions.values()) {
      for (const e of s.events) {
        const hay = `${e.title || ''} ${e.detail || ''} ${e.tool || ''} ${e.agentName || ''} ${e.type}`.toLowerCase();
        if (hay.includes(needle)) {
          results.push({
            sessionId: s.id, label: s.meta.label, id: e.id, ts: e.ts, type: e.type,
            tool: e.tool || null, title: e.title || '', detail: e.detail || '',
            agentName: e.agentName || '', error: !!e.error,
          });
          if (results.length >= cap) break outer;
        }
      }
    }
    results.sort((a, b) => b.ts - a.ts);
    return results;
  }

  // Every session's graph + recent events — for the combined "all on one canvas" view.
  allSnapshots() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      label: s.meta.label,
      graph: s.normalizer.graph,
      events: s.events.slice(-40),
      meta: s.summary(),
    }));
  }
  resetSession(id) { const s = this.sessions.get(id); if (s) s.reset(); }
  removeSession(id) {
    if (this.sessions.delete(id)) this._emit({ type: 'sessions', sessions: this.list() });
  }

  // Remove every session currently in the given status ('idle' | 'ended').
  // Returns the ids removed (so callers can drop them from disk too).
  clearByStatus(status) {
    const removed = [];
    for (const [id, s] of this.sessions) {
      if (s.summary().status === status) { this.sessions.delete(id); removed.push(id); }
    }
    if (removed.length) this._emit({ type: 'sessions', sessions: this.list() });
    return removed;
  }
}
