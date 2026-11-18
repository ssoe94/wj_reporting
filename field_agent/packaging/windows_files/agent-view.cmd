@echo off
setlocal DisableDelayedExpansion
"%~dp0portable.cmd" start --agent-view %*
