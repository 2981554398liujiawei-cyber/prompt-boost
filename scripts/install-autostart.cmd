@echo off
setlocal
rem ============================================================
rem  Prompt Boost - install autostart (current user Startup)
rem  Creates a .lnk shortcut -> scripts\launch-prompt-boost.vbs
rem ============================================================
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%~dp0launch-prompt-boost.vbs"
set "LNK=%STARTUP%\Prompt Boost Local Agent.lnk"

if not exist "%VBS%" (
  echo [ERROR] VBS not found: %VBS%
  exit /b 1
)
if not exist "%STARTUP%" (
  echo [ERROR] Startup folder not found: %STARTUP%
  exit /b 1
)

cscript //nologo "%~dp0install-autostart.vbs" "%VBS%" "%LNK%"
echo.
echo Autostart installed: %LNK%
echo Prompt Boost local agent will start automatically at next login (no window).
pause
