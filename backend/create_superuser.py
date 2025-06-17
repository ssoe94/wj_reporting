#!/usr/bin/env python
"""
Django Superuser 자동 생성 스크립트
환경변수에서 superuser 정보를 읽어와 자동으로 생성합니다.
"""
import os
import django
from decouple import config

# Django 설정 로드
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.contrib.auth import get_user_model

def create_superuser():
    """환경변수에서 정보를 읽어 superuser를 생성합니다."""
    User = get_user_model()
    
    # 환경변수에서 superuser 정보 읽기
    username = config('DJANGO_SU_NAME', default='admin')
    email = config('DJANGO_SU_EMAIL', default='admin@example.com')
    password = config('DJANGO_SU_PASSWORD', default='admin1234')
    
    # superuser가 이미 존재하는지 확인
    if not User.objects.filter(username=username).exists():
        print(f"Creating superuser: {username}")
        User.objects.create_superuser(
            username=username,
            email=email,
            password=password
        )
        print(f"Superuser '{username}' created successfully!")
    else:
        print(f"Superuser '{username}' already exists.")

if __name__ == '__main__':
    create_superuser() 