// Analysis unit tests — the layer that turns an observation into a judgement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../server/sessions.js';
import {
  detectStalls, detectLoops, slowestCalls, healthScore, grade,
  buildReportCard, reportCardMarkdown, STALL_MS,
  effortByAgent, estimateCost, loadPricing,
} from '../server/analysis.js';

// Build a session by feeding real hook payloads through the real pipeline.
function makeSession(payloads, id = 's1') {
  const m = new SessionManager();
  m.ingest({ hook_event_name: 'SessionStart', session_id: id, cwd: '/repo/demo' });
  for (const p of payloads) m.ingest({ session_id: id, ...p });
  return m.get(id);
}

const tool = (name, id, input) => ({ hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: id, tool_input: input });
const done = (name, id, extra = {}) => ({ hook_event_name: 'PostToolUse', tool_name: name, tool_use_id: id, tool_response: { output: 'ok' }, ...extra });

test('a healthy run scores 100 and grades healthy', () => {
  const s = makeSession([
    tool('Read', 't1', { file_path: '/a.js' }), done('Read', 't1'),
    tool('Bash', 't2', { command: 'npm test' }), done('Bash', 't2'),
  ]);
  const h = healthScore(s);
  assert.equal(h.score, 100);
  assert.deepEqual(h.reasons, []);
  assert.equal(grade(h.score), 'healthy');
});

test('errors reduce the score and are named in the reasons', () => {
  const s = makeSession([
    tool('Bash', 't1', { command: 'npm test' }),
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_response: { output: 'boom', is_error: true } },
  ]);
  const h = healthScore(s);
  assert.ok(h.score < 100, `expected a deduction, got ${h.score}`);
  assert.ok(h.reasons.some((r) => /error/.test(r.label)), JSON.stringify(h.reasons));
});

test('detectLoops catches an identical call repeated, and ignores varied calls', () => {
  const same = { command: 'npm run build' };
  const looping = makeSession([
    tool('Bash', 'a1', same), done('Bash', 'a1'),
    tool('Bash', 'a2', same), done('Bash', 'a2'),
    tool('Bash', 'a3', same), done('Bash', 'a3'),
    tool('Bash', 'a4', same), done('Bash', 'a4'),
  ]);
  const loops = detectLoops(looping);
  assert.ok(loops.length >= 1, 'expected a loop to be detected');
  assert.equal(loops[0].tool, 'Bash');
  assert.ok(loops[0].count >= 3, `expected >=3 occurrences, got ${loops[0].count}`);

  const varied = makeSession([
    tool('Bash', 'b1', { command: 'ls' }), done('Bash', 'b1'),
    tool('Bash', 'b2', { command: 'pwd' }), done('Bash', 'b2'),
    tool('Bash', 'b3', { command: 'whoami' }), done('Bash', 'b3'),
  ]);
  assert.deepEqual(detectLoops(varied), [], 'distinct commands are not a loop');
});

test('detectStalls: quiet + an agent still active = stalled', () => {
  const s = makeSession([tool('Bash', 't1', { command: 'sleep 900' })]); // never returns
  const now = Date.now() + STALL_MS + 1000;

  const stall = detectStalls(s, now);
  assert.equal(stall.stalled, true);
  assert.ok(stall.silentMs >= STALL_MS);
  assert.ok(stall.agents.length > 0, 'expected the silent agent to be listed');
});

test('detectStalls: a recently-active run is not stalled', () => {
  const s = makeSession([tool('Bash', 't1', { command: 'x' })]);
  assert.equal(detectStalls(s, Date.now()).stalled, false);
});

test('detectStalls: an ended session is finished, not stuck', () => {
  const s = makeSession([
    tool('Bash', 't1', { command: 'x' }), done('Bash', 't1'),
    { hook_event_name: 'SessionEnd' },
  ]);
  const stall = detectStalls(s, Date.now() + STALL_MS * 10);
  assert.equal(stall.stalled, false, 'an ended session must never report as stalled');
});

test('slowestCalls ranks completed calls by duration', () => {
  const s = makeSession([]);
  // Durations come from Pre→Post pairing, so inject events with known timings.
  s.events.push(
    { type: 'tool_result', tool: 'Fast', agentName: 'a', durationMs: 100, ts: 1 },
    { type: 'tool_result', tool: 'Slow', agentName: 'a', durationMs: 9000, ts: 2 },
    { type: 'tool_result', tool: 'Mid', agentName: 'a', durationMs: 500, ts: 3 },
  );
  const slow = slowestCalls(s, 2);
  assert.deepEqual(slow.map((c) => c.tool), ['Slow', 'Mid']);
});

