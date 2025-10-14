# 🚀 배포 가이드

## 빠른 시작

### 배포 전
```bash
# 1. 릴리즈 체크리스트 실행
bash scripts/release-checklist.sh

# 2. 모든 체크 통과 확인
# ✓ VITE_API_BASE_URL 설정
# ✓ render.yaml 라우팅 규칙
# ✓ Django 미들웨어 활성화
# ✓ CORS 설정
```

### 배포
```bash
git push origin main
```

### 배포 후
```bash
# 1. 빠른 스모크 테스트 (30초)
bash scripts/quick-smoke-test.sh

# 2. 전체 검증 (1분)
node scripts/verify-deployment.js

# 3. 브라우저 테스트 (선택)
# scripts/browser-test.html 열기
```

## 📋 체크리스트

### 배포 전 필수 확인
- [x] 프론트엔드 환경 변수 설정 (`frontend/.env.production`)
- [x] render.yaml 프록시 규칙 수정
- [x] Django 미들웨어 활성화
- [x] CORS/CSRF 설정 완료
- [x] 로컬 테스트 통과

### 배포 후 필수 확인
- [ ] CI smoke test 통과
- [ ] `bash scripts/quick-smoke-test.sh` 통과
- [ ] 브라우저에서 수동 확인
- [ ] 로그인 기능 테스트
- [ ] 데이터 조회 기능 테스트

## 🧪 테스트 명령어

```bash
# 빠른 스모크 테스트
npm run test:smoke

# 전체 배포 검증
npm run verify:deployment

# 릴리즈 체크리스트
npm run release:check

# E2E 테스트
npm run test:e2e

# E2E UI 모드
npm run test:e2e:ui
```

## 🔍 문제 해결

### HTML 대신 JSON을 받아야 하는 경우
```bash
# 1. Content-Type 확인
curl -sI https://wj-reporting.onrender.com/api/health/ | grep -i content-type

# 2. 응답 본문 확인
curl -s https://wj-reporting.onrender.com/api/health/ | jq .

# 3. 404도 JSON인지 확인
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  https://wj-reporting.onrender.com/api/_404_check
```

### 상세 가이드
- `TROUBLESHOOTING.md` - 증상별 해결 방법
- `DEPLOYMENT_CHECKLIST.md` - 상세 체크리스트
- `TESTING.md` - 테스트 가이드

## 📁 주요 파일

### 설정 파일
- `render.yaml` - Render 배포 설정
- `frontend/static.json` - 정적 사이트 라우팅
- `frontend/.env.production` - 프론트엔드 환경 변수
- `backend/config/settings.py` - Django 설정

### 미들웨어/핸들러
- `backend/config/middleware.py` - API 404 가드, 캐시 방지
- `backend/config/exceptions.py` - DRF 예외 핸들러

### 유틸리티
- `frontend/src/utils/errorHandler.ts` - 에러 핸들링
- `frontend/src/utils/requestValidator.ts` - 파라미터 검증

### 테스트/검증
- `scripts/quick-smoke-test.sh` - 빠른 스모크 테스트
- `scripts/verify-deployment.js` - 전체 배포 검증
- `scripts/release-checklist.sh` - 릴리즈 체크리스트
- `tests/e2e/api-routing.spec.ts` - E2E 테스트
- `.github/workflows/api-smoke-test.yml` - CI 자동 테스트

## 🎯 핵심 개선사항

### 1. API 라우팅 수정
- `/api/*` 경로 중복 방지
- 올바른 프록시 설정
- SPA 라우팅 분리

### 2. 에러 핸들링
- 404 에러도 JSON 반환
- HTML 응답 감지 및 차단
- 사용자 친화적 에러 메시지

### 3. 보안 강화
- CORS/CSRF 설정
- 쿠키 보안 설정
- 캐시 방지 헤더

### 4. 검증 자동화
- CI/CD 통합
- 자동 스모크 테스트
- E2E 테스트 커버리지

## 🔄 배포 플로우

```
┌─────────────────┐
│  코드 변경       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 릴리즈 체크리스트│ ← bash scripts/release-checklist.sh
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Git Push       │ ← git push origin main
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Render 배포     │ ← 자동 빌드 & 배포
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ CI Smoke Test   │ ← GitHub Actions 자동 실행
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 수동 검증        │ ← bash scripts/quick-smoke-test.sh
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 배포 완료 ✓     │
└─────────────────┘
```

## 📞 지원

문제가 지속되면:
1. `TROUBLESHOOTING.md` 참고
2. 검증 스크립트 출력 확인
3. Render 배포 로그 확인
4. 브라우저 개발자 도구 확인

## 📚 추가 문서

- `DEPLOYMENT_SOLUTION.md` - 전체 솔루션 요약
- `DEPLOYMENT_CHECKLIST.md` - 상세 체크리스트
- `TROUBLESHOOTING.md` - 문제 해결 가이드
- `TESTING.md` - 테스트 가이드
