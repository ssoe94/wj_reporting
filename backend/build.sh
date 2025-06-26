#!/usr/bin/env bash
# Render 배포시 실행되는 빌드 스크립트

# 빌드 실패시 스크립트 종료
set -o errexit

# 패키지 설치
pip install -r requirements.txt

# 정적 파일 수집 (필요한 경우)
# python manage.py collectstatic --no-input

# 빌드 단계에서는 DB 접근을 건너뛰고, 런타임 start-command 에서 migrate 및 데이터 적재를 수행합니다.

echo "Build completed successfully!" 