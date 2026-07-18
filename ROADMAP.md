# Roadmap — Production Readiness

Verdict: **ready enough as a local, single-developer tool** (after the fixes below);
**not ready** as a shared/hosted multi-user service (that needs auth, tenancy, a datastore,
TLS, rate-limiting, redaction — a v2, not a patch).

## ✅ Done (security fixes — 2026-07)
- Bind to **127.0.0.1 by default** (was `0.0.0.0`); `HOST=0.0.0.0` to expose deliberately, with a warning.
- **`transcript_path` allowlist** (`~/.claude/*.jsonl`) — closes an arbitrary-file-read. Covered by `tests/security.test.mjs`.
- **Graceful shutdown** (flush + close on SIGINT/SIGTERM).

## ✅ P0 — done (2026-07-18)
- [x] **`git init` + initial commit** — repo under version control (`main`).
- [x] **Auth on writes** — optional `AGENTVIZ_TOKEN` gates `/ingest`, `/ingest/sdk`,
      `/api/sessions/clear` (`X-Agentviz-Token` or `Bearer`); reads stay open.
      The hook bridge forwards it. Covered by `tests/auth.test.mjs`.
- [x] **Disk-DoS guard** — 10 MB per-session-file cap + 300-file total cap with
      oldest-first eviction.
- [x] **Error-handling middleware** — bad JSON → 400, oversized → 413, else 500; never a crash.
- [x] **Rename-safe hooks** — the installer identifies its own entries by script
      filename, so a folder rename re-points cleanly and stays idempotent.

## ✅ P1 — done (2026-07-18)

- [x] **Input validation** on `/ingest` + `/ingest/sdk` (non-object body, wrong-typed
      `hook_event_name`/`session_id` → 400) and a **rate limit** (600 req / 10 s / IP,
      `AGENTVIZ_RATE_MAX`). **Loopback is exempt by default** — local bursts (replay,
      parallel subagents, `sim/stress.js` at ~1.9k req/s) are legitimate; set
      `AGENTVIZ_RATE_ALL=1` to throttle localhost too.
- [x] **Secret redaction** (`server/redact.js`) — API keys, AWS ids, JWTs, bearer
      tokens, `KEY=VALUE` secrets and inline URL credentials are masked at the ingest
      boundary, so they never reach `data/` or `/api/export`. `AGENTVIZ_NO_REDACT=1`
      opts out. Pattern-based, so treat `data/` as sensitive regardless.
- [x] **eslint (flat config) + prettier**; `npm run lint` / `format` / `test:all`.
- [x] **More unit tests** — `sessions.js`, `sdk.js`, `persist.js`, redaction, ingest
      guards. **52 unit + 33 E2E**, lint clean.
- [x] **Cross-platform** — `start.sh` for macOS/Linux mirroring `start.bat`.
- [x] **Dockerfile** + `.dockerignore` (non-root, healthcheck, `/data` volume).
- [x] **WS heartbeat** (ping/pong, 30 s sweep) to reap half-open sockets.

Still open from P1: CI lint step (no CI configured yet); verify hook install on
macOS/Linux; flip `private:false` when publishing.

## 🟡 P2 — future / only if hosting for a team
- [ ] Multi-tenancy + real datastore; TLS via reverse proxy.
- [ ] Structured logs + `/metrics` (Prometheus); SonarQube scan + SBOM (Dependency-Track).
- [ ] Alerts/notifications on error; compare-two-sessions; token/cost analytics over time.
- [ ] Accessibility audit; i18n.

## Naming
Working name: **ClaudeLens**. Final name TBD (see options under discussion).
