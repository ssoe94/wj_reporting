# API 라우팅 문제 해결 완료

## 문제 요약
- 프론트엔드에서 `/api/*` 요청이 JSON 대신 HTML(index.html)을 반환
- 브라우저 콘솔에 "Unexpected token '<'" 에러 발생
- UI에 `undefined` 표시

## 근본 원인
1. Render 프록시 설정에서 경로 중복 또는 잘못된 라우팅
2. 404 에러 시 HTML 페이지 반환 (JSON 대신)
3. CORS/CSRF 설정 미비
4. 에러 핸들링 및 파라미터 검증 부족

## 구현된 솔루션

### A) Render IaC 설정 수정

#### 1. render.yaml (권장)
```yaml
services:
  - type: static
    name: wj_reporting
    routes:
      # API 프록시 - 경로 중복 방지
      - type: redirect
        source: /api/:path*
        destination: https://wj-reporting-backend.onrender.com/api/:path*
        status: 200
      # SPA 라우팅
      - type: rewrite
        source: /:path*
        destination: /index.html
```

#### 2. static.json (대체 방법)
```json
{
  "routes": [
    {
      "src": "/api/(.*)",
      "dest": "https://wj-reporting-backend.onrender.com/api/$1"
    },
    {
      "src": "/(.*)",
      "dest": "/index.html"
    }
  ]
}
```

### B) 프론트엔드 설정

#### 1. 환경 변수 (.env.production)
```bash
# 프록시 사용 (권장)
VITE_API_BASE_URL=/api

# 또는 절대 URL 사용
# VITE_API_BASE_URL=https://wj-reporting-backend.onrender.com/api
```

#### 2. axios 설정 개선 (src/lib/api.ts)
- 환경 변수 기반 baseURL 설정
- HTML 응답 감지 및 에러 로깅
- 상세한 에러 정보 제공
- 파라미터 유효성 검증

#### 3. 유틸리티 추가
- `src/utils/errorHandler.ts`: API 에러 핸들링
- `src/utils/requestValidator.ts`: 파라미터 검증

### C) Django 백엔드 설정

#### 1. CORS/CSRF 설정 강화
```python
# config/settings.py
CORS_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "https://wj-reporting.onrender.com",
]
CORS_ALLOW_CREDENTIALS = True

CSRF_TRUSTED_ORIGINS = [
    "http://localhost:5173",
    "https://wj-reporting.onrender.com",
]

# 프로덕션 쿠키 보안
if ENVIRONMENT == 'production':
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SESSION_COOKIE_SAMESITE = 'None'
```

