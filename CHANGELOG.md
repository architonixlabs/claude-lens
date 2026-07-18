# Changelog

All notable changes to ClaudeLens are documented here.

## [Unreleased]

### Added
- **Cross-session search** — 🔍 searches every session's events (`/api/search?q=`);
  click a hit to jump to that session.
- **Scale & reliability** — a 300-session eviction cap bounds memory under load, a
  normalizer unit-test suite (`npm run test:unit`), a load test (`npm run stress` —
  ~1,550 req/s at ~370 MB), enriched `/api/health` (uptime, memory), and a CI workflow.
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
