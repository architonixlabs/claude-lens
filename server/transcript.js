// transcript.js — incrementally read a Claude Code session transcript (JSONL) to
// extract the current model and cumulative token usage. Only the bytes appended
// since the last read are parsed, so this stays cheap even for long sessions.

import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';

const MAX_FIRST_READ = 50 * 1024 * 1024; // safety cap for the initial read (50 MB)

// Only ever read real Claude transcripts. A hook payload is attacker-controllable,
// so an unchecked `transcript_path` would be an arbitrary-file-read. Allow only
// *.jsonl under ~/.claude (extend via AGENTVIZ_TRANSCRIPT_DIRS, os-path separated).
const ALLOWED_ROOTS = [nodePath.join(os.homedir(), '.claude')]
  .concat((process.env.AGENTVIZ_TRANSCRIPT_DIRS || '').split(nodePath.delimiter).filter(Boolean))
  .map((p) => nodePath.resolve(p));

export function isAllowed(p) {
  if (!p || !p.toLowerCase().endsWith('.jsonl')) return false;
  const abs = nodePath.resolve(p);
  return ALLOWED_ROOTS.some((root) => abs === root || abs.startsWith(root + nodePath.sep));
}

export async function readUsage(session) {
  const path = session._transcriptPath;
  if (!path || !isAllowed(path)) return false;

  let stat;
  try { stat = await fs.stat(path); } catch { return false; }
  if (stat.size <= session._offset) return false;

  // On the very first read, don't scan more than the cap from the end.
  if (session._offset === 0 && stat.size > MAX_FIRST_READ) {
    session._offset = stat.size - MAX_FIRST_READ;
    session._tail = ''; // may drop a partial first line — acceptable
  }

  const start = session._offset;
  const length = stat.size - start;
  let changed = false;

  let fh;
  try {
    fh = await fs.open(path, 'r');
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    session._offset = stat.size;

    const text = (session._tail || '') + buf.toString('utf8');
    const lines = text.split('\n');
    session._tail = lines.pop() || ''; // keep the trailing partial line

    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const msg = obj.message || obj;
      const isAssistant = obj.type === 'assistant' || msg.role === 'assistant';
      if (isAssistant && msg.usage) {
        const u = msg.usage;
        if (msg.model) session.meta.model = msg.model;
        session._accOut += u.output_tokens || 0;
        const usg = session.meta.usage;
        usg.output = session._accOut;
        usg.lastOutput = u.output_tokens || 0;
        usg.input = u.input_tokens ?? usg.input;
        usg.cacheRead = u.cache_read_input_tokens || 0;
        usg.cacheCreation = u.cache_creation_input_tokens || 0;
        usg.total = usg.input + usg.output + usg.cacheRead + usg.cacheCreation;
        changed = true;
      }
    }
  } catch {
    return false;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return changed;
}
