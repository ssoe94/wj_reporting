@echo off
setlocal
rem Place this file at the release root beside python\ and field_agent\.
cd /d "%~dp0" || exit /b 1
set "WJ_AGENT_HOME=%CD%"
set "WJ_AGENT_PYTHON=%WJ_AGENT_HOME%\python\python.exe"
set "WJ_AGENT_DATA=%~1"
if not defined WJ_AGENT_DATA set "WJ_AGENT_DATA=%WJ_AGENT_HOME%\..\data"
set "WJ_AGENT_URL=http://127.0.0.1:8769"
set "PYTHONNOUSERSITE=1"
set "PYTHONPATH="

if not exist "%WJ_AGENT_PYTHON%" (
  echo Packaged runtime missing. Expected python\python.exe.
  exit /b 1
)

start "WJ Field Agent" "%WJ_AGENT_PYTHON%" -m field_agent run --data-dir "%WJ_AGENT_DATA%" --port 8769
if errorlevel 1 exit /b 1

rem Use the local readiness endpoint without any system HTTP proxy.
for /l %%I in (1,1,12) do (
  "%WJ_AGENT_PYTHON%" -c "from urllib.request import build_opener,ProxyHandler; import json; s=json.load(build_opener(ProxyHandler({})).open('%WJ_AGENT_URL%/api/status',timeout=1)); assert s.get('station_id') and s.get('agent_version')" >nul 2>&1
  if not errorlevel 1 goto browser
  "%WJ_AGENT_PYTHON%" -c "import time; time.sleep(0.5)"
)
echo Local status did not become ready. Check the agent console.
exit /b 1

:browser
set "WJ_AGENT_BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "WJ_AGENT_BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined WJ_AGENT_BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "WJ_AGENT_BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined WJ_AGENT_BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "WJ_AGENT_BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined WJ_AGENT_BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "WJ_AGENT_BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined WJ_AGENT_BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "WJ_AGENT_BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined WJ_AGENT_BROWSER (
  echo Open %WJ_AGENT_URL% in Chrome or Edge.
  exit /b 1
)
start "" "%WJ_AGENT_BROWSER%" --app="%WJ_AGENT_URL%"
