# ClaudeLens — Claude Multi-Agent Visualization

**ClaudeLens** is a **read-only, real-time map & timeline debugger** that runs alongside your
Claude Code sessions and shows the whole agent swarm at work: the orchestrator, every
subagent it dispatches, the skills and tools they call, and the messages/results flowing
between them — as a clean, animated **2D node-link graph**, backed by a scrolling
interaction log.

It is **global and multi-session**: it captures *every* active Claude session (keyed by
`session_id`), gives you a **session picker**, and a **combined "All" canvas** that puts
every session on one graph (`You → session → its agents`). Sessions are **persisted to disk**
so they survive a restart, and any session can be **exported** to JSON for sharing.

It is generic (any Claude Code session, any task), self-hosted, offline-capable, and ships
as a lightweight hook you drop into your Claude settings — plus a bridge for **Claude Agent
SDK** apps.

![ClaudeLens](docs/screenshot.png)

Quickest start on Windows: **`start.bat`** (frees the port, launches the server, opens the UI).

---

## What you see

- **Session picker** (left panel): every active Claude session — labelled by its **project
  folder**, with the first prompt, agent/event counts, a live status dot, the **model in
  use** and **token usage**. Click one to watch it.
- **You → Claude (orchestrator) → subagents** laid out left→right as clean node chips, each
  showing its name and status — no overlap, no occlusion.
- **Tools, skills and MCP calls** appear as small **chips beside the agent** that made them
  (⚙ tool, ◆ skill, ⬡ MCP) showing the **call detail** (file / command) and, on return, the
  **result + duration** (`Bash → 4 raw() calls · 407ms`); a tool-count badge sits on each agent.
- **Live activity line** under every agent — what it's doing right now (`▸ Bash · npm test`)
  or last did (`✓ Read → 88 lines`), so the orchestrator never looks idle.
- **Errors** surface in **red**: failed tools / non-zero exits / failed subagents turn the
  node, chip, and log row red and bump an **errors** count (per-session badge + HUD tile).
- **Message flow**: every dispatch, tool call, and result sends a **pulse gliding along the
  link** — request out, response back — and the target flashes as it acts on it.
- **Node state** by color: `active` glows + ring, `done` settles, `error` red, `idle` dims.
- **Interaction log** (right panel): every event with detail + duration, color-coded,
  filterable, auto-scrolling, collapsible — read-only.
- **Session picker** groups sessions into **Active / Inactive / Done** sections (scrollable),
  with **clear** buttons for the inactive/done ones. Every panel collapses (▾); temp/scratch
  sessions are filtered out.
- **Two task boxes** on the canvas — **Ongoing / Completed** — list the subagents/skills by
  status (with tool counts); click one to jump to it.
- **Thinking status** — an active agent that's between tool calls (the model is generating,
  which fires no hook) shows a live cycling `◇ Reasoning… / Generating…` line instead of
  looking idle.
- **Node inspector** — click any node for its full details: type, status, parent, tool count,
  and its complete event history (with durations, results, errors, retries). On the
  orchestrator it also shows **cache-hit %**, **tool breakdown** (`Read ×5 · Bash ×3`), and
  any **memory-trim** count.
- **Timeline** (bottom) — the session is **recorded**; scrub back through it, ▶ play it, or
  jump to **● LIVE**. Navigate to any moment to see the graph + log as of then.
- **▶ Viewing `<session>`** indicator shows which session's canvas you're on; **▦ All** shows
  a **combined canvas** — *every* session on one graph (`You → session → its agents`) with a
  merged live log — click any node to drill into that session.
- **Errors** turn nodes/chips/log-rows red; **compaction** (Claude's `PreCompact` and our own
  buffer trimming) is surfaced, never silently dropped.
- **Live stats**: agents, active, events, **tokens** (K/M/B), **cache %**, **errors** — plus
  the current **model** pill.
- Static, analyzable view (no spinning). Drag to pan, scroll to zoom, **⤢** to re-fit; hover
  a node for its details.

Everything is **read-only** — the app never sends anything back into your session.

---

## Quick start

```bash
npm install
npx playwright install chromium   # only needed to run the E2E tests

# 1) See it immediately with the built-in demo (loops a synthetic multi-agent run):
npm run demo
#    → open http://localhost:4317

# 2) Or run it live and wire your Claude session's hooks into it (below):
npm start
```

- `PORT` (default `4317`) — server port.
- `AGENTVIZ_DEMO=1` — auto-play the demo scenario on a loop (what `npm run demo` sets).
- `AGENTVIZ_SPEED` — demo playback multiplier (default `1`).

---

## Wire it into a live Claude Code session

The app learns what your agents are doing through **Claude Code hooks**. A tiny bridge
script forwards each hook event to the running server; the server normalizes it into an
agent graph and pushes it to every open browser over WebSocket.

