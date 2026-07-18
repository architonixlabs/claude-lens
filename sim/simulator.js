// simulator.js — drives scenarios into a SessionManager (in-process demo) or a
// running server (over HTTP). Each demo session loops its own scenario, stamped
// with its own session_id + cwd, so the app shows several concurrent sessions.

import { SCENARIO, DEMO_SESSIONS } from './scenario.js';

// Stamp a scenario payload with session identity, model, growing token usage,
// and a timestamp — so demo sessions show model + tokens like real ones do.
function stamp(payload, cfg, i) {
  const p = { ...payload, session_id: cfg.id, __ts: Date.now() };
  if (cfg.cwd && p.hook_event_name === 'SessionStart' && !p.cwd) p.cwd = cfg.cwd;
  if (cfg.model) p.model = cfg.model;
  p.usage = {
    input: 8000 + i * 1500,
    output: i * 420,
    cacheRead: i * 3200,
    cacheCreation: i ? 1400 : 0,
  };
  return p;
}

// Loop a single scenario into `manager` for one session. Returns a stop fn.
function driveSession(manager, cfg) {
  const { id, scenario, speed = 1, startDelay = 0 } = cfg;
  let i = 0;
  let stopped = false;
  let timer = null;

  const step = () => {
    if (stopped) return;
    if (i >= scenario.length) {
      // clean loop: reset this session and replay after a beat
      i = 0;
      manager.resetSession(id);
      timer = setTimeout(step, 2000 / speed);
      return;
    }
    const s = scenario[i];
    manager.ingest(stamp(s.payload, cfg, i));
    i++;
    const nextDelay = ((scenario[i] && scenario[i].after) || 800) / speed;
    timer = setTimeout(step, nextDelay);
  };

  timer = setTimeout(step, startDelay + (scenario[0].after || 0) / speed);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

// Drive the full demo roster. Returns a stop fn that halts every session.
export function driveDemo(manager, { speed = 1 } = {}) {
  const stops = DEMO_SESSIONS.map((cfg) =>
    driveSession(manager, { ...cfg, speed: (cfg.speed || 1) * speed }));
  return () => stops.forEach((fn) => fn());
}

// Drive a running server over HTTP as a single session (used by `npm run sim`).
async function driveHttp(url, { speed = 1, sessionId = 'sim-http', cwd = '/repo/sim' } = {}) {
  for (let i = 0; i < SCENARIO.length; i++) {
    const s = SCENARIO[i];
    await new Promise((r) => setTimeout(r, (s.after || 0) / speed));
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...s.payload, session_id: sessionId, ...(s.payload.hook_event_name === 'SessionStart' ? { cwd } : {}) }),
      });
      process.stdout.write(`→ ${s.payload.hook_event_name}${s.payload.tool_name ? ' ' + s.payload.tool_name : ''}\n`);
    } catch (err) {
      console.error('POST failed (is the server running?):', err.message);
      return;
    }
  }
}

// CLI entry: `node sim/simulator.js [port] [speed]`
if (process.argv[1] && process.argv[1].endsWith('simulator.js')) {
  const port = process.argv[2] || process.env.PORT || 4317;
  const speed = Number(process.argv[3] || 1);
  const url = `http://127.0.0.1:${port}/ingest`;
  console.log(`Replaying scenario into ${url} (speed ${speed}x)…`);
  driveHttp(url, { speed }).then(() => console.log('Scenario complete.'));
}
