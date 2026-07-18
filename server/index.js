#!/usr/bin/env node
// index.js — ClaudeLens server (multi-session).
//   • serves the read-only 3D web UI (public/)
//   • POST /ingest  ← Claude Code hooks (or the simulator) push raw hook payloads.
//                     Events are routed to a per-session graph keyed by session_id.
//   • WS   /ws      → pushes the session list to every client; a client subscribes
//                     to one session and receives that session's snapshot + updates.
//
// Config via env OR CLI flags (flags win) so npm scripts work on Windows too:
//   --port=N / PORT           (default 4317)
//   --demo   / AGENTVIZ_DEMO  run several concurrent simulated sessions on a loop
//   --speed=N / AGENTVIZ_SPEED demo playback multiplier (default 1)

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { SessionManager } from './sessions.js';
import { sdkMessageToPayloads } from './sdk.js';
import * as persist from './persist.js';
import { driveDemo } from '../sim/simulator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const ARGV = process.argv.slice(2);
const hasFlag = (f) => ARGV.includes(f);
const flagVal = (name, dflt) => {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};

const PORT = Number(flagVal('port', process.env.PORT || 4317));
const DEMO = hasFlag('--demo') || process.env.AGENTVIZ_DEMO === '1' || process.env.AGENTVIZ_DEMO === 'true';
const SPEED = Number(flagVal('speed', process.env.AGENTVIZ_SPEED || 1));

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }
}