test('buildReportCard summarises the run and survives an empty session', () => {
  const s = makeSession([tool('Read', 't1', { file_path: '/a' }), done('Read', 't1')]);
  const card = buildReportCard(s);

  assert.equal(card.sessionId, 's1');
  assert.equal(card.label, 'demo');
  assert.equal(typeof card.health, 'number');
  assert.ok(['healthy', 'ok', 'degraded', 'unhealthy'].includes(card.grade));
  assert.ok(card.durationMs >= 0);
  assert.ok(Array.isArray(card.loops) && Array.isArray(card.slowest));

  const empty = buildReportCard(makeSession([], 'empty'));
  assert.equal(empty.tools, 0);
  assert.equal(empty.errors, 0);
});

test('reportCardMarkdown renders a pasteable report and flags trouble', () => {
  const s = makeSession([
    tool('Bash', 't1', { command: 'npm test' }),
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_response: { output: 'fail', is_error: true } },
  ]);
  const md = reportCardMarkdown(buildReportCard(s));

  assert.match(md, /^# demo — /m);
  assert.match(md, /\*\*Status\*\*/);
  assert.match(md, /Why the score is not 100/);
  assert.match(md, /error/i);
  assert.ok(!md.includes('undefined'), 'no undefined leaked into the markdown');
});

test('grade thresholds', () => {
  assert.equal(grade(100), 'healthy');
  assert.equal(grade(90), 'healthy');
  assert.equal(grade(75), 'ok');
  assert.equal(grade(50), 'degraded');
  assert.equal(grade(10), 'unhealthy');
});

test('session summary exposes a cheap stalled flag', () => {
  const s = makeSession([tool('Bash', 't1', { command: 'x' })]);
  assert.equal(s.summary().stalled, false, 'fresh session is not stalled');
});

test('effortByAgent attributes time and calls, ranked, with shares summing sanely', () => {
  const s = makeSession([]);
  s.events.push(
    { type: 'tool_use', agentId: 'a1', agentName: 'worker-a', agentType: 'subagent', ts: 1 },
    { type: 'tool_result', agentId: 'a1', agentName: 'worker-a', durationMs: 9000, ts: 2 },
    { type: 'tool_use', agentId: 'a2', agentName: 'worker-b', agentType: 'subagent', ts: 3 },
    { type: 'tool_result', agentId: 'a2', agentName: 'worker-b', durationMs: 1000, error: true, ts: 4 },
  );
  const effort = effortByAgent(s);

  assert.equal(effort[0].name, 'worker-a', 'slowest agent ranks first');
  assert.equal(effort[0].durationMs, 9000);
  assert.equal(effort[0].sharePct, 90);
  assert.equal(effort[1].errors, 1, 'errors are attributed to the right agent');
  assert.equal(effort.reduce((n, e) => n + e.sharePct, 0), 100);
});

test('effortByAgent is empty for a session with no activity', () => {
  assert.deepEqual(effortByAgent(makeSession([], 'quiet')).filter((e) => e.calls > 0), []);
});

test('pricing is opt-in: no env config means no invented cost', () => {
  assert.equal(loadPricing({}), null);
  assert.equal(estimateCost({ input: 1e6, output: 1e6 }, null), null,
    'without pricing we must report tokens, never a made-up number');
});

test('estimateCost computes from real token counts and values cache savings', () => {
  const pricing = loadPricing({ AGENTVIZ_PRICE_INPUT: '3', AGENTVIZ_PRICE_OUTPUT: '15', AGENTVIZ_PRICE_CACHE_READ: '0.3' });
  assert.deepEqual(pricing, { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 0 });

  const cost = estimateCost({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheCreation: 0 }, pricing);
  assert.equal(cost.breakdown.input, 3);
  assert.equal(cost.breakdown.output, 15);
  assert.ok(Math.abs(cost.breakdown.cacheRead - 0.3) < 1e-9);
  assert.ok(Math.abs(cost.total - 18.3) < 1e-9);
  // 1M cached tokens billed at 0.3 instead of 3 → saved 2.7
  assert.ok(Math.abs(cost.savedByCache - 2.7) < 1e-9);
  assert.equal(cost.estimated, true, 'must be labelled an estimate');
});

test('report card includes effort, and omits cost when pricing is unset', () => {
  const s = makeSession([tool('Read', 't1', { file_path: '/a' }), done('Read', 't1')]);
  const card = buildReportCard(s);
  assert.ok(Array.isArray(card.effort));
  assert.equal(card.cost, null, 'no pricing configured → no cost claimed');
  assert.ok(!reportCardMarkdown(card).includes('**Cost**'));
});
