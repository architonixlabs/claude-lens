#!/usr/bin/env node
// claude-hook.mjs — Claude Code hook bridge.
//
// Claude Code invokes this on hook events and pipes the event JSON on stdin.
// We forward it to the Agent Constellation server's /ingest endpoint. It is
// deliberately fire-and-forget with a short timeout: the visualizer must NEVER
// slow down or block a real Claude session, and must never fail the hook.
//
// Wire it up in .claude/settings.json — see hooks/settings.snippet.json.
//
// Target (first match wins):
//   --url=<full ingest URL>  arg   |  AGENTVIZ_URL   env
//   --port=<port>            arg   |  AGENTVIZ_PORT   env   (default 4317)

const argFlag = (name) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};

const PORT = argFlag('port') || process.env.AGENTVIZ_PORT || '4317';
const URL = argFlag('url') || process.env.AGENTVIZ_URL || `http://127.0.0.1:${PORT}/ingest`;
const TOKEN = argFlag('token') || process.env.AGENTVIZ_TOKEN || '';
const TIMEOUT_MS = 400;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  let payload;
  try {
    const raw = await readStdin();
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  // If Claude passes the event name as a (non-flag) arg, honor it as a fallback.
  if (!payload.hook_event_name) {
    const named = process.argv.slice(2).find((a) => !a.startsWith('--'));
    if (named) payload.hook_event_name = named;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    await fetch(URL, {
      method: 'POST',
      headers: TOKEN
        ? { 'content-type': 'application/json', 'x-agentviz-token': TOKEN }
        : { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch {
    // Server not running / slow — that's fine, just move on.
  } finally {
    clearTimeout(t);
  }
  // Always succeed so we never interfere with the session.
  process.exit(0);
}

main();
