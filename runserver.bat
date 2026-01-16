@echo off
:: Change to the directory where this script is located
cd /d "%~dp0"

echo ========================================================
echo Starting WJ Reporting System...
echo ========================================================
echo.
echo [1/2] Starting Backend (Django) on http://localhost:8000
start "Django Server" backend\venv\Scripts\python.exe backend\manage.py runserver 0.0.0.0:8000

echo [2/2] Starting Frontend (Vite) on http://localhost:5173
cd frontend
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
