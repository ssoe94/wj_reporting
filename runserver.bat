@echo off
cd /d d:\develop\production-site\backend
start "" venv\Scripts\python.exe manage.py runserver 0.0.0.0:8000

cd /d d:\develop\production-site\frontend
start "" npm run dev
