@echo off
setlocal
set "NODE_OPTIONS="
set "NODE_PATH="
set "NODE=%~dp0..\src-tauri\binaries\node.exe"
if exist "%NODE%" goto bundled
where node.exe >nul 2>nul
if errorlevel 1 (
  echo No bundled or installed Node.js found. Prepare the app runtime first. 1>&2
  exit /b 3
)
node.exe "%~dp0verify-github-pages.mjs"
exit /b %errorlevel%
:bundled
"%NODE%" "%~dp0verify-github-pages.mjs"
exit /b %errorlevel%
