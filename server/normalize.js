// normalize.js — turns raw Claude Code hook payloads into a normalized event
// stream + an evolving agent graph. This is the single source of truth used by
// BOTH the live hook path and the demo simulator, so the two exercise the same code.

const ROOT_ID = 'root';
const USER_ID = 'user';

function isErrorResult(resp) {
  if (!resp || typeof resp !== 'object') return false;
  if (resp.is_error === true || resp.error) return true;
  if (resp.exit_code != null && resp.exit_code !== 0) return true;
  if (typeof resp.exitCode === 'number' && resp.exitCode !== 0) return true;
  return false;
}

function shortText(v, max = 140) {
  if (v == null) return '';
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function toolSummary(tool, input) {
  if (!input || typeof input !== 'object') return shortText(input);
  switch (tool) {
    case 'Bash':
      return shortText(input.command);
    case 'Read':
    case 'Write':
    case 'Edit':
      return shortText(input.file_path);
    case 'Grep':
      return shortText(input.pattern);
    case 'Glob':
      return shortText(input.pattern);
    case 'Task':
      return shortText(input.description || input.prompt);
    case 'WebFetch':
    case 'WebSearch':
      return shortText(input.url || input.query);
    default:
      return shortText(input.description || input.prompt || input.command || input.path || JSON.stringify(input));
  }
}

// Order-independent JSON of a value — so { a, b } and { b, a } sign identically.
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

// FNV-1a — a tiny, deterministic (no Date/Math.random) hash, so the event carries
// a short fingerprint rather than the whole payload.
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

// A repeat signature over the FULL, untruncated tool input. This is the whole
// point of consuming hooks instead of OpenTelemetry: OTel truncates tool_input
// at 512 chars per value, so two different long edits collide; hooks see the
// complete payload, so "did the agent actually repeat itself?" is answered on
// real content — not on the file path, which every edit to one file shares.
function toolSignature(tool, input) {
  return `${tool} ${fnv1a(canonical(input ?? null))}`;
}

export class Normalizer {
  constructor() {
    this.graph = { agents: {}, edges: [] };
    this.seq = 0;
    this.subCounter = 0;
    this.skillCounter = 0;
    this.callSeq = 0;
    // unified scope stack of in-flight owners (top = innermost). Each entry is
    // { id, type } where type is 'subagent' or 'skill'. Tool calls and Task/Skill
    // spawns attribute to the innermost scope, so a Task spawned while a Skill is
    // active nests UNDER the skill.
    this.scope = [];
    // per-owner short memory of recent tool calls ({name, detail}), newest last,
    // capped — used to flag repeated identical calls (retry / thrashing signal).
    this.recent = {};
    // per-owner stack of in-flight tool/skill calls (for Pre→Post correlation)
    this.pending = {};
    // exact Pre→Post correlation by tool_use_id when the source provides one (SDK)
    this.pendingById = new Map();
    this._ensureAgent(USER_ID, { name: 'You', type: 'user', status: 'idle', parentId: null });
    this._ensureAgent(ROOT_ID, { name: 'Claude (orchestrator)', type: 'orchestrator', status: 'idle', parentId: USER_ID });
    this._ensureEdge(USER_ID, ROOT_ID);
  }

  _now(payload) {
    // Prefer any timestamp the caller supplied; else wall clock.
    return Number(payload && payload.__ts) || Date.now();
  }

  _ensureAgent(id, patch = {}) {
    const a = this.graph.agents[id] || (this.graph.agents[id] = {
      id, name: id, type: 'subagent', parentId: ROOT_ID, status: 'idle',
      toolCount: 0, spawnedAt: Date.now(), lastActiveAt: Date.now(), summary: '',
    });
    Object.assign(a, patch);
    return a;
  }

  _ensureEdge(from, to) {
    if (from === to) return;
    if (!this.graph.edges.some((e) => e.from === from && e.to === to)) {
      this.graph.edges.push({ from, to });
    }
  }

  _owner() {
    return this.scope.length ? this.scope[this.scope.length - 1].id : ROOT_ID;
  }

  // Remove and return the topmost scope entry id of the given type (searching
  // from the end), or null if none is currently in-flight.
  _popScope(type) {
    for (let i = this.scope.length - 1; i >= 0; i--) {
      if (this.scope[i].type === type) {
        const [entry] = this.scope.splice(i, 1);
        return entry.id;
      }
    }
    return null;
  }

  // Classify a tool call into a kind + display name.
  _toolKind(toolName, input) {
    if (toolName === 'Skill') {
      const nm = (input && (input.skill || input.command || input.name)) || 'skill';
      return { kind: 'skill', name: shortText(nm, 30) };
    }
    if (typeof toolName === 'string' && toolName.startsWith('mcp__')) {
      const parts = toolName.split('__').filter(Boolean);
      return { kind: 'mcp', name: shortText(parts.slice(1).join(' · ') || toolName, 34) };
    }
    return { kind: 'tool', name: toolName || 'tool' };
  }

  // Find the in-flight call a PostToolUse corresponds to: exact by tool_use_id
  // (SDK), else LIFO stack for the current owner, else a fresh fallback.
  _matchCall(payload, tool) {
    const id = payload.tool_use_id;
    if (id && this.pendingById.has(id)) {
      const call = this.pendingById.get(id);
      this.pendingById.delete(id);
      const arr = this.pending[call.owner];
      const idx = arr ? arr.indexOf(call) : -1;
      if (idx >= 0) arr.splice(idx, 1);
      return call;
    }
    const owner = this._owner();
    const popped = (this.pending[owner] || []).pop();
    if (popped) return popped;
    const k = this._toolKind(tool, payload.tool_input);
    return { callId: undefined, name: k.name, kind: k.kind, owner };
  }

  _mk(ts, type, agentId, extra = {}) {
    const a = this.graph.agents[agentId] || {};
    return {
      id: `e${++this.seq}`,
      ts,
      type,
      agentId,
      parentId: a.parentId ?? null,
      agentName: a.name ?? agentId,
      agentType: a.type ?? 'subagent',
      status: a.status ?? 'idle',
      tool: null,
      from: agentId,
      to: agentId,
      title: '',
      detail: '',
      ...extra,
    };
  }

  // Returns an array of normalized events (may be empty). Mutates this.graph.
  process(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const ts = this._now(payload);
    const evName = payload.hook_event_name || payload.event || '';
    // `__`-prefixed events (e.g. __meta from the SDK bridge) carry only model/token
    // metadata — no visible event. Session.ingest still applies that metadata.
    if (typeof evName === 'string' && evName.startsWith('__')) return [];
    const tool = payload.tool_name || (payload.tool_input && payload.tool_input.__tool) || null;
    const out = [];

    switch (evName) {
      case 'SessionStart': {
        this._ensureAgent(ROOT_ID, { status: 'active', lastActiveAt: ts });
        out.push(this._mk(ts, 'session_start', ROOT_ID, {
          title: 'Session started', detail: shortText(payload.source || payload.cwd || ''),
        }));
        break;
      }

      case 'UserPromptSubmit': {
        this._ensureAgent(ROOT_ID, { status: 'active', lastActiveAt: ts });
        out.push(this._mk(ts, 'message', ROOT_ID, {
          from: USER_ID, to: ROOT_ID,
          title: 'Prompt → Claude', detail: shortText(payload.prompt),
        }));
        break;
      }

      case 'PreToolUse': {
        if (tool === 'Task') {
          const input = payload.tool_input || {};
          const id = `sub-${++this.subCounter}`;
          const name = input.subagent_type || input.description || `subagent ${this.subCounter}`;
          const parentId = this._owner();
          this._ensureAgent(id, {
            name: shortText(name, 40), type: 'subagent', parentId,
            status: 'active', spawnedAt: ts, lastActiveAt: ts,
            summary: shortText(input.description || input.prompt, 120),
          });
          this._ensureEdge(parentId, id);
          this.scope.push({ id, type: 'subagent' });
          out.push(this._mk(ts, 'agent_spawn', id, {
            from: parentId, to: id,
            title: `Dispatch → ${this.graph.agents[id].name}`,
            detail: shortText(input.description || input.prompt),
          }));
        } else if (tool === 'Skill') {
          // A skill becomes a graph node (a mini-subagent): anything it spawns
          // while active nests under it. No transient tool_use chip is emitted.
          const input = payload.tool_input || {};
          const { name } = this._toolKind(tool, input);
          const id = `skill-${++this.skillCounter}`;
          const parentId = this._owner();
          const detail = shortText(input.description || input.prompt || '');
          this._ensureAgent(id, {
            name, type: 'skill', parentId,
            status: 'active', spawnedAt: ts, lastActiveAt: ts,
            summary: detail,
          });
          this._ensureEdge(parentId, id);
          this.scope.push({ id, type: 'skill' });
          out.push(this._mk(ts, 'agent_spawn', id, {
            from: parentId, to: id, agentType: 'skill',
            title: `Skill ▸ ${name}`, detail,
          }));
        } else {
          const owner = this._owner();
          const agent = this._ensureAgent(owner, { status: 'active', lastActiveAt: ts });
          agent.toolCount = (agent.toolCount || 0) + 1;
          const { kind, name } = this._toolKind(tool, payload.tool_input);
          const callId = payload.tool_use_id || `c${++this.callSeq}`;
          const call = { callId, name, kind, owner, startTs: ts };
          const stack = this.pending[owner] || (this.pending[owner] = []);
          stack.push(call);
          if (payload.tool_use_id) this.pendingById.set(payload.tool_use_id, call);
          const detail = toolSummary(tool, payload.tool_input);
          // Thrashing signal: same owner calling the same tool with the same
          // input as one of its last ~3 calls → mark the event as a retry.
          // Compared on a full-payload signature, NOT the display summary — two
          // different edits to one file share a summary but not a signature.
          const sig = toolSignature(tool, payload.tool_input);
          const recents = this.recent[owner] || (this.recent[owner] = []);
          let retryCount = 0;
          for (const r of recents) if (r.sig === sig) retryCount++;
          recents.push({ sig });
          if (recents.length > 3) recents.shift();
          const retryExtra = retryCount > 0 ? { retry: true, retryCount } : {};
          out.push(this._mk(ts, 'tool_use', owner, {
            tool: name, kind, callId, title: name, detail, sig, ...retryExtra,
          }));
        }
        break;
      }

      case 'PostToolUse': {
        if (tool === 'Task') {
          const id = this._popScope('subagent') || `sub-${this.subCounter}`;
          const err = isErrorResult(payload.tool_response);
          const sub = this._ensureAgent(id, { status: err ? 'error' : 'done', lastActiveAt: ts });
          const durationMs = sub.spawnedAt ? ts - sub.spawnedAt : 0;
          out.push(this._mk(ts, err ? 'agent_error' : 'tool_result', id, {
            from: id, to: sub.parentId, error: err, durationMs,
            title: `${this.graph.agents[id].name} ${err ? '✗ failed' : '→ result'}`,
            detail: shortText(extractResult(payload.tool_response)),
          }));
        } else if (tool === 'Skill') {
          const id = this._popScope('skill') || `skill-${this.skillCounter}`;
          const err = isErrorResult(payload.tool_response);
          const sk = this._ensureAgent(id, { status: err ? 'error' : 'done', lastActiveAt: ts });
          const durationMs = sk.spawnedAt ? ts - sk.spawnedAt : 0;
          out.push(this._mk(ts, err ? 'agent_error' : 'agent_done', id, {
            from: id, to: sk.parentId, error: err, durationMs,
            title: `${sk.name} ${err ? '✗ failed' : '✓'}`,
            detail: shortText(extractResult(payload.tool_response)),
          }));
        } else {
          const call = this._matchCall(payload, tool);
          const owner = call.owner || this._owner();
          this._ensureAgent(owner, { status: 'active', lastActiveAt: ts });
          const err = isErrorResult(payload.tool_response);
          const durationMs = call.startTs ? ts - call.startTs : 0;
          out.push(this._mk(ts, 'tool_result', owner, {
            tool: call.name, kind: call.kind || 'tool', callId: call.callId,
            error: err, durationMs,
            title: `${call.name} ${err ? '✗' : '✓'}`,
            detail: shortText(extractResult(payload.tool_response)),
          }));
        }
        break;
      }

      case 'SubagentStop': {
        const id = this._popScope('subagent');
        if (id && this.graph.agents[id]) {
          this._ensureAgent(id, { status: 'done', lastActiveAt: ts });
          out.push(this._mk(ts, 'agent_done', id, {
            from: id, to: this.graph.agents[id].parentId,
            title: `${this.graph.agents[id].name} finished`,
          }));
        }
        break;
      }

      case 'PreCompact': {
        // Claude is compacting its own context window. Surface it prominently on
        // the orchestrator so the log never implies activity was silently dropped.
        this._ensureAgent(ROOT_ID, { status: 'active', lastActiveAt: ts });
        const trigger = shortText(payload.trigger || 'manual', 20);
        out.push(this._mk(ts, 'compact', ROOT_ID, {
          title: `Context compacted (${trigger})`,
          detail: shortText(payload.custom_instructions || ''),
        }));
        break;
      }

      case 'Notification': {
        out.push(this._mk(ts, 'note', ROOT_ID, {
          title: 'Notification', detail: shortText(payload.message),
        }));
        break;
      }

      case 'Stop': {
        this._ensureAgent(ROOT_ID, { status: 'idle', lastActiveAt: ts });
        out.push(this._mk(ts, 'note', ROOT_ID, { title: 'Turn complete' }));
        break;
      }

      case 'SessionEnd': {
        // mark everything settled
        for (const id of Object.keys(this.graph.agents)) {
          if (id !== USER_ID) this.graph.agents[id].status = 'done';
        }
        out.push(this._mk(ts, 'session_end', ROOT_ID, { title: 'Session ended' }));
        break;
      }

      default: {
        // Unknown / custom event — surface as a note so nothing is silently dropped.
        out.push(this._mk(ts, 'note', ROOT_ID, {
          title: shortText(evName || 'event', 40),
          detail: shortText(payload.message || payload.detail || ''),
        }));
      }
    }
    return out;
  }

  snapshot(recentEvents) {
    return { graph: this.graph, events: recentEvents };
  }
}

function extractResult(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string') return resp;
  if (typeof resp === 'object') {
    return resp.stdout || resp.output || resp.result || resp.content || JSON.stringify(resp);
  }
  return String(resp);
}

export { ROOT_ID, USER_ID };
