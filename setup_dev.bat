@echo off
echo ========================================
echo WJ Reporting 개발 환경 설정
echo ========================================

echo.
echo 1. Python 가상환경 생성 및 활성화...
cd backend
if not exist venv (
    python -m venv venv
)
call venv\Scripts\activate.bat

echo.
echo 2. Python 패키지 설치...
pip install -r requirements.txt

echo.
echo 3. 환경 변수 파일 확인...
if not exist .env (
    echo .env 파일이 없습니다. .env.example을 참고하여 생성해주세요.
    copy .env.example .env
    echo .env 파일을 생성했습니다. 설정을 확인해주세요.
    pause
)

echo.
echo 4. 데이터베이스 마이그레이션...
python manage.py makemigrations
python manage.py migrate

echo.
echo 5. 정적 파일 수집...
python manage.py collectstatic --noinput

cd ..

echo.
echo 6. 프론트엔드 패키지 설치...
cd frontend
npm install

echo.
echo ========================================
echo 설정 완료!
echo.
echo 개발 서버 실행:
echo   백엔드: cd backend ^&^& python manage.py runserver
echo   프론트엔드: cd frontend ^&^& npm run dev
echo ========================================
pause