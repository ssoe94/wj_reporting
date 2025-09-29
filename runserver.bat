@echo off
:: Change to the project root directory
cd /d "d:\develop\production-site"

echo Starting Django server...
start "Django Server" backend\venv\Scripts\python.exe backend\manage.py runserver 0.0.0.0:8000

echo Starting frontend server...
cd /d "d:\develop\production-site\frontend"
start "Frontend Server" npm run dev