export function createServer({ demo = DEMO, demoSpeed = SPEED } = {}) {
  const startedAt = Date.now();
  const manager = new SessionManager();
  // durable history survives restarts (disabled for the ephemeral demo)
  persist.setEnabled(!demo);
  if (!demo) persist.loadAll(manager).then((n) => { if (n) console.log(`  Loaded ${n} saved session(s) from history.`); });

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // ingest: hooks + simulator post raw Claude Code hook payloads here
  app.post('/ingest', (req, res) => {
    const body = req.body || {};
    const produced = manager.ingest(body);
    persist.record(body);
    // quiet by default: log only new sessions + errors (verbose logs everything)
    const verbose = process.env.AGENTVIZ_VERBOSE === '1';
    const notable = body.hook_event_name === 'SessionStart' || produced.some((e) => e.error);
    if (!demo && (verbose || notable)) {
      const sid = String(body.session_id || body.sessionId || 'default').slice(0, 8);
      console.log(`↳ ${body.hook_event_name || '?'}${body.tool_name ? ' ' + body.tool_name : ''}  [${sid}]  → ${produced.length} event(s)`);
    }
    res.json({ ok: true, produced: produced.length });
  });

  // SDK apps POST their Claude Agent SDK stream messages here (one per message, or
  // an array). We translate them into hook payloads and run the same pipeline.
  app.post('/ingest/sdk', (req, res) => {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [body.message];
    const ctx = { session_id: body.session_id, cwd: body.cwd, label: body.label };
    let produced = 0;
    for (const message of messages) {
      if (!message) continue;
      for (const payload of sdkMessageToPayloads(message, ctx)) {
        produced += manager.ingest(payload).length;
        persist.record(payload);
      }
    }
    res.json({ ok: true, produced });
  });

  app.get('/api/sessions', (_req, res) => res.json({ sessions: manager.list() }));

  // every session's graph — powers the combined "all on one canvas" view (also an
  // HTTP fallback so the combined view populates instantly / without WS support).
  app.get('/api/all', (_req, res) => res.json({ sessions: manager.allSnapshots() }));

  // Download a session (or ?all=1 for everything) as JSON — for sharing/archiving.
  app.get('/api/export', (req, res) => {
    if (req.query.all === '1' || req.query.all === 'true') {
      res.setHeader('content-disposition', 'attachment; filename="sessions-all.json"');
      return res.json({ exportedAt: new Date().toISOString(), sessions: manager.allSnapshots() });
    }
    const id = req.query.session ? String(req.query.session) : manager.list()[0]?.id;
    const s = id && manager.get(id);
    if (!s) return res.status(404).json({ ok: false, error: 'session not found' });
    res.setHeader('content-disposition', `attachment; filename="session-${String(id).slice(0, 40)}.json"`);
    res.json({ exportedAt: new Date().toISOString(), ...s.snapshot() });
  });

  // Clear all sessions in a given status (only 'idle' or 'ended' — never active).
  app.post('/api/sessions/clear', (req, res) => {
    const status = (req.body && req.body.status) || '';
    if (status !== 'idle' && status !== 'ended') {
      return res.status(400).json({ ok: false, error: "status must be 'idle' or 'ended'" });
    }
    const removed = manager.clearByStatus(status);
    removed.forEach((id) => persist.remove(id)); // also drop it from disk history
    res.json({ ok: true, removed: removed.length });
  });

  // cross-session full-text search over recorded events
  app.get('/api/search', (req, res) => {
    const results = manager.search(req.query.q, Number(req.query.limit) || 50);
    res.json({ q: String(req.query.q || ''), count: results.length, results });
  });

  app.get('/api/health', (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
      ok: true, demo,
      sessions: manager.sessions.size,
      stats: manager.stats,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      memoryMB: Math.round(mem.rss / 1048576),
      heapMB: Math.round(mem.heapUsed / 1048576),
    });
  });

  app.get('/api/snapshot', (req, res) => {
    const id = req.query.session;
    const s = id ? manager.get(String(id)) : manager.get(manager.list()[0]?.id);
    if (!s) return res.json({ type: 'snapshot', sessionId: null, graph: { agents: {}, edges: [] }, events: [] });
    res.json(s.snapshot());
  });

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    let subscribedId = null;
    let subscribeAll = false; // combined "all sessions on one canvas" mode
    send(ws, { type: 'sessions', sessions: manager.list() });

    const unsub = manager.subscribe((msg) => {
      const forward = msg.type === 'sessions'
        || (msg.type === 'update' && (subscribeAll || msg.sessionId === subscribedId));
      if (forward) send(ws, msg);
    });

    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (!m || typeof m.type !== 'string') return;
      if (m.type === 'subscribe' && typeof m.sessionId === 'string') {
        subscribeAll = false;
        subscribedId = m.sessionId;
        const s = manager.get(subscribedId);
        if (s) send(ws, s.snapshot());
      } else if (m.type === 'subscribeAll') {
        subscribeAll = true;
        subscribedId = null;
        send(ws, { type: 'allSnapshot', sessions: manager.allSnapshots() });
      }
    });
    ws.on('close', unsub);
    ws.on('error', unsub);
  });

  let stopDemo = null;
  if (demo) stopDemo = driveDemo(manager, { speed: demoSpeed });

  const close = () => new Promise((resolve) => {
    if (stopDemo) stopDemo();
    wss.close();
    server.close(() => resolve());
  });

  return { app, server, wss, manager, close };
}

// Direct launch
if (process.argv[1] && (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('server'))) {
  // Bind to loopback by default — session data (prompts, file paths, commands) is
  // sensitive and /ingest is an unauthenticated write. Set HOST=0.0.0.0 to expose
  // it deliberately (e.g. viewing from another machine).
  const HOST = flagVal('host', process.env.AGENTVIZ_HOST || process.env.HOST || '127.0.0.1');
  const { server, close } = createServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`  Port ${PORT} already in use — another ClaudeLens is running. Exiting.`);
      process.exit(0);
    }
    throw err;
  });
  server.listen(PORT, HOST, () => {
    const mode = DEMO ? `DEMO (${SPEED}x, multi-session loop)` : 'LIVE (awaiting hooks)';
    const shown = HOST === '0.0.0.0' ? `${HOST}:${PORT}` : `localhost:${PORT}`;
    console.log(`\n  ClaudeLens → http://${shown}  [${mode}]`);
    if (HOST === '0.0.0.0') console.log('  ⚠ bound to ALL interfaces — session data is reachable on your network.');
    console.log(`  Ingest endpoint     → POST http://${shown}/ingest`);
    console.log(`  WebSocket           → ws://${shown}/ws\n`);
  });
  // graceful shutdown — flush + close cleanly on Ctrl+C / kill
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
  }
}
