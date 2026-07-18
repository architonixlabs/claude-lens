#!/usr/bin/env node
// ensure-server.mjs — make sure the Agent Constellation server is running.
//
// Wired into the SessionStart hook by install-hooks.mjs so the visualizer is
// always available: if the server isn't up, this starts it DETACHED (it outlives
// the Claude session and keeps capturing every session). If it's already up, this
// does nothing. Safe to run many times — it never starts a second instance.
//
//   AGENTVIZ_PORT / --port=N   port to check + bind (default 4317)

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server', 'index.js');

const portArg = process.argv.slice(2).find((a) => a.startsWith('--port='));
const PORT = portArg ? portArg.split('=')[1] : (process.env.AGENTVIZ_PORT || '4317');

function health(timeout = 600) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  if (await health()) process.exit(0); // already running

  try {
    const child = spawn(process.execPath, [SERVER, `--port=${PORT}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    process.exit(0); // never let this fail the hook
  }

  // Wait (briefly) until it answers, so the hooks that follow this SessionStart
  // land on a live server.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await health()) break;
  }
  process.exit(0);
}

main();
