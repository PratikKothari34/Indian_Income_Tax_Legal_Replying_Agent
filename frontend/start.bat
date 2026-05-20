@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if %ERRORLEVEL% EQU 0 (
  echo Port 5173 is already in use. Reusing the existing Vite dev server.
  npm run dev:electron
) else (
  npm run dev
)
