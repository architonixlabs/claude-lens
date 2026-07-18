// Auth unit tests — when AGENTVIZ_TOKEN is set, write endpoints must require it,
// while read endpoints stay open. Boots a real server on an ephemeral port.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AGENTVIZ_TOKEN = 'sekret';
process.env.AGENTVIZ_NO_PERSIST = '1'; // don't touch disk during the test
const { createServer } = await import('../server/index.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('token gate protects writes, leaves reads open', async (t) => {
  const { server, close } = createServer({ demo: false });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  t.after(() => close());

  const post = (path, headers) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'auth-test' }),
  });

  // no token → 401 on writes
  assert.equal((await post('/ingest')).status, 401);
  assert.equal((await post('/ingest/sdk')).status, 401);

  // wrong token → 401
  assert.equal((await post('/ingest', { 'x-agentviz-token': 'nope' })).status, 401);

  // correct token (header) → accepted
  assert.equal((await post('/ingest', { 'x-agentviz-token': 'sekret' })).status, 200);
  // correct token (Bearer) → accepted
  assert.equal((await post('/ingest', { authorization: 'Bearer sekret' })).status, 200);

  // reads never require a token
  assert.equal((await fetch(base + '/api/sessions')).status, 200);
  assert.equal((await fetch(base + '/api/health')).status, 200);
});
