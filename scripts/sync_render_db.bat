@echo off
setlocal

rem Sync Render PostgreSQL -> local PostgreSQL (dump + restore)
set "PGCLIENTENCODING=UTF8"

rem ---------------- URL detection ----------------
set "REMOTE_DB_URL=%RENDER_DATABASE_URL%"
if "%REMOTE_DB_URL%"=="" set "REMOTE_DB_URL=postgresql://wj_report_db_user:Sr7tduxsvyuVfh1wK1LlKf8Ir3YQlFCq@dpg-d1e8l895pdvs73bpvh90-a.oregon-postgres.render.com/wj_report_db"
if "%REMOTE_DB_URL%"=="" (
  echo [ERROR] Remote DB URL missing.
  exit /b 1
)

set "LOCAL_DB_URL=%LOCAL_DATABASE_URL%"
if "%LOCAL_DB_URL%"=="" set "LOCAL_DB_URL=%DATABASE_URL%"
if "%LOCAL_DB_URL%"=="" set "LOCAL_DB_URL=%INTERNAL_DATABASE_URL%"
if "%LOCAL_DB_URL%"=="" (
  set "ENV_FILE=%~dp0..\backend\.env"
  if exist "%ENV_FILE%" (
    for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b /i "DATABASE_URL=" "%ENV_FILE%"`) do set "LOCAL_DB_URL=%%B"
  )
)
if "%LOCAL_DB_URL%"=="" set "LOCAL_DB_URL=postgresql://postgres:postgres@localhost:5432/wj_report_db"
if "%LOCAL_DB_URL%"=="" (
  echo [ERROR] Local DB URL is not set.
  exit /b 1
)

rem block sqlite target
if /i "%LOCAL_DB_URL:~0,7%"=="sqlite:/" (
  echo [ERROR] LOCAL_DB_URL points to SQLite; cannot restore Postgres dump into SQLite.
  exit /b 1
)

rem escape ampersand for cmd
set "REMOTE_DB_URL_ESC=%REMOTE_DB_URL:^&=^&%"
set "LOCAL_DB_URL_ESC=%LOCAL_DB_URL:^&=^&%"

rem ---------------- locate pg binaries ----------------
set "PG_DUMP="
set "PG_RESTORE="
set "PSQL="
if exist "%ProgramFiles%\PostgreSQL\16\bin\pg_dump.exe" (
  set "PG_DUMP=%ProgramFiles%\PostgreSQL\16\bin\pg_dump.exe"
  set "PG_RESTORE=%ProgramFiles%\PostgreSQL\16\bin\pg_restore.exe"
  set "PSQL=%ProgramFiles%\PostgreSQL\16\bin\psql.exe"
) else if exist "%ProgramFiles%\PostgreSQL\18\bin\pg_dump.exe" (
  set "PG_DUMP=%ProgramFiles%\PostgreSQL\18\bin\pg_dump.exe"
  set "PG_RESTORE=%ProgramFiles%\PostgreSQL\18\bin\pg_restore.exe"
  set "PSQL=%ProgramFiles%\PostgreSQL\18\bin\psql.exe"
) else if exist "%ProgramFiles%\PostgreSQL\17\bin\pg_dump.exe" (
  set "PG_DUMP=%ProgramFiles%\PostgreSQL\17\bin\pg_dump.exe"
  set "PG_RESTORE=%ProgramFiles%\PostgreSQL\17\bin\pg_restore.exe"
  set "PSQL=%ProgramFiles%\PostgreSQL\17\bin\psql.exe"
) else if exist "%ProgramFiles%\PostgreSQL\15\bin\pg_dump.exe" (
  set "PG_DUMP=%ProgramFiles%\PostgreSQL\15\bin\pg_dump.exe"
  set "PG_RESTORE=%ProgramFiles%\PostgreSQL\15\bin\pg_restore.exe"
  set "PSQL=%ProgramFiles%\PostgreSQL\15\bin\psql.exe"
) else if exist "%ProgramFiles%\PostgreSQL\14\bin\pg_dump.exe" (
  set "PG_DUMP=%ProgramFiles%\PostgreSQL\14\bin\pg_dump.exe"
  set "PG_RESTORE=%ProgramFiles%\PostgreSQL\14\bin\pg_restore.exe"
  set "PSQL=%ProgramFiles%\PostgreSQL\14\bin\psql.exe"
) else (
  set "PG_DUMP=pg_dump"
  set "PG_RESTORE=pg_restore"
  set "PSQL=psql"
)

rem validate binaries
if not "%PG_DUMP%"=="pg_dump" (
  if not exist "%PG_DUMP%" (
    echo [ERROR] pg_dump not found at %PG_DUMP%.
    exit /b 1
  )
) else (
  where pg_dump >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] pg_dump not found. Ensure PostgreSQL client tools are on PATH.
    exit /b 1
  )
)

if not "%PG_RESTORE%"=="pg_restore" (
  if not exist "%PG_RESTORE%" (
    echo [ERROR] pg_restore not found at %PG_RESTORE%.
    exit /b 1
  )
) else (
  where pg_restore >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] pg_restore not found. Ensure PostgreSQL client tools are on PATH.
    exit /b 1
  )
)

if not "%PSQL%"=="psql" (
  if not exist "%PSQL%" (
    echo [ERROR] psql not found at %PSQL%.
    exit /b 1
  )
) else (
  where psql >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] psql not found. Ensure PostgreSQL client tools are on PATH.
    exit /b 1
  )
)

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%i"
set "BACKUP_DIR=%~dp0..\backups\render"
for %%i in ("%BACKUP_DIR%") do set "BACKUP_DIR=%%~fi"
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"
set "BACKUP_FILE=%BACKUP_DIR%\render_%TS%.dump"

echo [INFO] Dumping remote DB -> %BACKUP_FILE%
"%PG_DUMP%" --format=custom --no-owner --no-acl --file "%BACKUP_FILE%" --dbname "%REMOTE_DB_URL_ESC%"
if errorlevel 1 (
  echo [ERROR] pg_dump failed.
  exit /b 1
)

if "%SYNC_SKIP_RESTORE%"=="1" (
  echo [INFO] SYNC_SKIP_RESTORE=1 set. Skipping restore.
  exit /b 0
)

echo [WARN] This will overwrite the local database at LOCAL_DB_URL.
rem Default to proceed; set SYNC_ASSUME_YES=0 to abort interactively
if "%SYNC_ASSUME_YES%"=="0" (
  choice /m "Continue with restore" /c YN /n
  if errorlevel 2 (
    echo [INFO] Restore canceled.
    exit /b 0
  )
)

:do_restore
echo [INFO] Terminating active local sessions...
"%PSQL%" --dbname "%LOCAL_DB_URL_ESC%" --set ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid();" >nul 2>nul

echo [INFO] Restoring into local DB...
"%PG_RESTORE%" --clean --if-exists --no-owner --no-acl --exit-on-error --single-transaction --dbname "%LOCAL_DB_URL_ESC%" "%BACKUP_FILE%"
if errorlevel 1 (
  echo [ERROR] pg_restore failed.
  exit /b 1
)

echo [INFO] Done.
