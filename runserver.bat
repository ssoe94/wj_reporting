@echo off
:: Change to the directory where this script is located
cd /d "%~dp0"

echo ========================================================
echo Starting WJ Reporting System...
echo ========================================================
echo.
echo [1/3] Starting PostgreSQL (local)
call :start_postgres

echo [2/3] Starting Backend (Django) on http://localhost:8000
start "Django Server" backend\venv\Scripts\python.exe backend\manage.py runserver 0.0.0.0:8000

echo [3/3] Starting Frontend (Vite) on http://localhost:5173
cd /d "%~dp0frontend"
start "Frontend Server" npm run dev

echo.
echo ========================================================
echo Both servers are starting in separate windows.
echo.
echo Access the site at:
echo    http://localhost:5173
echo.
echo (Backend API is at http://localhost:8000)
echo ========================================================
echo.
echo Press any key to close this launcher window...
pause
goto :eof

:start_postgres
set "PG_SERVICE="
for /f %%S in ('powershell -NoProfile -Command "Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Name"') do set "PG_SERVICE=%%S"
if defined PG_SERVICE (
  powershell -NoProfile -Command "if ((Get-Service -Name '%PG_SERVICE%').Status -ne 'Running') { Start-Service -Name '%PG_SERVICE%' }"
  if errorlevel 1 echo [WARN] Failed to start PostgreSQL service %PG_SERVICE%.
  goto :eof
)

where pg_ctl >nul 2>nul
if errorlevel 1 (
  echo [WARN] PostgreSQL service not found and pg_ctl is not on PATH.
  echo [WARN] Start PostgreSQL manually before using the app.
  goto :eof
)

set "PGDATA_DIR=%PGDATA%"
if not "%PGDATA_DIR%"=="" goto :pgdata_ready

for %%D in ( ^
  "%ProgramFiles%\\PostgreSQL\\17\\data" ^
  "%ProgramFiles%\\PostgreSQL\\16\\data" ^
  "%ProgramFiles%\\PostgreSQL\\15\\data" ^
  "%ProgramFiles%\\PostgreSQL\\14\\data" ^
  "%ProgramFiles(x86)%\\PostgreSQL\\16\\data" ^
) do (
  if exist "%%~D\\PG_VERSION" (
    set "PGDATA_DIR=%%~D"
    goto :pgdata_ready
  )
)

:pgdata_ready
if "%PGDATA_DIR%"=="" (
  echo [WARN] PGDATA is not set and no default data directory was found.
  echo [WARN] Set PGDATA and re-run, or start PostgreSQL manually.
  goto :eof
)

if not exist "%~dp0logs" mkdir "%~dp0logs"
pg_ctl -D "%PGDATA_DIR%" -l "%~dp0logs\\postgres.log" start
if errorlevel 1 (
  echo [WARN] pg_ctl start failed. Check %~dp0logs\\postgres.log
)
goto :eof