```bash
npm install
npm run install-hooks  # wire the hooks into ~/.claude/settings.json (global = all sessions)
```

Then **restart your other Claude Code sessions** (or start a new one) and watch the
constellation build itself at `http://localhost:4317`. You do **not** need to start the
server manually — on `SessionStart` the hooks **auto-start** it (detached, so it keeps
running and capturing every session). The installer:

- **appends** our commands to each hook event — any hooks you already have are left intact;
- wires an **auto-start** command into `SessionStart` (`ensure-server.mjs`) that boots the
  server if it isn't already up, and a **forward** command (`claude-hook.mjs`) into every
  event that posts it to the server;
- is **idempotent** (safe to re-run) and writes a timestamped `settings.json.bak-*` backup;
- takes `--project` (use `./.claude/settings.json`), `--settings=PATH`, `--port=N`,
  `--no-autostart` (wire forwarding only — you run `npm start` yourself), and `--remove`
  (uninstall). `npm run uninstall-hooks` is the shortcut for the last.

> Prefer to run it yourself? `npm start` still works, and auto-start becomes a no-op when a
> server already owns the port.

The bridge ([`hooks/claude-hook.mjs`](hooks/claude-hook.mjs)) is **fire-and-forget** with a
400 ms timeout and always exits `0`, so the visualizer can never slow down or break your
session — if the server isn't running, hooks simply no-op. (Prefer to wire it by hand?
[`hooks/settings.snippet.json`](hooks/settings.snippet.json) is the manual equivalent; point
the bridge elsewhere with `--port=`/`--url=` args or `AGENTVIZ_PORT`/`AGENTVIZ_URL`.)

> ⚠️ **Claude Desktop is not supported** — it has no hooks mechanism, so Desktop sessions
> can't be captured. This works with **Claude Code** (CLI and the VS Code / JetBrains
> extensions) only.

---

## Include your own SDK-based apps

Apps built on the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) don't fire Claude
Code hooks, so they wire in differently — by streaming their SDK messages to the server.
Drop in [`sdk/agentviz.mjs`](sdk/agentviz.mjs) and wrap your existing `query()` loop:

```js
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentViz } from './agentviz.mjs';

const viz = new AgentViz({ label: 'my-web-app', cwd: process.cwd() });
//   also accepts { url: 'http://host:4317', sessionId: '...' }

for await (const msg of viz.tap(query({ prompt, options }))) {
  // ...your normal message handling — unchanged...
}
```

`.tap()` forwards each SDK message (fire-and-forget, 500 ms timeout, never throws or blocks)
and re-yields it, so your loop is untouched. The server translates `system`/`assistant`/
`user`/`result` messages into the same normalized events — subagents (via the `Task` tool),
tool/skill/MCP calls (matched precisely by `tool_use_id`), the **model**, and **token usage**
(accumulated from each assistant message). The app appears in the picker under your `label`.

**Any language works** — it's just HTTP. `POST http://127.0.0.1:4317/ingest/sdk` with
`{ session_id, label?, cwd?, message }` (or `{ ..., messages: [...] }`), where `message` is a
raw SDK stream message. A Python app, for example:

```python
import requests
def report(message, sid="my-py-app"):
    try:
        requests.post("http://127.0.0.1:4317/ingest/sdk",
                      json={"session_id": sid, "label": "my-py-app", "message": message}, timeout=0.5)
    except Exception:
        pass
# call report(msg) for each message your SDK query yields
```

---

## How it works

```text
Claude Code sessions ─stdin JSON→ claude-hook.mjs ─POST /ingest──────→ ┐
SDK apps (agentviz)  ─SDK msgs──→ POST /ingest/sdk → sdk.js → payloads ┤
sim/simulator.js (demo) ─────────────────────────── ingest() ─────────┼─ SessionManager
                                                                       │    session_id → { Normalizer → graph, events }
                                                                       ▼
                                             session list  +  per-session snapshot/update
                                                                       │  WebSocket /ws  (client subscribes to one)
                                                                       ▼
                         Browser: session picker · 2D node-link graph · interaction log (public/)
```

Every hook payload carries a `session_id`; the **SessionManager** routes it to that
session's own `Normalizer` (graph) and event buffer. The browser is shown the list of all
sessions and subscribes to whichever one you pick. Both the live hook path and the demo
simulator feed the **same** normalizer, so the demo is a faithful rehearsal of real
sessions rather than a separate mock.

### Event model

Raw Claude hook payloads are normalized into events with a stable shape
(`server/normalize.js`):

