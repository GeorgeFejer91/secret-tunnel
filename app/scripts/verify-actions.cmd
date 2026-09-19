@echo off
setlocal
pushd "%~dp0.." || exit /b 1
node scripts\verify-actions.mjs %*
set "RESULT=%ERRORLEVEL%"
popd
if "%~1"=="" pause
exit /b %RESULT%
