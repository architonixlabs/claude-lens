// main.js — ClaudeLens desktop shell.
//
// A tray-resident wrapper around the same server the CLI runs. It:
//   • adopts an already-running ClaudeLens (the SessionStart hook may have
//     started one) instead of fighting over the port,
//   • otherwise starts the server in-process,
//   • keeps a tray icon with a live session count,
//   • hides to tray on window close, so monitoring continues,
//   • can wire the Claude Code hooks and toggle start-at-login.
//
// The renderer just loads http://127.0.0.1:<port> — the same read-only UI.

// `electron` is CommonJS: a default import + destructure is the interop-safe
// form. Named ESM imports fail outright when this is loaded by plain Node.
import electron from 'electron';
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, Notification } = electron;
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || process.env.AGENTVIZ_PORT || 4317);
const BASE = `http://127.0.0.1:${PORT}`;

// When packaged, hooks/ is unpacked from the asar so the bridge is a real file
// on disk that plain `node` (invoked by Claude Code) can execute.
const RES = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : ROOT;
const INSTALL_HOOKS = path.join(RES, 'hooks', 'install-hooks.mjs');

let tray = null;
let win = null;
let closeServer = null;   // set when we own the server
let adopted = false;      // true when another instance already had the port
let sessionCount = 0;
let alerts = [];          // stalls / loops / errors worth surfacing
const notified = new Set(); // alert keys already announced, so we don't nag
let quitting = false;

// Small persisted preferences file (notifications on/off). Kept in userData so
// it survives updates and doesn't live next to the read-only app bundle.
const PREFS_FILE = () => path.join(app.getPath('userData'), 'preferences.json');

function readPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8')); }
  catch { return {}; }
}

function writePrefs(patch) {
  const next = { ...readPrefs(), ...patch };
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE()), { recursive: true });
    fs.writeFileSync(PREFS_FILE(), JSON.stringify(next, null, 2));
  } catch { /* preferences are a convenience, never fatal */ }
  return next;
}

const notificationsEnabled = () => readPrefs().notifications !== false; // default on

// One notification per distinct problem. Re-announcing the same stall every poll
// would train you to ignore it, which defeats the purpose.
function announce(list) {
  if (!notificationsEnabled() || !Notification.isSupported()) return;

  const fresh = list.filter((a) => !notified.has(alertKey(a)));
  if (!fresh.length) return;

  // Collapse a burst into one notification rather than a stack of toasts.
  const first = fresh[0];
  const more = fresh.length - 1;
  const body = more > 0
    ? `${first.label}: ${first.message} (+${more} more)`
    : `${first.label}: ${first.message}`;

  const n = new Notification({
    title: first.kind === 'stall' ? 'ClaudeLens — session stalled'
      : first.kind === 'loop' ? 'ClaudeLens — repeated calls'
        : 'ClaudeLens — errors',
    body,
    icon: appIcon(),
    silent: false,
  });
  n.on('click', showWindow);
  n.show();

  for (const a of fresh) notified.add(alertKey(a));
}

const alertKey = (a) => `${a.sessionId}|${a.kind}|${a.message}`;

// ── server ──────────────────────────────────────────────────────────────────

async function probe(timeoutMs = 1200) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function ensureServer() {
  if (await probe()) { adopted = true; return; }   // hook-started instance — reuse it

  // persist.js resolves its data dir at module load, so this must be set before
  // the import below. In a packaged app the default (<app>/data) lives inside the
  // read-only asar, so history would silently fail to save — use userData instead.
  if (app.isPackaged && !process.env.AGENTVIZ_DATA) {
    process.env.AGENTVIZ_DATA = path.join(app.getPath('userData'), 'data');
  }

  const { createServer } = await import(pathToUrl(path.join(ROOT, 'server', 'index.js')));
  const { server, close } = createServer({ demo: false });
  closeServer = close;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  }).catch(async (err) => {
    closeServer = null;
    // Someone grabbed the port between probe and listen — adopt if it's us.
    if (err && err.code === 'EADDRINUSE' && (await probe())) { adopted = true; return; }
    dialog.showErrorBox('ClaudeLens', `Could not start on port ${PORT}.\n\n${err && err.message}`);
    throw err;
  });
}

// file path → file:// URL, so dynamic import works on Windows too
function pathToUrl(p) {
  return new URL(`file://${p.startsWith('/') ? '' : '/'}${p.replace(/\\/g, '/')}`).href;
}

// ── window ──────────────────────────────────────────────────────────────────

function showWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b1220',
    title: 'ClaudeLens',
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(BASE);

  // Closing hides to tray — the whole point is to keep monitoring.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on('closed', () => { win = null; });
}

// ── tray ────────────────────────────────────────────────────────────────────

function iconPath(name) { return path.join(RES, 'desktop', 'assets', name); }

function appIcon() {
  const p = path.join(RES, 'build', 'icon.png');
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : undefined;
}

