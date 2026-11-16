@echo off
setlocal DisableDelayedExpansion
"%~dp0portable.cmd" remove-autostart %*
