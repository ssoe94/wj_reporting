# WJ Reporting System

![Test and Deploy](https://github.com/YOUR_USERNAME/YOUR_REPO/actions/workflows/test-and-deploy.yml/badge.svg)

생산 현장 데이터 리포팅 시스템

## 🚀 빠른 시작

### 배포 전
```bash
bash scripts/release-checklist.sh
```

### 배포
```bash
git push origin main
```

### 배포 후 검증
```bash
bash scripts/quick-smoke-test.sh
```

## 📁 프로젝트 구조

```
production-site/
├── frontend/           # React + Vite 프론트엔드
├── backend/            # Django REST API
├── scripts/            # 배포 및 검증 스크립트
├── tests/              # E2E 테스트
└── .github/            # GitHub Actions 워크플로
```

## 🛠️ 기술 스택

### Frontend
- React 18
- TypeScript
- Vite
- Axios
- TailwindCSS

### Backend
- Django 5.2
- Django REST Framework
- PostgreSQL
- JWT Authentication

### Infrastructure
- Render (호스팅)
- GitHub Actions (CI/CD)

## 📚 문서

- [배포 가이드](README_DEPLOYMENT.md) - 빠른 배포 가이드
- [GitHub Actions 설정](GITHUB_SETUP.md) - CI/CD 설정 방법
- [테스트 가이드](TESTING.md) - 테스트 실행 방법
- [문제 해결](TROUBLESHOOTING.md) - 증상별 해결 방법
- [배포 체크리스트](DEPLOYMENT_CHECKLIST.md) - 상세 체크리스트
- [전체 솔루션](DEPLOYMENT_SOLUTION.md) - 아키텍처 및 솔루션

## 🧪 테스트

```bash
# 빠른 스모크 테스트
npm run test:smoke

# 전체 배포 검증
npm run verify:deployment

# E2E 테스트
npm run test:e2e

# 릴리즈 체크리스트
npm run release:check
```

## 🔄 CI/CD 파이프라인

### PR 생성 시
1. 린트 및 유닛 테스트 실행
2. 백엔드 테스트 실행
3. 현재 프로덕션 스모크 테스트
4. ✅ 통과 시 머지 가능

### main 브랜치 푸시 시
1. 모든 테스트 실행
2. ✅ 통과 시 백엔드 배포
3. 백엔드 Health Check 대기
4. 프론트엔드 배포
5. 배포 검증 (smoke test)
6. 🎉 완료!

## 🔧 개발 환경 설정

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

## 🌐 환경 변수

### Frontend (.env.production)
```bash
VITE_API_BASE_URL=/api
```

### Backend (.env)
```bash
SECRET_KEY=your-secret-key
DEBUG=False
DATABASE_URL=postgresql://...
FRONTEND_URL=https://your-frontend.onrender.com
```

## 📊 주요 기능

- ✅ 사출 기록 관리
- ✅ 조립 데이터 추적
- ✅ 재고 스냅샷
- ✅ 품질 모니터링
- ✅ 실시간 대시보드
- ✅ 권한 기반 접근 제어

## 🔐 보안

- JWT 기반 인증
- CORS/CSRF 보호
- 환경 변수로 민감 정보 관리
- HTTPS 강제
- 쿠키 보안 설정

## 🐛 문제 해결

문제가 발생하면:
1. [TROUBLESHOOTING.md](TROUBLESHOOTING.md) 참고
2. 검증 스크립트 실행: `bash scripts/quick-smoke-test.sh`
3. GitHub Actions 로그 확인
4. Render 배포 로그 확인

## 📞 지원

- 문서: 위 링크 참고
- 이슈: GitHub Issues
- 로그: Render Dashboard

## 📄 라이선스

Private Project

## 🙏 기여

1. Fork the repository
2. Create your feature branch
3. Run tests: `npm run test:e2e`
4. Commit your changes
5. Push to the branch
6. Create a Pull Request

---

Made with ❤️ for WJ Manufacturing
