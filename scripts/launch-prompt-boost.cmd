@echo off
setlocal
rem ============================================================
rem  Prompt Boost local agent - autostart launcher (background)
rem  Called by launch-prompt-boost.vbs with a hidden window.
rem  Requires: node on PATH (falls back to default install path).
rem  Exits silently if already running (port 8787 LISTENING).
rem
rem  DATA: all paths are pinned to apps\local-agent\data via env
rem  vars (LOCAL_AGENT_DATA_DIR etc.) so the service always uses
rem  the SAME data dir as "pnpm agent:start" regardless of cwd.
rem ============================================================
set "AGENT_DIR=%~dp0..\apps\local-agent"
set "DATA_DIR=%AGENT_DIR%\data"

if not exist "%AGENT_DIR%\dist\server.js" exit /b 1

netstat -ano | findstr ":8787" | findstr "LISTENING" >nul
if %errorlevel% equ 0 exit /b 0

set "NODE_EXE=node"
where node >nul 2>&1
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
)

if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

rem Pin every data path to the real data dir (same as pnpm agent:start).
set "LOCAL_AGENT_DATA_DIR=%DATA_DIR%"
set "LOCAL_AGENT_DB_PATH=%DATA_DIR%\prompt-boost.db"
set "LOCAL_AGENT_VAULT_PATH=%DATA_DIR%\vault.enc.json"
set "LOCAL_AGENT_MASTER_KEY_PATH=%DATA_DIR%\.vault-master-key"
set "LOCAL_AGENT_AUTH_TOKEN_FILE=%DATA_DIR%\.auth-token"

"%NODE_EXE%" "%AGENT_DIR%\dist\server.js" >> "%DATA_DIR%\autostart.log" 2>&1
