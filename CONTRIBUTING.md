# Contributing to ClaudeLens

Thanks for being here. ClaudeLens is a read-only live map & timeline debugger for
Claude Code / Agent SDK multi-agent runs, and it's MIT licensed — issues, ideas and pull
requests are all welcome.

## Quick start

```bash
git clone https://github.com/architonixlabs/claude-lens
cd claude-lens
npm install
npm run demo          # runs a synthetic multi-agent session on a loop
#   → open http://localhost:4317
```

Requires **Node 18+**. To capture your own live sessions instead of the demo:

```bash
npm run install-hooks   # wires the Claude Code hooks into ~/.claude/settings.json
npm start               # or: start.bat (Windows) / ./start.sh (macOS, Linux)
```

## Before you open a pull request

Run the same checks CI runs — all three must pass:

```bash
npm run lint          # ESLint (flat config), zero warnings
npm run test:unit     # node --test — the fast unit suites
npm test              # Playwright end-to-end (needs: npx playwright install chromium)
```

`npm run test:all` runs lint + unit + E2E in one go.

## What makes a change easy to accept

- **A test for the behaviour you changed.** The bug that inspired much of the analysis
  layer — loop detection keying on a file path instead of content — survived because the
  tests only ever exercised the happy path. New logic needs a test that would fail without it.
- **Keep the layering.** `server/normalize.js` is the single source of truth that turns hook
  payloads into events; `server/analysis.js` turns a session into a judgement with pure
  functions. Both the live hook path and the demo simulator run through the *same* normalizer,
  so a change there is exercised by both. Renderers (the web UI, the desktop app, the HTTP
  API) consume that model — they shouldn't reimplement it.
- **Match the surrounding style.** The code is compact and hand-formatted (one-line accessors,
  aligned comments). ESLint is the gate; Prettier is available (`npm run format`) but not
  enforced, so don't reformat files you're not otherwise touching.
- **Respect the guarantees.** ClaudeLens is **read-only** — it never sends anything back into a
  session. Credentials are **redacted before anything hits disk**. Don't add a feature that
  breaks either; if you think you need to, open an issue first so we can talk about it.
- **Don't claim precision you don't have.** Per-agent effort is time and calls, not tokens,
  because hook payloads carry no per-tool token counts — inventing a split would be worse than
  omitting it. Hold that line for any new metric.

## Reporting a bug

Open an issue with the template. The single most useful thing you can attach is an **exported
session** (the ⇩ button in the UI, or `GET /api/export?session=<id>`) — it replays through the
normalizer exactly, so we can reproduce what you saw. Redaction runs on export, so it's safe to
share, but skim it first.

## Project layout

See the "Project layout" section of the [README](README.md) — every file has a one-line note
on what it owns.

## Releases

Maintainers cut releases by pushing a `v*` tag; `.github/workflows/release.yml` builds signed-if-
configured installers for all three platforms and attaches them, plus the auto-update metadata.
See [SIGNING.md](SIGNING.md) for the code-signing and build details.

## Code of conduct

Be decent. Assume good faith, critique the code and not the person, and keep it welcoming for
people who are new to the codebase or to open source.
