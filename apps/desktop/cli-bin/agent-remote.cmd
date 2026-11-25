@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
set "NODE_NO_WARNINGS=1"
set "APP_DIR=%~dp0..\.."
set "CLI_ENTRY=%~dp0..\app\dist\cli-entry.js"
set "EXE="
if exist "%APP_DIR%\Agent Remote.exe" set "EXE=%APP_DIR%\Agent Remote.exe"
if not defined EXE if exist "%APP_DIR%\agent-remote.exe" set "EXE=%APP_DIR%\agent-remote.exe"
if not defined EXE (
  echo agent-remote desktop executable not found in "%APP_DIR%" >&2
  exit /b 1
)
"%EXE%" "%CLI_ENTRY%" %*
exit /b %ERRORLEVEL%
