@echo off
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1
set PYTHONDONTWRITEBYTECODE=1
where py >nul 2>nul
if not errorlevel 1 (
  py -3 server\server.py --open-browser
) else (
  python server\server.py --open-browser
)
if errorlevel 1 pause
