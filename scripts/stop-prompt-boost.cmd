@echo off
setlocal
rem ============================================================
rem  Prompt Boost local agent - stop
rem  Stops only the PID recorded by Prompt Boost after verifying its command line.
rem  Does NOT delete data dir or rotate the token.
rem ============================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-prompt-boost.ps1"
if errorlevel 1 (
  echo [ERROR] Refused or failed to stop the service safely.
  pause
  exit /b 1
)
echo.
echo Tips:
echo   pnpm agent:token:show    - show the local auth token
echo   pnpm agent:token:rotate  - rotate the local auth token
pause
