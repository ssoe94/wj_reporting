# 배포 체크리스트

## 배포 전 확인사항

### 1. 프론트엔드 설정
- [ ] `frontend/.env.production` 파일에 `VITE_API_BASE_URL` 설정 확인
  - 프록시 사용: `VITE_API_BASE_URL=/api`
  - 절대 URL 사용: `VITE_API_BASE_URL=https://wj-reporting-backend.onrender.com/api`
- [ ] `frontend/src/lib/api.ts`에서 환경 변수 사용 확인
- [ ] 프로덕션 빌드 실행: `npm run build`
- [ ] 빌드 아티팩트(`dist/`)에 환경 변수 반영 확인

### 2. 백엔드 설정
- [ ] `backend/config/settings.py`에서 CORS 설정 확인
  - `CORS_ALLOWED_ORIGINS`에 프론트엔드 도메인 추가
  - `CORS_ALLOW_CREDENTIALS = True` 설정
- [ ] CSRF 설정 확인
  - `CSRF_TRUSTED_ORIGINS`에 프론트엔드 도메인 추가
- [ ] 프로덕션 환경 변수 설정
  - `SESSION_COOKIE_SECURE = True`
  - `CSRF_COOKIE_SECURE = True`
  - `SESSION_COOKIE_SAMESITE = 'None'`
- [ ] 커스텀 미들웨어 활성화 확인
  - `NoCacheAPIMiddleware`
  - `APINotFoundMiddleware`
- [ ] DRF 예외 핸들러 설정 확인
  - `EXCEPTION_HANDLER = 'config.exceptions.custom_exception_handler'`

### 3. Render 설정
- [ ] `render.yaml` 또는 `frontend/static.json` 프록시 규칙 확인
  - `/api/*` 경로가 백엔드로 올바르게 프록시되는지 확인
  - 경로 중복(`/api/api/...`) 방지 확인
  - SPA 라우팅(`/*` → `/index.html`) 설정 확인
- [ ] Render 대시보드에서 환경 변수 설정
  - `DATABASE_URL`
  - `SECRET_KEY`
  - `FRONTEND_URL`
  - `RENDER_EXTERNAL_HOSTNAME`
  - 기타 필요한 환경 변수

### 4. 데이터베이스 마이그레이션
- [ ] 로컬에서 마이그레이션 파일 생성 및 테스트
- [ ] 마이그레이션 파일 커밋 및 푸시
- [ ] Render에서 자동 마이그레이션 실행 확인

## 배포 후 검증

### 1. 자동 검증 스크립트 실행
```bash
# Node.js 스크립트
node scripts/verify-deployment.js

# Bash 스크립트 (Git Bash/WSL)
bash scripts/verify-deployment.sh

# 브라우저 테스트
# scripts/browser-test.html을 브라우저에서 열기
```

### 2. 수동 검증
- [ ] 브라우저 개발자 도구 열기 (F12)
- [ ] Network 탭에서 API 요청 확인
  - `/api/*` 요청이 200 OK 반환하는지 확인
  - Content-Type이 `application/json`인지 확인
  - HTML 응답이 없는지 확인
- [ ] Console 탭에서 에러 확인
  - "Unexpected token '<'" 에러가 없는지 확인
  - CORS 에러가 없는지 확인

### 3. 기능 테스트
- [ ] 로그인 기능 테스트
- [ ] 데이터 조회 기능 테스트
- [ ] 데이터 생성/수정/삭제 기능 테스트
- [ ] 날짜 필터링 기능 테스트
- [ ] 페이지 새로고침 시 SPA 라우팅 동작 확인

### 4. 에러 처리 테스트
- [ ] 존재하지 않는 API 경로 접근 시 JSON 404 반환 확인
- [ ] 권한 없는 리소스 접근 시 JSON 403 반환 확인
- [ ] 네트워크 오류 시 사용자 친화적 메시지 표시 확인

## 문제 해결

### HTML 응답 대신 JSON을 받아야 하는 경우
1. `render.yaml` 또는 `static.json`의 프록시 규칙 확인
2. Render 대시보드에서 배포 로그 확인
3. 백엔드 URL이 올바른지 확인
4. CORS 설정 확인

### CORS 에러가 발생하는 경우
1. `backend/config/settings.py`의 `CORS_ALLOWED_ORIGINS` 확인
2. `CORS_ALLOW_CREDENTIALS = True` 설정 확인
3. 프론트엔드 도메인이 정확히 일치하는지 확인 (프로토콜, 포트 포함)

### 404 에러가 HTML로 반환되는 경우
1. `config.middleware.APINotFoundMiddleware` 활성화 확인
2. `config.exceptions.custom_exception_handler` 설정 확인
3. Django 미들웨어 순서 확인

### 환경 변수가 반영되지 않는 경우
1. Vite 환경 변수는 `VITE_` 접두사 필요
2. 빌드 시점에 환경 변수가 주입되므로 재빌드 필요
3. Render 대시보드에서 환경 변수 설정 확인

## 롤백 절차

문제 발생 시 안정 버전으로 롤백:

```bash
# 프론트엔드 롤백 (안정 커밋: 2361553)
cd frontend
git checkout 2361553
git push origin main --force

# 백엔드 롤백 (마이그레이션 제외)
cd backend
git revert <문제_커밋_해시>
git push origin main
```

## 참고 자료

- [Render Static Site 문서](https://render.com/docs/static-sites)
- [Render Web Service 문서](https://render.com/docs/web-services)
- [Django CORS 설정](https://github.com/adamchainz/django-cors-headers)
- [Vite 환경 변수](https://vitejs.dev/guide/env-and-mode.html)
