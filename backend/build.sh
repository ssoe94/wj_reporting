#!/usr/bin/env bash
# Render 배포시 실행되는 빌드 스크립트

# 빌드 실패시 스크립트 종료
set -o errexit

# Frontend 빌드
echo "Building frontend..."
cd ../frontend
npm ci
npm run build
cd ../backend
echo "Frontend build complete."

# Backend 패키지 설치
pip install -r requirements.txt

# 정적 파일 수집 (프론트엔드 빌드 결과물 포함)
python manage.py collectstatic --no-input

# 빌드 단계에서는 DB 접근을 건너뛰고, 런타임 start-command 에서 migrate 및 데이터 적재를 수행합니다.

echo "Build completed successfully!"