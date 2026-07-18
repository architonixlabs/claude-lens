// Unit tests for the normalizer — the core that turns Claude Code hook payloads
// into normalized events + an agent graph. Run with:  npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { Normalizer } from '../server/normalize.js';

const ev = (n, p) => n.process({ __ts: 1000, ...p });

test('SessionStart activates the orchestrator', () => {
  const n = new Normalizer();
  const out = ev(n, { hook_event_name: 'SessionStart', cwd: '/repo' });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'session_start');
  assert.equal(n.graph.agents.root.status, 'active');
});

test('UserPromptSubmit beams You → Claude', () => {
  const n = new Normalizer();
  const [m] = ev(n, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.equal(m.type, 'message');
  assert.equal(m.from, 'user');
  assert.equal(m.to, 'root');
});

test('Task spawns a subagent node under the current owner', () => {
  const n = new Normalizer();
  const [spawn] = ev(n, { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'auditor', description: 'audit' } });
  assert.equal(spawn.type, 'agent_spawn');
  const sub = n.graph.agents['sub-1'];
  assert.ok(sub, 'subagent node exists');
  assert.equal(sub.type, 'subagent');
  assert.equal(sub.parentId, 'root');
  assert.equal(sub.status, 'active');
});

test('non-Task tool: Pre→Post pairs by tool_use_id, with kind + duration + result', () => {
  const n = new Normalizer();
  n.process({ __ts: 1000, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'b1' });
  const [res] = [n.process({ __ts: 1500, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_response: { stdout: 'ok' } })].flat();
  assert.equal(res.type, 'tool_result');
  assert.equal(res.callId, 'b1');       // matched by id
  assert.equal(res.durationMs, 500);    // 1500 - 1000
  assert.equal(res.error, false);
});

test('non-zero exit / is_error is flagged as an error', () => {
  const n = new Normalizer();
  n.process({ __ts: 1000, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'e1' });
  const [res] = [n.process({ __ts: 1100, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'e1', tool_response: { exit_code: 1 } })].flat();
  assert.equal(res.error, true);
});

test('Skill becomes a graph node and a Task inside it nests under the skill', () => {
  const n = new Normalizer();
  ev(n, { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'review' } });
  const skillId = Object.keys(n.graph.agents).find((id) => n.graph.agents[id].type === 'skill');
  assert.ok(skillId, 'skill node exists');
  ev(n, { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'child' } });
  const child = Object.values(n.graph.agents).find((a) => a.type === 'subagent');
  assert.equal(child.parentId, skillId, 'subagent nests under the skill');
});

test('repeated identical tool call is flagged as a retry', () => {
  const n = new Normalizer();
  const call = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } };
  const [first] = ev(n, call);
  const [second] = ev(n, call);
  assert.ok(!first.retry);
  assert.equal(second.retry, true);
});

test('MCP tools are classified as kind "mcp"', () => {
  const n = new Normalizer();
  const [use] = ev(n, { hook_event_name: 'PreToolUse', tool_name: 'mcp__sonarqube__search', tool_input: {} });
  assert.equal(use.kind, 'mcp');
});

test('__-prefixed (metadata-only) events produce no visible events', () => {
  const n = new Normalizer();
  assert.equal(ev(n, { hook_event_name: '__meta', model: 'claude-opus-4-8' }).length, 0);
});

test('SubagentStop marks the in-flight subagent done', () => {
  const n = new Normalizer();
  ev(n, { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'w' } });
  const [done] = ev(n, { hook_event_name: 'SubagentStop' });
  assert.equal(done.type, 'agent_done');
  assert.equal(n.graph.agents['sub-1'].status, 'done');
});
