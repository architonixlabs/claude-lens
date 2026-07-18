#!/usr/bin/env bash
# =============================================================================
#  ClaudeLens launcher (macOS / Linux) — mirrors start.bat
#    ./start.sh        live mode (captures real Claude Code sessions)
#    ./start.sh demo   demo mode (loops sample multi-agent sessions)
#  Override the port:  PORT=5000 ./start.sh
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[x] Node.js was not found on PATH."
  echo "    Install Node 18+ from https://nodejs.org and run this again."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[*] Installing dependencies (first run only)..."
  npm install
fi

PORT="${PORT:-4317}"

# Free the port: stop anything already listening on it (e.g. an old instance).
if command -v lsof >/dev/null 2>&1; then
  pids="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "[*] Port $PORT in use by PID(s) $pids - stopping them..."
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    sleep 1
  fi
fi

MODE=""
if [ "${1:-}" = "demo" ]; then MODE="--demo"; fi

echo
echo "  ClaudeLens  ->  http://localhost:$PORT"
if [ -n "$MODE" ]; then
  echo "  Mode: DEMO (looping sample sessions)"
else
  echo "  Mode: LIVE (awaiting Claude Code hooks)"
  echo "  Tip: run  npm run install-hooks  once so your sessions show up here."
fi
echo "  Press Ctrl+C to stop."
echo

# Open the browser a couple of seconds after the server starts listening.
( sleep 2
  if command -v open >/dev/null 2>&1; then open "http://localhost:$PORT"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$PORT" >/dev/null 2>&1
  fi ) &

exec node server/index.js $MODE
