# Changelog

All notable changes to ClaudeLens are documented here.

## [1.0.2] — 2026-07-19

### Added
- **Auto-update** (`electron-updater`). The desktop app checks the GitHub release
  feed, downloads in the background, notifies, and installs on restart. The build
  emits `latest*.yml` and the release workflow uploads it. Non-fatal offline / with
  no release / unpackaged. macOS auto-update needs a signed build; unsigned macOS
  degrades to a no-op.
- **Run judgement** — session cost from real token counts (opt-in pricing via
  `AGENTVIZ_PRICE_*`), per-agent effort attribution (time and calls, not invented
  tokens), a 0–100 health score, and stall/loop detection surfaced as tray alerts
  and OS notifications. `GET /api/report` and `GET /api/alerts`.
- **Contributor front door** — `CONTRIBUTING.md`, issue forms and a PR template.

### Fixed
- **Loop detection false-positived on repeated edits to one file.** It compared
  the display summary, which for an `Edit` is just the file path, so two *different*
  edits to the same file were flagged as thrashing. It now compares a signature over
  the full, untruncated tool input — which is precisely the advantage of consuming
  hooks over OpenTelemetry (OTel truncates tool input at 512 chars/value).
- Removed stray NUL bytes a history rewrite had left in two source files.

## [1.0.1] — 2026-07-18

Fixes the release pipeline. 1.0.0 shipped a Windows installer only, because the
multi-platform build failed on every runner.

### Fixed
- `test:unit` no longer depends on the shell expanding a glob. npm runs scripts
  through `cmd.exe` on Windows, which passed `tests/*.test.mjs` through literally
  and failed the Windows job; the file list is now resolved in Node
  (`scripts/run-unit-tests.mjs`), so it works on every OS and Node 18+.
- Added the `author` field, without which electron-builder refuses to build the
  Linux (`deb`/`AppImage`) and macOS targets.

### Added
- Multi-platform release workflow — Windows, macOS and Linux installers build in
  parallel on GitHub runners and attach to the release on a `v*` tag.
- `SIGNING.md` and `npm run make-cert` — self-signed Architonix Labs LLP
  certificate for internal distribution, plus what public signing really costs.
- Mermaid architecture, sequence and lifecycle diagrams in the README.

## [1.0.0] — 2026-07-18

First packaged release: a desktop app, a hardened server, and CI.

### Added — desktop app
- **Tray-resident desktop app** (Electron) for Windows, macOS and Linux. It keeps
  ClaudeLens running in the background, shows a live session count in the tray,
  hides to tray on close, and opens the UI in its own window or your browser.
- **Adopts a running server** instead of fighting for the port — if the
  `SessionStart` hook already started one, the app attaches to it.
- **Start at login** toggle (login item on Windows/macOS, XDG autostart on Linux)
  and **hook install/remove** straight from the tray menu.
- Installers via `npm run dist` — NSIS `.exe`, `.dmg`, `AppImage` and `.deb`.
- App and tray icons are **generated from code** (`npm run icons`), so no opaque
  binaries are committed.

### Added — security & robustness
- **Credential redaction** at the ingest boundary: vendor API keys, AWS ids, JWTs,
  bearer tokens, `KEY=VALUE` secrets and inline URL credentials are masked before
  anything is written to `data/` or included in an export (`AGENTVIZ_NO_REDACT=1`
  opts out). Pattern-based — treat `data/` as sensitive regardless.
- **Auth gate** on write endpoints via `AGENTVIZ_TOKEN` (`X-Agentviz-Token` or
  `Bearer`); reads stay open. The hook bridge forwards it.
- **Rate limiting** on writes (600 / 10 s / IP). Loopback is exempt by default —
  local bursts are legitimate; `AGENTVIZ_RATE_ALL=1` throttles it too.
- **Input validation** (malformed body → 400) and an error handler (oversized →
  413, otherwise 500) so no request can crash the process.
- **Loopback-only bind** by default; `HOST=0.0.0.0` warns on boot.
- **Transcript reads allowlisted** to `~/.claude/*.jsonl`, closing an
  arbitrary-file-read path.
- **Disk caps**: 10 MB per session file, 300 files total with oldest-first eviction.
- **WebSocket heartbeat** (30 s ping/pong) reaps half-open sockets.

### Added — quality
- **85 automated tests**: 52 `node --test` unit tests (normalizer, sessions, SDK
  bridge, persistence, redaction, auth, ingest guards) + 33 Playwright E2E.
- **ESLint** flat config (`npm run lint`), Prettier available opt-in.
- **CI** (GitHub Actions): lint + unit + E2E + smoke stress on every push, plus
  hook-installer verification on **Ubuntu and macOS**.
- `start.sh` for macOS/Linux; **Dockerfile** for a shared viewer instance.

### Fixed
- Renaming the project folder no longer orphans the installed hooks — the
  installer identifies its own entries by script filename, so re-running it
  re-points them cleanly and stays idempotent.
- Playwright no longer collects the `node --test` unit files as E2E specs.
- The "transient tool nodes" E2E test no longer depends on demo timing.
- Removed leftover pre-rebrand strings, including user-facing installer output.

### Earlier work (previously unreleased)
- **Cross-session search** — 🔍 searches every session's events (`/api/search?q=`);
  click a hit to jump to that session.
- **Scale & reliability** — a 300-session eviction cap bounds memory under load, a
  normalizer unit-test suite (`npm run test:unit`), a load test (`npm run stress` —
  41,000 ingests at ~1,900 req/s, ~370 MB), enriched `/api/health`, and a CI workflow.
- **Durable history** — every live session is persisted to `data/<id>.jsonl` and
  replayed on startup, so sessions and their timelines survive a server restart.
  Disable with `AGENTVIZ_NO_PERSIST=1`; relocate with `AGENTVIZ_DATA`.
- **Export** — download the current session (or all sessions) as JSON via the ⇩
  button or `GET /api/export?session=<id>` / `?all=1`.
- **Combined "All sessions" canvas** — every session on one graph
  (`You → session → its agents`) with a merged live log, aggregate stats, and
  tool/subagent activity; click a node to drill into that session.
- **Timeline** — record, scrub, replay a session; `● LIVE` resumes following.
- **Node inspector** — click any node for its full event history, tokens,
  durations, errors, retries; per-orchestrator cache-hit %, tool breakdown.
- **Skill → agent nesting** — subagents a skill spawns nest under the skill node.
- **Thinking status** — active agents between tool calls show a cycling
  `◇ Reasoning…` line instead of looking idle.
- Model in use + token usage (K/M/B), cache-hit %, per-tool durations, error
  surfacing, retry detection, compaction/memory-trim visibility.
- Task boxes (Ongoing / Completed), collapsible panels, session sections with
  clear, "viewing" indicator, temp-session filtering.
- Claude Agent SDK bridge (`/ingest/sdk` + `sdk/agentviz.mjs`), auto-start hook,
  one-command hook installer, `start.bat` launcher (frees the port, opens the UI).

### Notes
- Read-only by design — never sends anything back into a Claude session.
- Claude Desktop is not supported (no hooks); Claude Code + Agent SDK only.
