# Roadmap

**Where it stands (v1.0.1):** a complete, hardened, single-developer tool. Tray desktop app
for Windows/macOS/Linux, hardened server, 85 automated tests, CI on three OSes, public MIT
repo. P0 (security blockers) and P1 (polish) are done — see the bottom of this file.

**Where it goes next** was re-derived from scratch in a structured brainstorming session
(2026-07-18, 5 divergent techniques → ~73 ideas → affinity clustering → impact/effort). That
session changed the plan, so the reasoning is recorded here rather than just the conclusions.

---

## What the session found

**Every job users hire ClaudeLens for asks for a _judgement_ — the product only offers an
_observation_.** "Is it stuck?", "why did this cost so much?", "which approach won?", "is it
thrashing?" The graph shows you what happened; it never tells you whether that was good.

**Three findings reframed the roadmap:**

1. **The old P2 was written for the wrong audience.** Multi-tenancy, a datastore, Prometheus
   metrics — infrastructure for a hypothetical hosted team product. Across five divergent
   rounds, almost nothing pointed there. The real user is one developer with months of
   unexamined session history sitting on disk.

2. **The normalizer is the asset; the graph is one renderer.** "Kill the Crown Jewel"
   (delete the graph) and "Build on What Works" (amplify strengths) independently reached the
   same verdict. The graph is also the most expensive surface in the codebase — the canvas
   renderer and most of the 33 E2E tests — and it only pays off while you are actively
   looking at it. That is the worst value-per-attention ratio in the product.

3. **The core contradiction: ClaudeLens is most valuable when you watch it, but you are most
   productive when you don't.** Today it only rewards attention it shouldn't be asking for.
   The resolutions are to move insight to where attention already is (tray, notifications),
   surface only anomalies, deliver value after the fact as a digest — or change the consumer
   entirely and let the *agent* read its own history.

---

## 🟢 P2 — Insight: verdicts over data you already have

The theme: stop describing runs, start judging them. Highest impact for least effort, because
the data is already captured and normalized.

- [x] **Stall & loop detection** (`server/analysis.js`). An agent silent past `STALL_MS`
      while still active is stalled; identical repeated calls are aggregated into a loop.
      An *ended* session is finished, not stuck — never reported as stalled.
- [x] **Run report card + health score.** `GET /api/report?session=<id>` (add `&format=md`
      for pasteable markdown): grade, 0–100 score with every deduction traced to a named
      reason, duration, tokens, errors, loops and slowest calls.
- [x] **Anomaly feed.** `GET /api/alerts` returns only what deserves attention across all
      sessions — the feed a notifier or an agent polls instead of watching the graph.
- [x] **Tray surfacing.** Alerts appear at the top of the tray menu with a `⚠ n` tooltip,
      so trouble reaches you without opening anything.
- [x] **Desktop notifications** — OS toast on each *new* problem, collapsed into one when a
      burst arrives, and forgotten once resolved so the same issue can alert again later.
      Toggle in the tray; preference persisted to userData.
- [x] **Cost + effort attribution.** Session cost from real token counts, plus what cache
      reuse saved. Pricing is opt-in via env — a stale hard-coded rate table reporting wrong
      money is worse than reporting none. Effort is attributed per agent as **time, calls and
      errors, not tokens**: hook payloads carry no per-tool token counts, so a per-subagent
      token split would be invented rather than measured.
- [ ] **Baseline comparison** — "deviating from *your* normal", not just absolute thresholds.

## 🔵 P3 — Substrate: one model, many renderers

Make the normalizer the product's spine so every new surface is cheap. This is what turns P2
ideas from one-off features into a platform.

- [ ] **Freeze and document the event schema**, with a contract test so renderers can't
      drift from the normalizer.
- [ ] **Retroactive transcript import** — read `~/.claude/projects/*.jsonl` through the *same*
      normalizer. The single biggest unlock found: it analyses sessions never captured, gives
      instant value on first launch, and removes hook installation as the adoption barrier.
- [ ] **CLI** — `claude-lens why <id>`, `cost`, `tail`, `diff a b`. Scriptable and greppable;
      a text tree is diffable in a way the graph never will be.
- [ ] **MCP server over session history.** The sleeper idea: the only one where the consumer
      changes from human to agent, so it dissolves the attention contradiction rather than
      mitigating it. Lets Claude ask "how did I solve this last month?"
- [ ] **Run comparison / diff** — "which of my three approaches won?"
- [ ] **Self-contained HTML export** — one file, no server, safe to hand to a colleague
      (redaction already makes this defensible).

