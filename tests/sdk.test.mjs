// SDK bridge unit tests — Claude Agent SDK stream messages must translate into
// the same hook payloads the normalizer already understands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sdkMessageToPayloads, forgetSdkSession } from '../server/sdk.js';

const CTX = { session_id: 'sdk-test', cwd: '/x/app' };
const byEvent = (payloads, name) => payloads.filter((p) => p.hook_event_name === name);

test('ignores non-objects and unknown message types', () => {
  assert.deepEqual(sdkMessageToPayloads(null), []);
  assert.deepEqual(sdkMessageToPayloads('nope'), []);
  assert.deepEqual(sdkMessageToPayloads({ type: 'wat' }), []);
});

test('system/init becomes SessionStart carrying model + cwd', () => {
  const [p, ...rest] = sdkMessageToPayloads(
    { type: 'system', subtype: 'init', model: 'claude-opus-4-8', cwd: '/x/app' }, CTX);
  assert.equal(rest.length, 0);
  assert.equal(p.hook_event_name, 'SessionStart');
  assert.equal(p.source, 'sdk');
  assert.equal(p.model, 'claude-opus-4-8');
  assert.equal(p.cwd, '/x/app');
  assert.equal(p.session_id, 'sdk-test');
});

test('assistant tool_use blocks become PreToolUse keyed by tool_use_id', () => {
  forgetSdkSession('sdk-test');
  const out = sdkMessageToPayloads({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      content: [
        { type: 'text', text: 'let me look' },
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/a.js' } },
      ],
    },
  }, CTX);

  const pre = byEvent(out, 'PreToolUse');
  assert.equal(pre.length, 2);
  assert.deepEqual(pre.map((p) => p.tool_name), ['Bash', 'Read']);
  assert.deepEqual(pre.map((p) => p.tool_use_id), ['tu_1', 'tu_2']);
  assert.deepEqual(pre[0].tool_input, { command: 'ls' });
});

test('tool_result pairs back to the right tool name via tool_use_id', () => {
  forgetSdkSession('sdk-test');
  sdkMessageToPayloads({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_9', name: 'Grep', input: {} }] },
  }, CTX);

  const [post] = sdkMessageToPayloads({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_9', content: 'match found' }] },
  }, CTX);

  assert.equal(post.hook_event_name, 'PostToolUse');
  assert.equal(post.tool_name, 'Grep', 'name must be recovered from the earlier tool_use');
  assert.equal(post.tool_use_id, 'tu_9');
  assert.equal(post.tool_response.is_error, false);
  assert.match(post.tool_response.output, /match found/);
});

test('is_error on a tool_result is preserved', () => {
  forgetSdkSession('sdk-test');
  sdkMessageToPayloads({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_e', name: 'Bash', input: {} }] },
  }, CTX);
  const [post] = sdkMessageToPayloads({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_e', content: 'boom', is_error: true }] },
  }, CTX);
  assert.equal(post.tool_response.is_error, true);
});

test('an unknown tool_use_id still yields a usable PostToolUse', () => {
  forgetSdkSession('sdk-test');
  const [post] = sdkMessageToPayloads({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'never-seen', content: 'x' }] },
  }, CTX);
  assert.equal(post.hook_event_name, 'PostToolUse');
  assert.equal(post.tool_name, 'tool'); // safe fallback
});

test('assistant text-only message carries model/usage on a metadata-only event', () => {
  forgetSdkSession('sdk-test');
  const out = sdkMessageToPayloads({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'thinking' }],
      usage: { input_tokens: 10, output_tokens: 4 },
    },
  }, CTX);

  assert.equal(out.length, 1);
  assert.equal(out[0].hook_event_name, '__meta');
  assert.equal(out[0].model, 'claude-opus-4-8');
  // __-prefixed events are metadata-only: they must not render as visible events.
  assert.ok(out[0].hook_event_name.startsWith('__'));
});

test('result becomes Stop; a non-success result also raises a Notification', () => {
  const ok = sdkMessageToPayloads({ type: 'result', subtype: 'success' }, CTX);
  assert.deepEqual(ok.map((p) => p.hook_event_name), ['Stop']);

  const bad = sdkMessageToPayloads({ type: 'result', subtype: 'error_max_turns' }, CTX);
  assert.deepEqual(bad.map((p) => p.hook_event_name), ['Stop', 'Notification']);
  assert.match(bad[1].message, /error_max_turns/);
});

test('ctx overrides the message session id, and label/cwd propagate', () => {
  const [p] = sdkMessageToPayloads(
    { type: 'system', subtype: 'init', session_id: 'ignored' },
    { session_id: 'wins', cwd: '/c', label: 'My App' });
  assert.equal(p.session_id, 'wins');
  assert.equal(p.label, 'My App');
});

test('forgetSdkSession clears pending tool-name state', () => {
  sdkMessageToPayloads({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_f', name: 'Write', input: {} }] },
  }, CTX);
  forgetSdkSession('sdk-test');
  const [post] = sdkMessageToPayloads({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_f', content: 'x' }] },
  }, CTX);
  assert.equal(post.tool_name, 'tool', 'state was forgotten, so the name falls back');
});
