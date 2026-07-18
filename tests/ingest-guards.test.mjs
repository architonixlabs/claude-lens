// Ingest guard tests — payload validation and the rate limiter.
//
// The limiter exempts loopback by default (local bursts are legitimate), so we
// set AGENTVIZ_RATE_ALL=1 here to exercise the path that protects an exposed
// instance. tests/auth.test.mjs covers the token gate.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AGENTVIZ_NO_PERSIST = '1';
process.env.AGENTVIZ_RATE_ALL = '1';
process.env.AGENTVIZ_RATE_MAX = '5';
delete process.env.AGENTVIZ_TOKEN;

const { createServer } = await import(`../server/index.js?guards=${Date.now()}`);

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

test('rejects malformed payloads with 400, not a silent no-op', async (t) => {
  const { server, close } = createServer({ demo: false });
  const port = await listen(server);
  t.after(() => close());
  const post = (body) => fetch(`http://127.0.0.1:${port}/ingest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });

  assert.equal((await post(JSON.stringify(['not', 'an', 'object']))).status, 400);
  assert.equal((await post(JSON.stringify('a string'))).status, 400);
  assert.equal((await post(JSON.stringify({ hook_event_name: 42 }))).status, 400);
  assert.equal((await post(JSON.stringify({ hook_event_name: 'X', session_id: { o: 1 } }))).status, 400);
  assert.equal((await post('{not json at all')).status, 400); // error middleware

  // a well-formed payload still succeeds
  assert.equal((await post(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'ok' }))).status, 200);
});

test('rate limits an exposed instance and reports retry-after', async (t) => {
  const { server, close } = createServer({ demo: false });
  const port = await listen(server);
  t.after(() => close());

  const hit = () => fetch(`http://127.0.0.1:${port}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'rl' }),
  });

  const codes = [];
  for (let i = 0; i < 9; i++) codes.push((await hit()).status); // limit is 5

  assert.equal(codes.filter((c) => c === 200).length, 5, `expected 5 accepted, got ${codes}`);
  assert.ok(codes.includes(429), 'excess requests must be rejected');

  const limited = await hit();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 0, 'retry-after should be set');
});