## 🟡 P4 — Efficiency: cost of ownership

Cheaper to run, cheaper to maintain. Small items, real payback.

- [ ] **Auto-update** (`electron-updater`) — without it, shipped fixes never reach anyone.
- [ ] **Split the Windows installer per architecture** — it currently ships x64+arm64 in one
      184 MB file; splitting roughly halves the download.
- [ ] **`npx claude-lens` path** — same product at ~1% of the download for anyone who has
      Node (which every Claude Code user does).
- [ ] **Coalesce canvas redraws** (dirty regions / rAF) — it currently redraws everything on
      every event, which matters for an always-on tray app.
- [ ] **Lazy event buffers** so idle sessions cost near zero (300 live sessions ≈ 370 MB today).
- [ ] **Tiered retention** — full fidelity for recent runs, roll older ones into aggregates
      and drop raw events. Unbounded history at bounded cost.
- [ ] **WebSocket deltas** instead of full snapshots for large sessions.
- [ ] **Move E2E coverage down the test pyramid** — much of it tests logic that belongs in
      unit tests; faster and less flaky CI.
- [ ] **Perf regression gate in CI** using the existing stress harness, so speed can't
      silently rot.

## 🟣 P5 — Reach

- [ ] **List as a Claude Code plugin** so installing is one command, not a git clone.
- [ ] **Docs site** from the existing README/SIGNING material.
- [ ] **Editor panel** (VS Code) — put it where attention already is.

---

## 💤 Deferred — hosted / team service

**This was the old P2. It is explicitly parked, not forgotten.** Multi-tenancy, an external
datastore, Prometheus metrics, TLS termination and alerting are all real work — but they
serve a hosted multi-user product that nothing in the session's evidence called for. Revisit
when hosting for a team is an actual requirement rather than a hypothetical; until then this
work would cost heavily and change nothing for the real user.

Also considered and **rejected on principle:** a runaway kill-switch (budget cap that stops a
session). The need is genuine, but read-only is a core guarantee. ClaudeLens detects and
warns; the human or the agent acts.

---

## ✅ Completed

### Security fixes (2026-07)

- Bind to **127.0.0.1 by default**; `HOST=0.0.0.0` exposes deliberately, with a warning.
- **`transcript_path` allowlist** (`~/.claude/*.jsonl`) — closes an arbitrary-file-read.
- **Graceful shutdown** (flush + close on SIGINT/SIGTERM).

### P0 — blockers (2026-07-18)

- [x] **Version control** — public repo at `github.com/architonixlabs/claude-lens`.
- [x] **Auth on writes** — optional `AGENTVIZ_TOKEN` gates `/ingest`, `/ingest/sdk`,
      `/api/sessions/clear`; reads stay open. The hook bridge forwards it.
- [x] **Disk-DoS guard** — 10 MB per session file, 300 files, oldest-first eviction.
- [x] **Error-handling middleware** — bad JSON → 400, oversized → 413, else 500; never a crash.
- [x] **Rename-safe hooks** — the installer identifies its own entries by script filename, so
      a folder rename re-points cleanly and stays idempotent.

### P1 — polish (2026-07-18)

- [x] **Input validation** and a **rate limit** (600 req/10 s/IP). Loopback is exempt by
      default — local bursts are legitimate; `AGENTVIZ_RATE_ALL=1` throttles it too.
- [x] **Credential redaction** at the ingest boundary — API keys, AWS ids, JWTs, bearer
      tokens, `KEY=VALUE` secrets and inline URL credentials masked before anything reaches
      disk or an export. Pattern-based, so `data/` stays sensitive regardless.
- [x] **ESLint** flat config + Prettier available opt-in.
- [x] **85 tests** — 52 unit + 33 E2E — plus lint and a smoke stress run in CI.
- [x] **Cross-platform** — `start.sh`, and hook-installer verification on Ubuntu and macOS in CI.
- [x] **Dockerfile** for a shared viewer instance.
- [x] **WebSocket heartbeat** (30 s ping/pong) reaps half-open sockets.

### v1.0.0 / v1.0.1 — desktop app (2026-07-18)

- [x] **Tray-resident Electron app**, Windows/macOS/Linux, adopting an already-running server
      rather than fighting for the port.
- [x] **Multi-platform release pipeline** — installers built on GitHub runners and attached
      to the release on a `v*` tag.
- [x] **Code-signing support** — `npm run make-cert` plus [SIGNING.md](SIGNING.md) on what
      public signing actually costs.
