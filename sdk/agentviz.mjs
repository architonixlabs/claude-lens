// agentviz.mjs — drop this into your Claude Agent SDK app to stream its sessions
// into the ClaudeLens visualizer. Zero deps, fire-and-forget (never
// throws, never blocks your app), works with @anthropic-ai/claude-agent-sdk
// (TypeScript/Node) — or any code that yields SDK stream messages.
//
// Usage (wrap your existing query() loop with .tap):
//
//   import { query } from '@anthropic-ai/claude-agent-sdk';
//   import { AgentViz } from './agentviz.mjs';
//
//   const viz = new AgentViz({ label: 'my-web-app', cwd: process.cwd() });
//   for await (const msg of viz.tap(query({ prompt, options }))) {
//     // ...your normal message handling — unchanged...
//   }
//
// Or report messages one at a time from anywhere:
//   viz.report(message);
//
// Point it at a non-default server with { url: 'http://host:4317' } or the
// AGENTVIZ_URL env var.

export class AgentViz {
  constructor({ url, sessionId, label, cwd } = {}) {
    this.base = (url || (typeof process !== 'undefined' && process.env && process.env.AGENTVIZ_URL) || 'http://127.0.0.1:4317').replace(/\/$/, '');
    this.sessionId = sessionId || newId();
    this.label = label;
    this.cwd = cwd;
  }

  // Forward one SDK stream message (fire-and-forget). Returns a promise you can
  // ignore.
  report(message) {
    if (!message) return Promise.resolve();
    return post(`${this.base}/ingest/sdk`, {
      session_id: this.sessionId, cwd: this.cwd, label: this.label, message,
    });
  }

  // Wrap an async-iterable of SDK messages: forwards each to the visualizer and
  // re-yields it so your own loop is unchanged.
  async *tap(stream) {
    for await (const message of stream) {
      this.report(message); // do not await — never slow the app down
      yield message;
    }
  }
}

function newId() {
  try { if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* */ }
  return 'sdk-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

function post(url, body) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), 500) : null;
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl ? ctrl.signal : undefined,
  }).catch(() => {}).finally(() => { if (t) clearTimeout(t); });
}

export default AgentViz;
