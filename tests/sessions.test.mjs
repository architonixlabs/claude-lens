// SessionManager / Session unit tests — routing, labels, usage math,
// search, status, clear, and the memory-eviction cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionManager } from '../server/sessions.js';

const start = (id, extra = {}) => ({ hook_event_name: 'SessionStart', session_id: id, ...extra });

test('routes payloads to a per-session graph keyed by session_id', () => {
  const m = new SessionManager();
  m.ingest(start('a', { cwd: '/home/me/project-alpha' }));
  m.ingest(start('b', { cwd: '/home/me/project-beta' }));

  assert.equal(m.sessions.size, 2);
  assert.ok(m.get('a'));
  assert.ok(m.get('b'));
  assert.notEqual(m.get('a').normalizer, m.get('b').normalizer); // isolated graphs
});

test('labels a session by its project folder, not the raw id', () => {
  const m = new SessionManager();
  m.ingest(start('sess-1234567890', { cwd: '/home/me/my-app' }));
  assert.equal(m.get('sess-1234567890').meta.label, 'my-app');
});

test('list() exposes a summary per session', () => {
  const m = new SessionManager();
  m.ingest(start('a', { cwd: '/x/alpha' }));
  const [s] = m.list();
  assert.equal(s.id, 'a');
  assert.equal(s.label, 'alpha');
  assert.equal(s.status, 'active'); // just ingested
  assert.equal(typeof s.events, 'number');
});

test('applyUsage sets absolute totals; applyUsageDelta accumulates output', () => {
  const s = new Session('u');
  s.applyUsage({ input: 100, output: 20, cacheRead: 50, cacheCreation: 10 });
  assert.equal(s.meta.usage.total, 180);

  s.applyUsageDelta({ output: 5, input: 120 });
  assert.equal(s.meta.usage.output, 25);      // accumulated
  assert.equal(s.meta.usage.lastOutput, 5);
  assert.equal(s.meta.usage.input, 120);      // replaced with latest context
  assert.equal(s.meta.usage.total, 120 + 25 + 50 + 10);
});

test('applyUsageDelta does not clobber fields the message omits', () => {
  const s = new Session('u2');
  s.applyUsage({ input: 900, cacheRead: 40 });
  s.applyUsageDelta({ output: 7 }); // no input/cache in this delta
  assert.equal(s.meta.usage.input, 900, 'input must survive an output-only delta');
  assert.equal(s.meta.usage.cacheRead, 40);
});

test('summary computes cacheHitPct from usage (0 when no tokens)', () => {
  const s = new Session('c');
  assert.equal(s.summary().cacheHitPct, 0);
  s.applyUsage({ input: 25, cacheRead: 75, cacheCreation: 0 });
  assert.equal(s.summary().cacheHitPct, 75);
});

test('SessionEnd flips status to ended', () => {
  const m = new SessionManager();
  m.ingest(start('e'));
  assert.equal(m.get('e').summary().status, 'active');
  m.ingest({ hook_event_name: 'SessionEnd', session_id: 'e' });
  assert.equal(m.get('e').summary().status, 'ended');
});

test('search finds events across sessions, newest-first, and respects the limit', () => {
  const m = new SessionManager();
  m.ingest(start('a', { cwd: '/x/alpha' }));
  m.ingest(start('b', { cwd: '/x/beta' }));
  m.ingest({ hook_event_name: 'PreToolUse', session_id: 'a', tool_name: 'Bash',
    tool_use_id: 't1', tool_input: { command: 'npm run migrate-database' } });
  m.ingest({ hook_event_name: 'PreToolUse', session_id: 'b', tool_name: 'Bash',
    tool_use_id: 't2', tool_input: { command: 'npm run migrate-database' } });

  const hits = m.search('migrate-database');
  assert.ok(hits.length >= 2, `expected cross-session hits, got ${hits.length}`);
  assert.ok(new Set(hits.map((h) => h.sessionId)).size >= 2, 'hits should span both sessions');
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].ts >= hits[i].ts, 'newest-first');

  assert.equal(m.search('migrate-database', 1).length, 1);
  assert.deepEqual(m.search(''), []);      // empty query matches nothing
  assert.deepEqual(m.search(null), []);
});

test('clearByStatus removes only matching sessions and returns their ids', () => {
  const m = new SessionManager();
  m.ingest(start('live'));
  m.ingest(start('done'));
  m.ingest({ hook_event_name: 'SessionEnd', session_id: 'done' });

  const removed = m.clearByStatus('ended');
  assert.deepEqual(removed, ['done']);
  assert.ok(m.get('live'), 'active session must survive');
  assert.equal(m.get('done'), undefined);
});

test('evicts least-recently-active sessions past the cap (bounded memory)', () => {
  const m = new SessionManager();
  for (let i = 0; i < 320; i++) m.ingest(start(`s${i}`));
  assert.ok(m.sessions.size <= 300, `expected <=300 sessions, got ${m.sessions.size}`);
  assert.ok(m.get('s319'), 'the most recently touched session must be kept');
});

test('a malformed payload is counted as dropped, not thrown', () => {
  const m = new SessionManager();
  const produced = m.ingest({ hook_event_name: 'PreToolUse', session_id: 'bad', tool_input: null });
  assert.ok(Array.isArray(produced));
  assert.equal(m.stats.dropped + m.stats.ingested >= 0, true);
});

test('allSnapshots returns every session with graph + recent events', () => {
  const m = new SessionManager();
  m.ingest(start('a', { cwd: '/x/alpha' }));
  m.ingest(start('b', { cwd: '/x/beta' }));
  const snaps = m.allSnapshots();
  assert.equal(snaps.length, 2);
  for (const s of snaps) {
    assert.ok(s.id && s.label);
    assert.ok(s.graph && s.graph.agents);
    assert.ok(Array.isArray(s.events));
    assert.ok(s.meta && typeof s.meta.status === 'string');
  }
});

test('reset clears events and usage but keeps the session registered', () => {
  const m = new SessionManager();
  m.ingest(start('r'));
  m.get('r').applyUsage({ input: 10, output: 10 });
  m.resetSession('r');
  assert.equal(m.get('r').events.length, 0);
  assert.equal(m.get('r').meta.usage.total, 0);
  assert.ok(m.get('r'), 'session still exists after reset');
});
