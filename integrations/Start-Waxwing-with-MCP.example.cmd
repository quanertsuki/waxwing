@echo off
rem Copy this file beside your DSH launcher and replace all placeholders.
set "DSH_HOME=C:\path\to\dsh-data"
cd /d "C:\path\to\deepseek-harness"
node --import tsx/esm apps/cli/src/bin.ts web --patch "C:\path\to\waxwing\integrations\waxwing-mcp.patch.json" %*
if errorlevel 1 pause
