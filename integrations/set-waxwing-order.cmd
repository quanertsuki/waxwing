@echo off
rem Edit the comma-separated list below, then run this file.
rem Magpie tries the first model, and moves to the next one when it fails.
set "ORDER=ocg/deepseek-v4.1-flash,ocg/deepseek-v4-pro,codearts/deepseek-v4.1-flash,rl2/llm-default,deepseek/deepseek-flash"
if not defined MAGPIE_CLI set "MAGPIE_CLI=magpie"
"%MAGPIE_CLI%" group set waxwing models=%ORDER%
pause
