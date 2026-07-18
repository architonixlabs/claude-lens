# Roadmap — Production Readiness

Verdict: **ready enough as a local, single-developer tool** (after the fixes below);
**not ready** as a shared/hosted multi-user service (that needs auth, tenancy, a datastore,
TLS, rate-limiting, redaction — a v2, not a patch).

## ✅ Done (security fixes — 2026-07)
- Bind to **127.0.0.1 by default** (was `0.0.0.0`); `HOST=0.0.0.0` to expose deliberately, with a warning.
- **`transcript_path` allowlist** (`~/.claude/*.jsonl`) — closes an arbitrary-file-read. Covered by `tests/security.test.mjs`.
- **Graceful shutdown** (flush + close on SIGINT/SIGTERM).

## 🔴 P0 — blockers before any "production" use
- [ ] **`git init` + initial commit** — repo is not under version control yet.
- [ ] **Auth on `/ingest` + APIs** — optional `AGENTVIZ_TOKEN`, enforced whenever `HOST` ≠ localhost (bearer / `X-Arx-Token`).
- [ ] **Disk-DoS guard** — cap per-session file size + total `data/` size + a retention/expiry policy (today `data/` is unbounded on disk; only reload is capped to 40 files).

## 🟠 P1 — polished product
- [ ] Route **input validation** + express **error-handling middleware** (no unhandled 500s); basic **rate-limit** on `/ingest`.
- [ ] **eslint + prettier** config + CI lint step.
- [ ] **More unit tests** — `sessions.js` (eviction/usage/search), `sdk.js`, `persist.js`.
- [ ] **Secret redaction** — commands/outputs may contain secrets; stored plaintext in `data/` + included in exports. Optional masking + privacy note.
- [ ] **Cross-platform** — `start.sh` for macOS/Linux; verify hook install off Windows.
- [ ] **Dockerfile** (org standard) + flip `private:false` / tag releases when publishing.
- [ ] **WS heartbeat** (ping/pong) to reap dead sockets.

## 🟡 P2 — future / only if hosting for a team
- [ ] Multi-tenancy + real datastore; TLS via reverse proxy.
- [ ] Structured logs + `/metrics` (Prometheus); SonarQube scan + SBOM (Dependency-Track).
- [ ] Alerts/notifications on error; compare-two-sessions; token/cost analytics over time.
- [ ] Accessibility audit; i18n.

## Naming
Working name: **ClaudeLens**. Final name TBD (see options under discussion).
