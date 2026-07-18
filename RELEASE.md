# ClaudeLens 1.0.0

A **read-only live map & timeline debugger** for Claude Code and Claude Agent SDK runs — the
orchestrator, every subagent, the skills and tools they call, tokens, errors and durations,
across every session at once.

This is the first packaged release: a tray-resident desktop app, a hardened server, and CI.

---

## Install

### Desktop app (recommended)

Download the installer for your platform from the release assets:

| Platform | Asset | Notes |
|----------|-------|-------|
| Windows | `ClaudeLens-Setup-1.0.0-x64.exe` | NSIS installer; choose your install directory |
| macOS | `ClaudeLens-1.0.0-{x64,arm64}.dmg` | Drag to Applications |
| Linux | `ClaudeLens-1.0.0.AppImage` | `chmod +x` then run |
| Linux (Debian/Ubuntu) | `claude-lens_1.0.0_amd64.deb` | `sudo apt install ./claude-lens_1.0.0_amd64.deb` |

After launching:

1. Open the tray menu → **Install Claude Code hooks…**
2. Restart any open Claude Code sessions.
3. Sessions appear automatically. Tray → **Open ClaudeLens** (or click the icon).

Enable tray → **Start at login** to have it always running.

> **Unsigned builds.** These artifacts are not code-signed. Windows SmartScreen will warn
> ("More info" → "Run anyway") and macOS Gatekeeper will block the app until you allow it in
> *System Settings → Privacy & Security*. Sign the builds before distributing publicly.

### From source

```bash
git clone https://github.com/architonixlabs/claude-lens
cd claude-lens
npm install
npm run install-hooks     # wire the Claude Code hooks
npm start                 # or: start.bat (Windows) / ./start.sh (macOS, Linux)
```

Requires **Node 18+**. Then open <http://localhost:4317>.

### Build installers yourself

```bash
npm run dist          # current platform
npm run dist:win      # or :mac / :linux
```

Artifacts land in `dist/`. **Each OS must be built on that OS** — macOS `.dmg` in
particular cannot be produced from Windows or Linux.

---

## What's in this release

### Desktop app

Tray-resident wrapper around the same server the CLI runs. It shows a live session count,
hides to tray on close so monitoring continues, and can install the Claude Code hooks and
toggle start-at-login from its menu. If the `SessionStart` hook already started a server,
the app **attaches to it** rather than fighting over the port.

Icons are generated from code (`npm run icons`) rather than committed as opaque binaries.

### Security

Session data is sensitive — it carries your prompts, file paths, commands and tool output.

- **Credential redaction** before anything is stored or exported: vendor API keys, AWS access
  key ids, JWTs, bearer tokens, `KEY=VALUE` secrets and inline URL credentials are masked,
  with surrounding context left readable. Pattern-based, so treat `data/` as sensitive
  regardless; `AGENTVIZ_NO_REDACT=1` disables it.
- **Loopback-only** by default; binding wider warns on boot.
- **Token auth** on writes via `AGENTVIZ_TOKEN` — set this whenever you expose the port.
- **Rate limiting**, **input validation** and a catch-all error handler.
- **Transcript reads allowlisted** to `~/.claude/*.jsonl`.
- **Bounded disk and memory**: 10 MB per session file, 300 files, 300 live sessions.

### Quality

- **85 automated tests** — 52 unit (`node --test`) + 33 Playwright E2E.
- **CI** on every push: lint, unit, E2E, smoke stress, plus hook-installer verification on
  Ubuntu and macOS.
- Load tested at **41,000 ingests, 0 failures, ~1,900 req/s**, ~370 MB steady state.

See [CHANGELOG.md](CHANGELOG.md) for the full list.

---

## Known limitations

- **Claude Desktop is not supported** — it has no hooks mechanism. Claude Code (CLI, VS Code
  and JetBrains extensions) and the Agent SDK only.
- **Installers are unsigned** (see above).
- Attribution of non-`Task` tool calls to a specific subagent is a **best-effort heuristic**;
  hook payloads don't always carry a distinct subagent identity, so deeply parallel fan-outs
  are approximate. Subagent spawns, results and stops are always precise.
- Redaction is **pattern matching, not a guarantee**.
- Single-user by design: no multi-tenancy, no TLS, no external datastore. Hosting it for a
  team would need all three.
- **Renaming the install folder** breaks the installed hooks (they store absolute paths) —
  re-run `npm run install-hooks` afterwards.
- The server must be **restarted to pick up code changes**; the auto-start hook otherwise
  keeps an older build resident.

---

## Verifying a build

```bash
npm run lint          # ESLint, clean
npm run test:unit     # 52 passing
npm test              # 33 Playwright E2E passing
npm run stress        # 41,000 ingests, 0 fail
```

---

## Links

- Source — <https://github.com/architonixlabs/claude-lens>
- Roadmap — [ROADMAP.md](ROADMAP.md)
- Licence — MIT
