# 환경변수 설정 가이드

## 로컬 개발 환경 설정

1. `backend` 디렉토리에 `.env` 파일을 생성하세요:

```bash
cd backend
touch .env
```

2. `.env` 파일에 다음 내용을 추가하세요:

```env
# Django Superuser 정보
DJANGO_SU_NAME=admin
DJANGO_SU_EMAIL=admin@example.com
DJANGO_SU_PASSWORD=your_secure_password_here

# Django 설정
SECRET_KEY=your-secret-key-here
DEBUG=True

# Render 환경변수 (로컬에서는 필요없음)
# RENDER_EXTERNAL_HOSTNAME=your-app.onrender.com
```

## Render 배포 환경 설정

Render 대시보드에서 다음 환경변수를 설정하세요:

1. **Environment Variables** 섹션으로 이동
2. 다음 변수들을 추가:
   - `DJANGO_SU_NAME`: 관리자 사용자명 (예: admin)
   - `DJANGO_SU_EMAIL`: 관리자 이메일 (예: admin@example.com)
   - `DJANGO_SU_PASSWORD`: 안전한 비밀번호
   - `SECRET_KEY`: Django 시크릿 키 (보안을 위해 새로 생성하세요)
   - `DEBUG`: False (프로덕션 환경)

## Superuser 생성 테스트

로컬에서 superuser 생성을 테스트하려면:

```bash
python create_superuser.py
```

또는 Django shell을 사용하여:

```bash
echo "
from django.contrib.auth import get_user_model
from decouple import config
User = get_user_model()
if not User.objects.filter(username=config('DJANGO_SU_NAME')).exists():
    User.objects.create_superuser(
        config('DJANGO_SU_NAME'),
        config('DJANGO_SU_EMAIL'),
        config('DJANGO_SU_PASSWORD')
    )
" | python manage.py shell
```

## 보안 주의사항

- `.env` 파일은 절대 Git에 커밋하지 마세요
- 프로덕션 환경에서는 강력한 비밀번호를 사용하세요
- `SECRET_KEY`는 각 환경마다 다르게 설정하세요 