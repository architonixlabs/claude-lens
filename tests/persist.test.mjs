// Persistence unit tests — history must survive a restart, and disk usage must
// stay bounded. Each test points AGENTVIZ_DATA at a throwaway directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-persist-'));
process.env.AGENTVIZ_DATA = DIR;
delete process.env.AGENTVIZ_NO_PERSIST;

const persist = await import('../server/persist.js');
const { SessionManager } = await import('../server/sessions.js');

const settle = () => new Promise((r) => setTimeout(r, 120));
const filesIn = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl'));

test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

test('records a session to disk and replays it into a fresh manager', async () => {
  persist.setEnabled(true);
  persist.record({ hook_event_name: 'SessionStart', session_id: 'round-trip', cwd: '/x/app' });
  persist.record({ hook_event_name: 'PreToolUse', session_id: 'round-trip',
    tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'echo hi' } });
  await settle();

  assert.ok(filesIn().includes('round-trip.jsonl'), `expected round-trip.jsonl in ${filesIn()}`);

  // A brand-new manager (simulating a restart) rebuilds the same session.
  const restarted = new SessionManager();
  const loaded = await persist.loadAll(restarted);
  assert.ok(loaded >= 1);
  const s = restarted.get('round-trip');
  assert.ok(s, 'session must be reconstructed from disk');
  assert.equal(s.meta.label, 'app');
  assert.ok(s.events.length > 0, 'replayed events should rebuild history');
});

test('never persists the "default" fallback session', async () => {
  persist.setEnabled(true);
  persist.record({ hook_event_name: 'SessionStart', session_id: 'default' });
  await settle();
  assert.ok(!filesIn().includes('default.jsonl'));
});

test('does nothing while disabled (demo mode)', async () => {
  persist.setEnabled(false);
  persist.record({ hook_event_name: 'SessionStart', session_id: 'while-disabled' });
  await settle();
  assert.ok(!filesIn().includes('while-disabled.jsonl'));
  persist.setEnabled(true);
});

test('sanitises session ids into safe filenames (no path traversal)', async () => {
  persist.setEnabled(true);
  persist.record({ hook_event_name: 'SessionStart', session_id: '../../evil/../x' });
  persist.record({ hook_event_name: 'SessionStart', session_id: 'C:\\Windows\\evil' });
  await settle();

  // Nothing may be written outside the data dir...
  assert.ok(!fs.existsSync(path.join(DIR, '..', 'evil')));
  // ...because separators are stripped, so every file resolves back inside DIR.
  // (A "of" substring may survive — harmless without a separator to act on.)
  const root = path.resolve(DIR);
  for (const f of filesIn()) {
    assert.ok(!f.includes('/') && !f.includes('\\'), `separator survived in ${f}`);
    assert.ok(path.resolve(DIR, f).startsWith(root), `${f} escapes the data dir`);
  }
});

test('remove() deletes a session so it does not come back on restart', async () => {
  persist.setEnabled(true);
  persist.record({ hook_event_name: 'SessionStart', session_id: 'to-delete' });
  await settle();
  assert.ok(filesIn().includes('to-delete.jsonl'));

  persist.remove('to-delete');
  await settle();
  assert.ok(!filesIn().includes('to-delete.jsonl'));

  const m = new SessionManager();
  await persist.loadAll(m);
  assert.equal(m.get('to-delete'), undefined);
});

test('malformed lines are skipped, not fatal, on replay', async () => {
  fs.writeFileSync(path.join(DIR, 'corrupt.jsonl'),
    '{"hook_event_name":"SessionStart","session_id":"corrupt","cwd":"/x/ok"}\n'
    + 'this is not json\n'
    + '{"broken":\n');

  const m = new SessionManager();
  await persist.loadAll(m); // must not throw
  assert.ok(m.get('corrupt'), 'the valid line should still load');
});

test('loadAll on a missing data dir returns 0 rather than throwing', async () => {
  const gone = path.join(os.tmpdir(), 'clx-persist-does-not-exist-' + Date.now());
  const prev = process.env.AGENTVIZ_DATA;
  process.env.AGENTVIZ_DATA = gone;
  const fresh = await import(`../server/persist.js?nodir=${Date.now()}`);
  assert.equal(await fresh.loadAll(new SessionManager()), 0);
  process.env.AGENTVIZ_DATA = prev;
});
