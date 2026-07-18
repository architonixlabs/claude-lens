#!/usr/bin/env node
// install-hooks.mjs — wire Agent Constellation into your Claude Code settings.
//
// It APPENDS our bridge command to each relevant hook event, leaving any hooks
// you already have (other tools, etc.) untouched. Idempotent: running twice does
// not duplicate. A timestamped backup of settings.json is written first.
//
// Usage:
//   node hooks/install-hooks.mjs                 # global ~/.claude/settings.json
//   node hooks/install-hooks.mjs --project       # ./.claude/settings.json (cwd)
//   node hooks/install-hooks.mjs --settings=PATH # explicit file
//   node hooks/install-hooks.mjs --port=4317     # if your server runs on another port
//   node hooks/install-hooks.mjs --remove        # uninstall our hooks only

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, 'claude-hook.mjs');
const ENSURE = path.join(__dirname, 'ensure-server.mjs');
// Identify our own hook entries by our script filenames — NOT by folder path — so
// a re-run still finds (and re-points) them after the project folder is renamed.
// Only our .mjs scripts match; a different tool's claude-hook.js won't.
const OURS = /[\\/](?:claude-hook|ensure-server)\.mjs\b/;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (name, d) => { const h = args.find((a) => a.startsWith(`--${name}=`)); return h ? h.split('=').slice(1).join('=') : d; };

const PORT = val('port', '4317');
const REMOVE = has('--remove');
const AUTOSTART = !has('--no-autostart'); // auto-start the server on SessionStart

// Events our normalizer understands (server/normalize.js).
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'Notification', 'Stop', 'SessionEnd'];

function settingsPath() {
  const explicit = val('settings', null);
  if (explicit) return explicit;
  if (has('--project')) return path.join(process.cwd(), '.claude', 'settings.json');
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function portArg() {
  return PORT && PORT !== '4317' ? ` --port=${PORT}` : '';
}
function bridgeCommand() { return `node "${BRIDGE}"${portArg()}`; }
function ensureCommand() { return `node "${ENSURE}"${portArg()}`; }

function isOurs(cmd) {
  return typeof cmd === 'string' && OURS.test(cmd);
}

function main() {
  const file = settingsPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  let settings = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try { settings = raw.trim() ? JSON.parse(raw) : {}; }
    catch (e) { console.error(`✖ ${file} is not valid JSON — fix it first.\n  ${e.message}`); process.exit(1); }
    const backup = `${file}.bak-${Date.now()}`;
    fs.writeFileSync(backup, raw);
    console.log(`• Backed up → ${backup}`);
  }

  settings.hooks = settings.hooks || {};
  let added = 0, removed = 0;

  for (const ev of EVENTS) {
    const groups = settings.hooks[ev] = settings.hooks[ev] || [];

    // Always strip any previous copy of ours (handles path/port changes + --remove).
    for (const g of groups) {
      if (Array.isArray(g.hooks)) {
        const before = g.hooks.length;
        g.hooks = g.hooks.filter((h) => !isOurs(h && h.command));
        removed += before - g.hooks.length;
      }
    }
    // drop groups we emptied
    settings.hooks[ev] = groups.filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);

    if (!REMOVE) {
      const list = settings.hooks[ev];
      // Reuse an existing catch-all group if present; else make one.
      let group = list.find((g) => (g.matcher ?? '') === '' || g.matcher === '*');
      if (!group) { group = { matcher: '', hooks: [] }; list.push(group); }
      group.hooks = group.hooks || [];
      // On SessionStart, ensure the server is up (auto-start) before forwarding.
      if (ev === 'SessionStart' && AUTOSTART) {
        group.hooks.push({ type: 'command', command: ensureCommand(), timeout: 10 });
        added++;
      }
      group.hooks.push({ type: 'command', command: bridgeCommand(), timeout: 5 });
      added++;
    }
  }

  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');

  if (REMOVE) {
    console.log(`✔ Removed Agent Constellation from ${removed} hook entr${removed === 1 ? 'y' : 'ies'} in ${file}`);
  } else {
    console.log(`✔ Installed ${added} hook commands (removed ${removed} stale copies) in ${file}`);
    console.log(`  forward:     ${bridgeCommand()}`);
    if (AUTOSTART) console.log(`  auto-start:  ${ensureCommand()}   (SessionStart)`);
    console.log('\n  Next: RESTART your other Claude Code sessions (or start a new one).');
    if (AUTOSTART) console.log(`  The server now auto-starts on SessionStart (port ${PORT}); no need to run it manually.`);
    else console.log(`  Start the server yourself:  npm start   (expects port ${PORT})`);
    console.log('  Note: Claude Desktop has no hooks and cannot be captured — Claude Code only.');
  }
}

main();
