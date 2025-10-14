# 문제 해결 가이드

## 증상별 해결 방법

### 1. "Unexpected token '<'" 에러

**증상:**
- 브라우저 콘솔에 `Unexpected token '<'` 에러 표시
- API 요청이 JSON 대신 HTML을 반환
- UI에 `undefined` 표시

**원인:**
- Render 프록시 설정이 잘못되어 `/api/*` 요청이 `index.html`로 리라이트됨
- 백엔드 URL이 잘못 설정됨
- 경로 중복 (`/api/api/...`)

**해결 방법:**

1. **프록시 설정 확인**
   ```yaml
   # render.yaml
   routes:
     - type: redirect
       source: /api/:path*
       destination: https://wj-reporting-backend.onrender.com/api/:path*
       status: 200
     - type: rewrite
       source: /:path*
       destination: /index.html
   ```

2. **static.json 확인** (사용하는 경우)
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

3. **브라우저 개발자 도구로 확인**
   - Network 탭에서 실제 요청 URL 확인
   - Response 탭에서 HTML이 반환되는지 확인
   - Headers 탭에서 Content-Type 확인

4. **검증 스크립트 실행**
   ```bash
   node scripts/verify-deployment.js
   ```

### 2. CORS 에러

**증상:**
- 브라우저 콘솔에 CORS 관련 에러 표시
- `Access-Control-Allow-Origin` 헤더 누락

**원인:**
- Django CORS 설정이 잘못됨
- 프론트엔드 도메인이 허용 목록에 없음

**해결 방법:**

1. **Django 설정 확인** (`backend/config/settings.py`)
   ```python
   CORS_ALLOWED_ORIGINS = [
       "http://localhost:5173",
       "https://wj-reporting.onrender.com",  # 실제 도메인으로 변경
   ]
   CORS_ALLOW_CREDENTIALS = True
   ```

2. **미들웨어 순서 확인**
   ```python
   MIDDLEWARE = [
       'django.middleware.security.SecurityMiddleware',
       'django.contrib.sessions.middleware.SessionMiddleware',
       'corsheaders.middleware.CorsMiddleware',  # CORS는 상단에
       'django.middleware.common.CommonMiddleware',
       # ...
   ]
   ```

3. **환경 변수 확인**
   - Render 대시보드에서 `FRONTEND_URL` 환경 변수 설정

### 3. 404 에러가 HTML로 반환됨

**증상:**
- 존재하지 않는 API 경로 접근 시 HTML 페이지 반환
- JSON 404 응답 대신 `index.html` 반환

**원인:**
- API 404 가드 미들웨어가 활성화되지 않음
- DRF 예외 핸들러가 설정되지 않음

**해결 방법:**

1. **미들웨어 활성화** (`backend/config/settings.py`)
   ```python
   MIDDLEWARE = [
       # ...
       'config.middleware.NoCacheAPIMiddleware',
       'config.middleware.APINotFoundMiddleware',
   ]
   ```

2. **DRF 예외 핸들러 설정**
   ```python
   REST_FRAMEWORK = {
       # ...
       'EXCEPTION_HANDLER': 'config.exceptions.custom_exception_handler',
   }
   ```

3. **테스트**
   ```bash
   curl -i https://wj-reporting.onrender.com/api/invalid-path
   # Content-Type: application/json 확인
   ```

### 4. 환경 변수가 반영되지 않음

**증상:**
- `.env.production` 파일의 값이 빌드에 반영되지 않음
- `import.meta.env.VITE_API_BASE_URL`이 `undefined`

**원인:**
- Vite 환경 변수는 `VITE_` 접두사 필요
- 빌드 시점에 환경 변수가 주입됨

**해결 방법:**

1. **환경 변수 이름 확인**
   ```bash
   # .env.production
   VITE_API_BASE_URL=/api  # VITE_ 접두사 필수
   ```

2. **재빌드**
   ```bash
   cd frontend
   npm run build
   ```

3. **빌드 결과 확인**
   ```bash
   # dist/assets/*.js 파일에서 환경 변수 값 검색
   grep -r "VITE_API_BASE_URL" dist/
   ```

### 5. 권한 에러 (403 Forbidden)

**증상:**
- 로그인 후에도 특정 API 접근 시 403 에러
- 사용자에게 권한이 있어야 하는데 접근 불가

