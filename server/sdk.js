// sdk.js — translate Claude Agent SDK stream messages into the same hook-shaped
// payloads the Claude Code path uses, so SDK-driven apps show up in the visualizer
// alongside Claude Code sessions. Reuses the whole normalizer/session pipeline.
//
// Handled SDK message types: system(init), assistant, user, result. Anything else
// yields no payloads. State (tool_use_id → name) is kept per session so a
// tool_result — which only carries tool_use_id — maps back to the right tool.

const sdkStates = new Map(); // session_id -> { toolNames: Map<id,name> }

function stateFor(id) {
  let s = sdkStates.get(id);
  if (!s) { s = { toolNames: new Map() }; sdkStates.set(id, s); }
  return s;
}

function usageDelta(u) {
  if (!u) return undefined;
  // Only include fields that are actually present — applyUsageDelta treats a
  // missing field as "unchanged", so we must not coerce absent values to 0.
  const d = { output: u.output_tokens || 0 };
  if (u.input_tokens != null) d.input = u.input_tokens;
  if (u.cache_read_input_tokens != null) d.cacheRead = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens != null) d.cacheCreation = u.cache_creation_input_tokens;
  return d;
}

function resultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : (b && b.text) || '')).join(' ').trim();
  }
  if (typeof content === 'object') return content.text || content.output || JSON.stringify(content);
  return String(content);
}

// message: a single SDK stream message. ctx: { session_id, cwd, label }.
// Returns an array of hook-shaped payloads.
export function sdkMessageToPayloads(message, ctx = {}) {
  if (!message || typeof message !== 'object') return [];
  const sid = String(ctx.session_id || message.session_id || 'sdk');
  const st = stateFor(sid);
  const base = { session_id: sid };
  if (ctx.cwd) base.cwd = ctx.cwd;
  if (ctx.label) base.label = ctx.label;
  const out = [];

  switch (message.type) {
    case 'system': {
      if (message.subtype === 'init') {
        out.push({ ...base, hook_event_name: 'SessionStart', source: 'sdk', model: message.model, cwd: message.cwd || ctx.cwd });
      }
      break;
    }
    case 'assistant': {
      const m = message.message || {};
      const model = m.model;
      const delta = usageDelta(m.usage);
      const blocks = Array.isArray(m.content) ? m.content : [];
      const toolUses = blocks.filter((b) => b && b.type === 'tool_use');
      let metaAttached = false;
      for (const b of toolUses) {
        st.toolNames.set(b.id, b.name);
        const p = { ...base, hook_event_name: 'PreToolUse', tool_name: b.name, tool_input: b.input || {}, tool_use_id: b.id };
        if (model) p.model = model;
        if (!metaAttached && delta) { p.usageDelta = delta; metaAttached = true; }
        out.push(p);
      }
      // No tool calls but we still learned model/usage → carry it on a metadata-only event.
      if (!metaAttached && (model || delta)) {
        out.push({ ...base, hook_event_name: '__meta', model, usageDelta: delta });
      }
      break;
    }
    case 'user': {
      const m = message.message || {};
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b && b.type === 'tool_result') {
          const name = st.toolNames.get(b.tool_use_id) || 'tool';
          st.toolNames.delete(b.tool_use_id);
          out.push({ ...base, hook_event_name: 'PostToolUse', tool_name: name, tool_use_id: b.tool_use_id, tool_response: { output: resultText(b.content), is_error: !!b.is_error } });
        }
      }
      break;
    }
    case 'result': {
      out.push({ ...base, hook_event_name: 'Stop' });
      if (message.subtype && message.subtype !== 'success') {
        out.push({ ...base, hook_event_name: 'Notification', message: `result: ${message.subtype}` });
      }
      break;
    }
    default:
      break;
  }
  return out;
}

// Free per-session translator state (call when a session ends / is removed).
export function forgetSdkSession(sessionId) {
  sdkStates.delete(String(sessionId));
}
