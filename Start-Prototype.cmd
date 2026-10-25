@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node.js 20 or newer.
  pause
  exit /b 1
)
node "%~dp0prototype\cli.mjs" tui
if errorlevel 1 pause
