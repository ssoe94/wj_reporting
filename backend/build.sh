#!/usr/bin/env bash
# Render 배포시 실행되는 빌드 스크립트

# 빌드 실패시 스크립트 종료
set -o errexit

# 패키지 설치
pip install -r requirements.txt

# 정적 파일 수집 (필요한 경우)
# python manage.py collectstatic --no-input

# 데이터베이스 마이그레이션
python manage.py makemigrations
python manage.py migrate

# 제품/품목 마스터 데이터 적재
python manage.py import_partspecs data/c_table.xlsx || true
python manage.py import_products || true

# Superuser 생성
python create_superuser.py

echo "Build completed successfully!" 