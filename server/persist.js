// persist.js — durable, append-only session history so nothing is lost on a
// restart. Every ingested payload is appended to data/<session>.jsonl; on boot
// those files are replayed through the SAME ingest pipeline to rebuild the graphs
// and event history exactly. No database — just JSONL and the normalizer.
//
// Disabled for demo mode and for the 'default' fallback session. Override the
// directory with AGENTVIZ_DATA; disable entirely with AGENTVIZ_NO_PERSIST=1.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.AGENTVIZ_DATA || path.join(__dirname, '..', 'data');
const DISABLED = process.env.AGENTVIZ_NO_PERSIST === '1';
const MAX_FILES = 40;                    // replay at most the N most-recent sessions on boot
const MAX_BYTES = 8 * 1024 * 1024;       // skip pathologically huge session files on replay
const MAX_FILE_BYTES = 10 * 1024 * 1024; // stop growing a single session file past 10 MB
const MAX_DATA_FILES = 300;              // cap total session files on disk (evict oldest)

let enabled = !DISABLED;
const sizes = new Map();                 // sid -> approx bytes written (disk-DoS guard)

export function setEnabled(v) { enabled = v && !DISABLED; }

function safeName(sid) {
  return String(sid).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}
function fileFor(sid) { return path.join(DIR, safeName(sid) + '.jsonl'); }

function sessionId(payload) {
  return String((payload && (payload.session_id || payload.sessionId)) || 'default');
}

// Append one ingested payload (fire-and-forget; never throws).
export function record(payload) {
  if (!enabled || !payload) return;
  const sid = sessionId(payload);
  if (sid === 'default') return;
  const line = JSON.stringify({ ...payload, __ts: payload.__ts || Date.now() }) + '\n';
  appendCapped(sid, line).catch(() => {});
}

// Bounded append: stops a single session file past MAX_FILE_BYTES and caps the
// total number of session files (evicting the oldest) so disk can't run away.
async function appendCapped(sid, line) {
  await fs.promises.mkdir(DIR, { recursive: true });
  const file = fileFor(sid);
  let size = sizes.get(sid);
  if (size === undefined) {
    try { size = (await fs.promises.stat(file)).size; }
    catch { size = 0; await enforceFileCap(); } // brand-new file → check the file-count cap
  }
  if (size >= MAX_FILE_BYTES) { sizes.set(sid, size); return; } // this session is capped
  await fs.promises.appendFile(file, line);
  sizes.set(sid, size + Buffer.byteLength(line));
}

async function enforceFileCap() {
  let files;
  try { files = await fs.promises.readdir(DIR); } catch { return; }
  const jsonl = files.filter((f) => f.endsWith('.jsonl'));
  if (jsonl.length <= MAX_DATA_FILES) return;
  const stats = [];
  for (const f of jsonl) {
    try { stats.push({ f, m: (await fs.promises.stat(path.join(DIR, f))).mtimeMs }); } catch { /* */ }
  }
  stats.sort((a, b) => a.m - b.m);
  for (const { f } of stats.slice(0, jsonl.length - MAX_DATA_FILES)) {
    await fs.promises.rm(path.join(DIR, f), { force: true }).catch(() => {});
  }
}

// Delete a session's history (called when the user clears it, so it doesn't
// come back on the next restart).
export function remove(sid) {
  if (DISABLED) return;
  fs.promises.rm(fileFor(sid), { force: true }).catch(() => {});
}

// Replay persisted history into a fresh manager on startup.
export async function loadAll(manager) {
  if (DISABLED) return 0;
  let files;
  try { files = await fs.promises.readdir(DIR); }
  catch { return 0; } // no data dir yet
  const jsonl = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const stat = await fs.promises.stat(path.join(DIR, f));
      jsonl.push({ f, mtime: stat.mtimeMs, size: stat.size });
    } catch { /* ignore */ }
  }
  jsonl.sort((a, b) => b.mtime - a.mtime);
  let loaded = 0;
  for (const { f, size } of jsonl.slice(0, MAX_FILES)) {
    if (size > MAX_BYTES) continue;
    let text;
    try { text = await fs.promises.readFile(path.join(DIR, f), 'utf8'); }
    catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { manager.ingest(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    loaded++;
  }
  return loaded;
}