function trayIcon() {
  // macOS uses a template image so the OS tints it for light/dark menu bars.
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const img = nativeImage.createFromPath(iconPath(file));
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

function buildMenu() {
  const login = getOpenAtLogin();

  // Surface what's wrong before anything else — the whole point is that you
  // shouldn't have to open the app to find out.
  const alertItems = alerts.length
    ? [
      { label: `⚠ ${alerts.length} alert${alerts.length === 1 ? '' : 's'}`, enabled: false },
      ...alerts.slice(0, 5).map((a) => ({
        label: `   ${a.label}: ${a.message}`,
        click: () => { showWindow(); },
      })),
      { type: 'separator' },
    ]
    : [];

  return Menu.buildFromTemplate([
    ...alertItems,
    { label: sessionCount === 1 ? '1 session tracked' : `${sessionCount} sessions tracked`, enabled: false },
    { label: adopted ? `Attached to server on :${PORT}` : `Serving on :${PORT}`, enabled: false },
    { type: 'separator' },
    { label: 'Open ClaudeLens', click: showWindow },
    { label: 'Open in Browser', click: () => shell.openExternal(BASE) },
    { type: 'separator' },
    { label: 'Install Claude Code hooks…', click: () => runHookInstaller(false) },
    { label: 'Remove hooks', click: () => runHookInstaller(true) },
    { type: 'separator' },
    { label: 'Start at login', type: 'checkbox', checked: login, click: (m) => setOpenAtLogin(m.checked) },
    {
      label: 'Notify on problems',
      type: 'checkbox',
      checked: notificationsEnabled(),
      click: (m) => { writePrefs({ notifications: m.checked }); refreshMenu(); },
    },
    { type: 'separator' },
    { label: 'Quit ClaudeLens', click: () => { quitting = true; app.quit(); } },
  ]);
}

function refreshMenu() {
  if (!tray) return;
  const warn = alerts.length ? `  ⚠ ${alerts.length}` : '';
  tray.setToolTip(`ClaudeLens — ${sessionCount} session${sessionCount === 1 ? '' : 's'}${warn}`);
  tray.setContextMenu(buildMenu());
}

async function pollSessions() {
  try {
    const [sesRes, alertRes] = await Promise.all([
      fetch(`${BASE}/api/sessions`),
      fetch(`${BASE}/api/alerts`),
    ]);

    let changed = false;
    if (sesRes.ok) {
      const { sessions } = await sesRes.json();
      const next = Array.isArray(sessions) ? sessions.length : 0;
      if (next !== sessionCount) { sessionCount = next; changed = true; }
    }
    if (alertRes.ok) {
      const { alerts: next } = await alertRes.json();
      const list = Array.isArray(next) ? next : [];
      // Only redraw when the alert set actually differs, not on every poll.
      if (JSON.stringify(list) !== JSON.stringify(alerts)) { alerts = list; changed = true; }
      announce(list);
      // Forget resolved alerts so the same problem can notify again if it returns.
      const live = new Set(list.map(alertKey));
      for (const k of notified) if (!live.has(k)) notified.delete(k);
    }
    if (changed) refreshMenu();
  } catch { /* server momentarily unavailable — keep the last known state */ }
}

// ── hooks + autostart ───────────────────────────────────────────────────────

function runHookInstaller(remove) {
  const args = [INSTALL_HOOKS];
  if (remove) args.push('--remove');
  // Packaged builds don't ship a runnable standalone server, so only wire the
  // forwarding bridge — this app is what keeps the server alive.
  else if (app.isPackaged) args.push('--no-autostart');

  // ELECTRON_RUN_AS_NODE turns our own binary into a plain Node runtime, so the
  // installer works without requiring Node to be on PATH.
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  });

  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => {
    const ok = code === 0;
    dialog.showMessageBox({
      type: ok ? 'info' : 'error',
      title: 'ClaudeLens',
      message: remove
        ? (ok ? 'Hooks removed.' : 'Could not remove hooks.')
        : (ok ? 'Hooks installed.' : 'Could not install hooks.'),
      detail: (ok && !remove ? 'Restart any open Claude Code sessions to start capturing them.\n\n' : '') + out.trim(),
    });
  });
}

// Linux has no Electron login-item API, so fall back to an XDG autostart entry.
const XDG_AUTOSTART = path.join(os.homedir(), '.config', 'autostart', 'claude-lens.desktop');

function getOpenAtLogin() {
  if (process.platform === 'linux') return fs.existsSync(XDG_AUTOSTART);
  return app.getLoginItemSettings().openAtLogin;
}

function setOpenAtLogin(enabled) {
  if (process.platform === 'linux') {
    try {
      if (enabled) {
        fs.mkdirSync(path.dirname(XDG_AUTOSTART), { recursive: true });
        fs.writeFileSync(XDG_AUTOSTART,
          '[Desktop Entry]\nType=Application\nName=ClaudeLens\n'
          + `Exec=${process.execPath}\nX-GNOME-Autostart-enabled=true\nTerminal=false\n`);
      } else {
        fs.rmSync(XDG_AUTOSTART, { force: true });
      }
    } catch (err) {
      dialog.showErrorBox('ClaudeLens', `Could not update autostart.\n\n${err.message}`);
    }
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
  }
  refreshMenu();
}

// ── lifecycle ───────────────────────────────────────────────────────────────

// Only one tray app; a second launch just surfaces the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    await ensureServer();

    tray = new Tray(trayIcon());
    refreshMenu();
    // Windows/Linux: click opens. macOS reserves click for the menu.
    tray.on('click', () => { if (process.platform !== 'darwin') showWindow(); });

    await pollSessions();
    const poll = setInterval(pollSessions, 4000);
    app.on('before-quit', () => clearInterval(poll));

    showWindow();
  });

  // Tray apps stay resident when every window is closed.
  app.on('window-all-closed', (e) => { e?.preventDefault?.(); });

  app.on('activate', showWindow); // macOS dock click

  app.on('before-quit', async () => {
    quitting = true;
    if (closeServer) { try { await closeServer(); } catch { /* shutting down */ } }
  });
}