**원인:**
- 데이터베이스 권한 설정이 잘못됨
- 마이그레이션이 실행되지 않음

**해결 방법:**

1. **마이그레이션 실행**
   ```bash
   cd backend
   python manage.py migrate
   ```

2. **권한 수정 명령어 실행**
   ```bash
   python manage.py fix_view_permissions
   ```

3. **데이터베이스 확인**
   ```python
   # Django shell
   from injection.models import UserSectionPermission
   UserSectionPermission.objects.filter(user=user, can_view=True)
   ```

### 6. 프록시 경로 중복 (/api/api/...)

**증상:**
- 실제 요청 URL이 `/api/api/...`로 중복됨
- 404 에러 발생

**원인:**
- 프록시 설정에서 경로를 잘못 처리
- `baseURL`과 엔드포인트 경로가 중복

**해결 방법:**

1. **axios 설정 확인** (`frontend/src/lib/api.ts`)
   ```typescript
   const API_URL = '/api';  // /api로 끝나야 함 (슬래시 없음)
   
   // 엔드포인트는 슬래시로 시작
   summary: (date?: string) => `/reports/summary/?date=${date}`
   ```

2. **프록시 규칙 확인**
   ```yaml
   # render.yaml - :path*는 /api를 제외한 나머지 경로
   source: /api/:path*
   destination: https://backend.com/api/:path*
   ```

### 7. 날짜 파라미터 오류

**증상:**
- URL에 `%3C` 같은 이상한 문자 포함
- 날짜 필터링이 작동하지 않음

**원인:**
- 날짜 값이 비어있거나 잘못된 형식
- URL 인코딩 문제

**해결 방법:**

1. **파라미터 검증 사용** (`frontend/src/utils/requestValidator.ts`)
   ```typescript
   import { validateDate } from '@/utils/requestValidator';
   
   const date = validateDate(inputDate);  // 예외 발생 시 에러
   ```

2. **에러 핸들링**
   ```typescript
   try {
     const response = await api.get(endpoints.records.summary(date));
   } catch (error) {
     const apiError = handleAPIError(error);
     showErrorToast(apiError);
   }
   ```

## 디버깅 도구

### 1. 브라우저 개발자 도구
- **Network 탭**: 실제 요청/응답 확인
- **Console 탭**: 에러 메시지 및 로그 확인
- **Application 탭**: 쿠키, 세션 스토리지 확인

### 2. curl 명령어
```bash
# 헤더 포함 요청
curl -i https://wj-reporting.onrender.com/api/health/

# JSON 응답 확인
curl -H "Accept: application/json" https://wj-reporting.onrender.com/api/health/

# 인증 포함 요청
curl -H "Authorization: Bearer <token>" https://wj-reporting.onrender.com/api/reports/
```

### 3. 검증 스크립트
```bash
# Node.js 스크립트
node scripts/verify-deployment.js

# 브라우저 테스트
# scripts/browser-test.html 열기
```

### 4. Django 로그
```python
# backend/config/settings.py
LOGGING = {
    'version': 1,
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
        },
    },
    'loggers': {
        'django': {
            'handlers': ['console'],
            'level': 'DEBUG',  # 디버깅 시 DEBUG로 변경
        },
    },
}
```

## 자주 묻는 질문 (FAQ)

### Q: 로컬에서는 되는데 배포하면 안 됩니다.
A: 환경 변수, CORS 설정, 프록시 설정을 확인하세요. 로컬과 프로덕션 환경의 차이를 체크리스트로 확인하세요.

### Q: 프록시를 사용해야 하나요, 절대 URL을 사용해야 하나요?
A: 같은 도메인(Render Static Site)에서 배포하는 경우 프록시(`/api`)를 권장합니다. 도메인이 분리된 경우 절대 URL을 사용하세요.

### Q: 마이그레이션은 어떻게 실행하나요?
A: Render는 배포 시 자동으로 `startCommand`를 실행합니다. `python manage.py migrate`를 포함시키세요.

### Q: 환경 변수는 어디서 설정하나요?
A: Render 대시보드 → 서비스 선택 → Environment 탭에서 설정합니다.

## 추가 지원

문제가 해결되지 않으면:
1. Render 배포 로그 확인
2. Django 서버 로그 확인
3. 브라우저 개발자 도구 Network/Console 탭 확인
4. 검증 스크립트 실행 결과 확인
