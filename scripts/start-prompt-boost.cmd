@echo off
setlocal
rem ============================================================
rem  Prompt Boost local agent - start (foreground console)
rem  Equivalent to: pnpm agent:start
rem  Data dir: apps\local-agent\data (real data, pinned via env vars)
rem ============================================================
set "AGENT_DIR=%~dp0..\apps\local-agent"
set "DATA_DIR=%AGENT_DIR%\data"

if not exist "%AGENT_DIR%\dist\server.js" (
  echo [ERROR] Local agent not built. Run: pnpm build
  pause
  exit /b 1
)

echo ============================================================
echo   Prompt Boost local agent
echo   Listening : http://127.0.0.1:8787 (loopback only)
echo   Data dir  : %DATA_DIR%
echo   Stop      : close this window or run scripts\stop-prompt-boost.cmd
echo ============================================================
echo.

if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

rem Pin every data path to the real data dir (same as pnpm agent:start).
set "LOCAL_AGENT_DATA_DIR=%DATA_DIR%"
set "LOCAL_AGENT_DB_PATH=%DATA_DIR%\prompt-boost.db"
set "LOCAL_AGENT_VAULT_PATH=%DATA_DIR%\vault.enc.json"
set "LOCAL_AGENT_MASTER_KEY_PATH=%DATA_DIR%\.vault-master-key"
set "LOCAL_AGENT_AUTH_TOKEN_FILE=%DATA_DIR%\.auth-token"

node "%AGENT_DIR%\dist\server.js"
echo.
echo Service stopped.
pause
