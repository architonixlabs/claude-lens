#!/usr/bin/env node
// run-unit-tests.mjs — run the node:test suites, portably.
//
// `node --test tests/*.test.mjs` relies on the shell to expand the glob. That
// works in bash but not in cmd.exe, which is what npm uses on Windows — the
// pattern arrives literally and the run fails. Node's own glob support needs
// v22+, and passing the directory makes Node try to load it as a module.
//
// So: resolve the file list here and hand explicit paths to the test runner.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = path.join(__dirname, '..', 'tests');

const files = fs.readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith('.test.mjs'))       // Playwright's *.spec.js is not ours
  .sort()
  .map((f) => path.join(TESTS_DIR, f));

if (!files.length) {
  console.error(`No *.test.mjs files found in ${TESTS_DIR}`);
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...files, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