#### 2. API 404 JSON 가드
- `config/middleware.py`: 
  - `APINotFoundMiddleware`: /api/* 404를 JSON으로 반환
  - `NoCacheAPIMiddleware`: API 응답 캐시 방지
- `config/exceptions.py`: DRF 커스텀 예외 핸들러

#### 3. REST Framework 설정
```python
REST_FRAMEWORK = {
    'EXCEPTION_HANDLER': 'config.exceptions.custom_exception_handler',
    'DEFAULT_RENDERER_CLASSES': [
        'rest_framework.renderers.JSONRenderer',
    ],
}
```

### D) 배포 검증 도구

#### 1. Node.js 스크립트
```bash
node scripts/verify-deployment.js
```

#### 2. Bash 스크립트
```bash
bash scripts/verify-deployment.sh
```

#### 3. 브라우저 테스트
- `scripts/browser-test.html` 파일을 브라우저에서 열기
- 자동으로 모든 엔드포인트 테스트

### E) 문서화
- `DEPLOYMENT_CHECKLIST.md`: 배포 전후 체크리스트
- `TROUBLESHOOTING.md`: 증상별 문제 해결 가이드

## 배포 절차

### 1. 로컬 테스트
```bash
# 프론트엔드 빌드
cd frontend
npm run build

# 백엔드 테스트
cd ../backend
python manage.py test
```

### 2. 커밋 및 푸시
```bash
git add -A
git commit -m "Fix API routing and error handling"
git push origin main
```

### 3. Render 배포 확인
- Render 대시보드에서 배포 로그 확인
- 자동 마이그레이션 실행 확인

### 4. 배포 후 검증
```bash
# 자동 검증
node scripts/verify-deployment.js

# 수동 검증
# 1. 브라우저에서 사이트 접속
# 2. F12 개발자 도구 열기
# 3. Network 탭에서 /api/* 요청 확인
# 4. Content-Type: application/json 확인
```

## 체크리스트

### 배포 전
- [x] render.yaml 프록시 규칙 수정
- [x] static.json 프록시 규칙 수정
- [x] 프론트엔드 환경 변수 설정
- [x] axios 에러 핸들링 개선
- [x] Django CORS/CSRF 설정
- [x] API 404 JSON 가드 추가
- [x] 파라미터 검증 유틸리티 추가
- [x] 검증 스크립트 작성
- [x] 문서화 완료

### 배포 후
- [ ] 검증 스크립트 실행
- [ ] 브라우저 개발자 도구로 확인
- [ ] 로그인 기능 테스트
- [ ] 데이터 조회 기능 테스트
- [ ] 404 에러 JSON 응답 확인
- [ ] CORS 에러 없음 확인

## 예상 결과

### 성공 시
- `/api/*` 요청이 올바른 JSON 응답 반환
- Content-Type: `application/json`
- 404 에러도 JSON 형식으로 반환
- CORS 에러 없음
- 사용자 친화적인 에러 메시지

### 실패 시
- `TROUBLESHOOTING.md` 참고
- 검증 스크립트 출력 확인
- Render 배포 로그 확인

## 주요 변경 파일

### 프론트엔드
- `frontend/.env.production` (신규)
- `frontend/src/lib/api.ts` (수정)
- `frontend/src/utils/errorHandler.ts` (신규)
- `frontend/src/utils/requestValidator.ts` (신규)
- `frontend/static.json` (신규)

### 백엔드
- `backend/config/settings.py` (수정)
- `backend/config/middleware.py` (신규)
- `backend/config/exceptions.py` (신규)

### 인프라
- `render.yaml` (수정)

### 도구 및 문서
- `scripts/verify-deployment.js` (신규)
- `scripts/verify-deployment.sh` (신규)
- `scripts/browser-test.html` (신규)
- `DEPLOYMENT_CHECKLIST.md` (신규)
- `TROUBLESHOOTING.md` (신규)

## 다음 단계

1. **즉시 배포**
   ```bash
   git push origin main
   ```

2. **배포 모니터링**
   - Render 대시보드에서 배포 진행 상황 확인
   - 빌드 로그에서 에러 확인

3. **검증 실행**
   ```bash
   node scripts/verify-deployment.js
   ```

4. **문제 발생 시**
   - `TROUBLESHOOTING.md` 참고
   - 검증 스크립트 출력 분석
   - 필요 시 롤백

## 롤백 방법

문제 발생 시 이전 안정 버전으로 롤백:

```bash
# 현재 커밋 확인
git log --oneline -5

# 이전 커밋으로 롤백
git revert HEAD
git push origin main

# 또는 강제 롤백 (주의!)
git reset --hard <안정_커밋_해시>
git push origin main --force
```

## 참고 자료

- [Render Static Site 문서](https://render.com/docs/static-sites)
- [Django CORS Headers](https://github.com/adamchainz/django-cors-headers)
- [Vite 환경 변수](https://vitejs.dev/guide/env-and-mode.html)
- [Axios 인터셉터](https://axios-http.com/docs/interceptors)

## 지원

문제가 지속되면:
1. 검증 스크립트 출력 확인
2. Render 배포 로그 확인
3. 브라우저 개발자 도구 Network/Console 탭 확인
4. `TROUBLESHOOTING.md`의 증상별 해결 방법 참고
