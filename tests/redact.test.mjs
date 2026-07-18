// Redaction unit tests — credentials must never reach data/ or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactString, redactPayload } from '../server/redact.js';

// Synthetic, non-functional values that only mimic real key shapes.
const FAKE = {
  anthropic: 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF',
  github: 'ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  arx: 'arx_sk_AAAABBBBCCCCDDDDEEEE',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
};

test('masks vendor-prefixed keys but keeps a readable prefix', () => {
  for (const [name, secret] of Object.entries(FAKE)) {
    const out = redactString(`the key is ${secret} ok`);
    assert.ok(!out.includes(secret), `${name} leaked: ${out}`);
    assert.match(out, /«redacted»/);
  }
});

test('masks KEY=VALUE assignments by key name, keeping the name visible', () => {
  const out = redactString('export SONAR_TOKEN=abcd1234efgh5678 && echo done');
  assert.ok(!out.includes('abcd1234efgh5678'));
  assert.match(out, /SONAR_TOKEN=«redacted»/);
  assert.match(out, /echo done/); // surrounding command stays readable
});

test('masks bearer tokens and inline URL credentials', () => {
  const bearer = redactString('Authorization: Bearer abcdefghijklmnop123456');
  assert.ok(!bearer.includes('abcdefghijklmnop123456'));

  const url = redactString('psql postgres://appuser:hunter2secret@db:5432/app');
  assert.ok(!url.includes('hunter2secret'));
  assert.match(url, /postgres:\/\/appuser:«redacted»@db/); // host/user still useful
});

test('leaves ordinary text and short strings untouched', () => {
  const plain = 'npm run test -- --grep "session"';
  assert.equal(redactString(plain), plain);
  assert.equal(redactString('ok'), 'ok');
  assert.equal(redactString(42), 42);
});

test('walks nested payloads (arrays, objects) and preserves shape', () => {
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_input: { command: `curl -H "x-api-key: ${FAKE.anthropic}" https://api.example.com` },
    nested: [{ deep: { env: `AWS_SECRET_ACCESS_KEY=${FAKE.aws}` } }],
    count: 3,
    flag: true,
    nothing: null,
  };
  const out = redactPayload(payload);

  assert.ok(!JSON.stringify(out).includes(FAKE.anthropic));
  assert.ok(!JSON.stringify(out).includes(FAKE.aws));
  // shape and non-string values survive intact
  assert.equal(out.hook_event_name, 'PreToolUse');
  assert.equal(out.count, 3);
  assert.equal(out.flag, true);
  assert.equal(out.nothing, null);
  assert.equal(Array.isArray(out.nested), true);
  assert.match(out.tool_input.command, /api\.example\.com/);
});

test('does not mutate the caller’s object', () => {
  const original = { cmd: `token=${FAKE.github}` };
  const copy = JSON.parse(JSON.stringify(original));
  redactPayload(original);
  assert.deepEqual(original, copy);
});
