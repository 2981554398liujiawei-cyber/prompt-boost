@echo off
setlocal
rem ============================================================
rem  Prompt Boost - remove autostart
rem  Deletes "Prompt Boost Local Agent.lnk" from Startup folder.
rem ============================================================
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Prompt Boost Local Agent.lnk"

if not exist "%LNK%" (
  echo Autostart shortcut not found (already removed): %LNK%
) else (
  del /f /q "%LNK%"
  echo Autostart removed: %LNK%
)
pause
