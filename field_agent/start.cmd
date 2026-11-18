@echo off
setlocal DisableDelayedExpansion
rem Place at the release root beside python\ and field_agent\.
cd /d "%~dp0" || exit /b 1
set "WJ_AGENT_PYTHON=%CD%\python\python.exe"
set "WJ_AGENT_DATA=%~1"
if not defined WJ_AGENT_DATA set "WJ_AGENT_DATA=%CD%\..\data"
set "WJ_AGENT_APP_CONFIG=%~2"
set "WJ_AGENT_APP_KIND=%~3"
set "PYTHONNOUSERSITE=1"
set "PYTHONPATH="
set "PYTHONHOME="

if not exist "%WJ_AGENT_PYTHON%" (
  echo Packaged Python missing. Expected python\python.exe.
  exit /b 1
)
if not defined WJ_AGENT_APP_CONFIG goto agent
if not defined WJ_AGENT_APP_KIND set "WJ_AGENT_APP_KIND=barcode"
if /I "%WJ_AGENT_APP_KIND%"=="weigh" goto app
if /I "%WJ_AGENT_APP_KIND%"=="barcode" goto app
echo App kind must be barcode or weigh.
exit /b 1

:app
"%WJ_AGENT_PYTHON%" -m field_agent.launcher --data-dir "%WJ_AGENT_DATA%" --app-config "%WJ_AGENT_APP_CONFIG%" --app-kind "%WJ_AGENT_APP_KIND%"
exit /b %ERRORLEVEL%

:agent
if defined WJ_AGENT_APP_KIND (
  echo An app configuration file is required.
  exit /b 1
)
"%WJ_AGENT_PYTHON%" -m field_agent.launcher --data-dir "%WJ_AGENT_DATA%"
exit /b %ERRORLEVEL%
