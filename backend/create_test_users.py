#!/usr/bin/env python
import os
import sys
import django

# Django 설정
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.contrib.auth.models import User, Group
from django.contrib.auth.hashers import make_password

def create_test_users():
    # 그룹 생성
    editor_group, created = Group.objects.get_or_create(name='editor')
    viewer_group, created = Group.objects.get_or_create(name='viewer')
    
    # 관리자 계정
    admin_user, created = User.objects.get_or_create(
        username='lizairong',
        defaults={
            'email': 'lizairong@example.com',
            'password': make_password('admin123'),
            'is_staff': True,
            'is_superuser': True,
        }
    )
    if created:
        print(f"관리자 계정 생성: lizairong / admin123")
    else:
        print(f"관리자 계정이 이미 존재합니다: lizairong")
    
    # 편집자 계정
    editor_user, created = User.objects.get_or_create(
        username='editor',
        defaults={
            'email': 'editor@example.com',
            'password': make_password('editor123'),
            'is_staff': False,
        }
    )
    if created:
        editor_user.groups.add(editor_group)
        print(f"편집자 계정 생성: editor / editor123")
    else:
        print(f"편집자 계정이 이미 존재합니다: editor")
    
    # 조회자 계정
    viewer_user, created = User.objects.get_or_create(
        username='viewer',
        defaults={
            'email': 'viewer@example.com',
            'password': make_password('viewer123'),
            'is_staff': False,
        }
    )
    if created:
        viewer_user.groups.add(viewer_group)
        print(f"조회자 계정 생성: viewer / viewer123")
    else:
        print(f"조회자 계정이 이미 존재합니다: viewer")
    
    print("\n=== 테스트 계정 정보 ===")
    print("관리자: lizairong / admin123")
    print("편집자: editor / editor123") 
    print("조회자: viewer / viewer123")

if __name__ == '__main__':
    create_test_users() 