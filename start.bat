@echo off
setlocal
cd /d "%~dp0"

REM ===========================================================================
REM  Agent Constellation launcher
REM    start.bat        - live mode (captures real Claude Code sessions)
REM    start.bat demo   - demo mode (loops sample multi-agent sessions)
REM  Override the port:  set PORT=5000 && start.bat
REM ===========================================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js was not found on PATH.
  echo     Install Node 18+ from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [*] Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 (
    echo [x] npm install failed.
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set "PORT=4317"

REM free the port: kill anything already listening on it (e.g. an old instance)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  echo [*] Port %PORT% in use by PID %%p - stopping it...
  taskkill /PID %%p /F >nul 2>nul
)

set "MODE="
if /I "%~1"=="demo" set "MODE=--demo"

echo.
echo   Agent Constellation  -^>  http://localhost:%PORT%
if defined MODE (
  echo   Mode: DEMO ^(looping sample sessions^)
) else (
  echo   Mode: LIVE ^(awaiting Claude Code hooks^)
  echo   Tip: run  npm run install-hooks  once so your sessions show up here.
)
echo   Press Ctrl+C to stop.
echo.

REM open the browser a couple of seconds after the server starts listening
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%PORT%'"

node server\index.js %MODE%

endlocal
