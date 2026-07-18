// Security unit tests — transcript_path allowlist (arbitrary-file-read guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { isAllowed } from '../server/transcript.js';

const claudeTx = path.join(os.homedir(), '.claude', 'projects', 'proj', 'abc.jsonl');

test('allows a real Claude transcript path', () => {
  assert.equal(isAllowed(claudeTx), true);
});

test('rejects arbitrary files (path traversal / sensitive reads)', () => {
  assert.equal(isAllowed('/etc/passwd'), false);
  assert.equal(isAllowed('C:/Windows/System32/config/SAM'), false);
  assert.equal(isAllowed(path.join(os.homedir(), '.ssh', 'id_rsa')), false);
  assert.equal(isAllowed(path.join(os.homedir(), '.claude', '..', 'secret.jsonl')), false); // escapes root
});

test('rejects non-jsonl and empty', () => {
  assert.equal(isAllowed(path.join(os.homedir(), '.claude', 'x.txt')), false);
  assert.equal(isAllowed(''), false);
  assert.equal(isAllowed(null), false);
});
