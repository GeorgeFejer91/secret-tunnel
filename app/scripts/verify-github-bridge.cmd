@echo off
setlocal
set "NODE_EXE=%~dp0..\src-tauri\binaries\node.exe"
if exist "%NODE_EXE%" goto run
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js is unavailable. Prepare the bundled runtime or install the development Node.js version.
  exit /b 2
)
set "NODE_EXE=node.exe"
:run
"%NODE_EXE%" "%~dp0verify-github-bridge.mjs" %*
exit /b %errorlevel%
