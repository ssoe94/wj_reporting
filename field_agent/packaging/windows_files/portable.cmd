@echo off
setlocal DisableDelayedExpansion
set "PYTHONPATH="
set "PYTHONHOME="
set "PYTHONDONTWRITEBYTECODE=1"
"%SystemRoot%\System32\cscript.exe" //NoLogo "%~dp0dispatch.vbs" %*
exit /b %ERRORLEVEL%