| Claude hook          | Becomes                                                        |
|----------------------|----------------------------------------------------------------|
| `SessionStart`       | orchestrator activates (`session_start`)                       |
| `UserPromptSubmit`   | beam **You → Claude** (`message`)                              |
| `PreToolUse` (`Task`)| **subagent spawn** + beam parent → child                       |
| `PreToolUse` (`Skill`/`mcp__*`/other) | **tool_use** — a transient tool/skill/mcp node + request beam |
| `PostToolUse`(`Task`)| subagent **result** beam child → parent                        |
| `PostToolUse`(other) | **tool_result** — response beam back to the agent, node fades  |
| `SubagentStop`       | subagent marked `done` (`agent_done`)                          |
| `Notification`/`Stop`/`SessionEnd` | log notes / settle state                         |

`Pre`/`PostToolUse` for the same call are correlated by a per-agent stack and carry a
`callId` + `kind` (`tool` / `skill` / `mcp`), so the browser can pair each request with its
response. Non-`Task` tool events are attributed to the most-recently-spawned in-flight
subagent, falling back to the orchestrator — a **best-effort heuristic**, since hook payloads
don't always carry a distinct subagent identity (approximate for deeply parallel fan-outs).
Subagent **spawns**, **results**, and **stops** are always precise.

### Model & token usage

Each session card and the HUD show the **model** and **token usage**. Hook payloads don't
carry tokens, so the server reads the session's `transcript_path` **incrementally** (only the
bytes appended since the last read) to pull the latest `model` and cumulative
`input`/`output`/cache token counts. Reads are throttled and non-blocking. Demo sessions
stamp synthetic model + token data so this is visible without a live run.

---

## Testing

End-to-end tests (Playwright) drive the real server in demo mode and assert the whole
pipeline — the 2D canvas boots, WebSocket goes live, the demo stream builds the graph, the
log fills with normalized events, the filter works, and the HTTP endpoints behave:

```bash
npx playwright install chromium   # first time only
npm test
```

```text
33 passed ✓  2D canvas · WebSocket · graph builds · log + stats · filter · multi-session ·
             picker switch · sections + collapse · clear idle/ended · tool/skill/mcp ·
             skill→agent nesting · model + tokens (K/M/B) · cache% · durations · errors ·
             compaction/memory · retries · node inspector · timeline scrub/replay ·
             task boxes · viewing · combined canvas · export · search · health · SDK · labels
```

- `npm run test:unit` — 10 unit tests for the normalizer (the core parser).
- Standalone persistence check — a session survives a server restart.
- `npm run stress [sessions] [eventsPer]` — load test. Sample: **41,000 ingests, 0 fail,
  ~1,550 req/s, p99 58ms, memory ~370 MB** (the 300-session eviction cap holds it flat),
  cross-session search 50 hits in ~5 ms.

---

## Project layout

```text
server/
  index.js        Express + WebSocket server, /ingest, /api/sessions, WS subscribe, demo autostart
  normalize.js    raw hook payloads → normalized events + agent graph (single source of truth)
  sessions.js     Session + SessionManager: per-session_id graph, event buffer, pub/sub
  transcript.js   incremental transcript reader → model + token usage per session
  sdk.js          Claude Agent SDK messages → hook payloads (for /ingest/sdk)
sdk/
  agentviz.mjs    drop-in client for SDK apps: viz.tap(query(...)) streams sessions in
hooks/
  claude-hook.mjs        Claude Code → /ingest bridge (fire-and-forget)
  ensure-server.mjs      SessionStart auto-start: boots the server if it isn't running
  install-hooks.mjs      idempotent installer (append/remove; --port/--project/--no-autostart)
  settings.snippet.json  manual drop-in hooks config
sim/
  scenario.js     three scripted runs (security audit / feature build / docs) as hook payloads
  simulator.js    drives several concurrent demo sessions, or one session over HTTP
public/
  index.html, css/, js/{main,scene,ws,log}.js   (scene.js = 2D canvas node-link renderer)
tests/
  e2e.spec.js     Playwright end-to-end suite
```

---

## Notes & limits

- **Read-only by design.** No control plane, no way to affect a session. "Subscribing" to a
  session only selects which view the browser receives.
- **Sessions** are keyed by Claude's `session_id`. One running server + one browser tab
  covers all your concurrent Claude runs; the picker sorts by most-recent activity and the
  status dot goes idle after 90 s of silence, `ended` on `SessionEnd`.
- The UI is a **dependency-free 2D canvas** renderer (`public/js/scene.js`) — no WebGL, no
  CDN, no build step; runs fully offline and stays legible on any hardware.
- Attribution of non-`Task` tool calls to a specific subagent is heuristic (see above).
- State is **in-memory** — restarting the server clears history; the browser resyncs from
  the next snapshot automatically.
- Static analysis: `sonar-project.properties` is included per the Architonix Labs standard
  (SonarQube `http://<build-host>:7001`); scan from a host with LAN reach using tokens from
  the shared `scan.env` — never hard-code them.
