# 테스트 가이드

## 테스트 종류

### 1. 빠른 스모크 테스트 (Quick Smoke Test)
배포 후 즉시 실행하여 핵심 기능 확인

```bash
bash scripts/quick-smoke-test.sh
```

**검증 항목:**
- ✅ JSON 응답 보장 (`/api/health/`, `/api/injection/reports/summary/`)
- ✅ 404 에러도 JSON 반환
- ✅ 캐시 헤더 확인 (`Cache-Control: no-store`)
- ✅ 프록시 라우팅 동작
- ✅ 백엔드 직접 접근

### 2. 전체 배포 검증 (Full Deployment Verification)
모든 엔드포인트를 상세히 검증

```bash
node scripts/verify-deployment.js
```

**검증 항목:**
- Backend direct tests
- Frontend proxy tests
- 404 JSON guard tests
- 상세한 에러 리포팅

### 3. E2E 테스트 (Playwright)
브라우저 기반 통합 테스트

```bash
# 설치
npm install

# 실행
npm run test:e2e

# UI 모드로 실행
npm run test:e2e:ui

# 헤드리스 모드 해제
npm run test:e2e:headed
```

**테스트 케이스:**
- API 라우팅 및 JSON 응답
- 데이터 렌더링 (undefined 방지)
- 401 인증 에러 처리
- 404 JSON 응답
- 사용자 친화적 에러 메시지
- 쿠키/자격증명 전송
- 캐시 헤더
- 프록시 설정

### 4. 브라우저 테스트
브라우저에서 직접 실행

```bash
# 브라우저에서 열기
open scripts/browser-test.html
# 또는
start scripts/browser-test.html
```

### 5. CI 자동 테스트
GitHub Actions에서 자동 실행

- PR 생성 시 자동 실행
- main 브랜치 푸시 시 자동 실행
- 수동 실행 가능 (workflow_dispatch)

## 릴리즈 체크리스트

배포 전 필수 확인사항

```bash
bash scripts/release-checklist.sh
```

**확인 항목:**
- [x] VITE_API_BASE_URL 설정
- [x] render.yaml 라우팅 규칙
- [x] static.json 프록시 규칙
- [x] Django 미들웨어 활성화
- [x] CORS 설정
- [x] 검증 스크립트 존재

## 유용한 원라이너

### JSON 응답 확인
```bash
curl -sI https://wj-reporting.onrender.com/api/health/ | grep -i content-type
```

### JSON 파싱 테스트
```bash
curl -s https://wj-reporting.onrender.com/api/injection/reports/summary/?date=2025-10-14 | jq .
```

### 404 JSON 확인
```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" https://wj-reporting.onrender.com/api/_404_check
```

### 모든 헤더 확인
```bash
curl -I https://wj-reporting.onrender.com/api/health/
```

### 응답 시간 측정
```bash
curl -w "@-" -o /dev/null -s https://wj-reporting.onrender.com/api/health/ <<'EOF'
    time_namelookup:  %{time_namelookup}
       time_connect:  %{time_connect}
    time_appconnect:  %{time_appconnect}
      time_redirect:  %{time_redirect}
   time_pretransfer:  %{time_pretransfer}
 time_starttransfer:  %{time_starttransfer}
                    ----------
         time_total:  %{time_total}
EOF
```

## 테스트 시나리오

### 시나리오 1: 정상 배포 검증
```bash
# 1. 릴리즈 체크리스트
bash scripts/release-checklist.sh

# 2. 배포
git push origin main

# 3. 배포 완료 대기 (약 2-3분)
sleep 180

# 4. 빠른 스모크 테스트
bash scripts/quick-smoke-test.sh

# 5. 전체 검증
node scripts/verify-deployment.js

# 6. E2E 테스트 (선택)
npm run test:e2e
```

### 시나리오 2: 문제 발생 시
```bash
# 1. 빠른 진단
bash scripts/quick-smoke-test.sh

# 2. 상세 로그 확인
node scripts/verify-deployment.js

# 3. 브라우저 개발자 도구
# - Network 탭에서 실제 요청/응답 확인
# - Console 탭에서 에러 메시지 확인

# 4. 문제 해결 가이드 참고
cat TROUBLESHOOTING.md
```

### 시나리오 3: 로컬 개발 환경 테스트
```bash
# 프론트엔드 개발 서버
cd frontend
npm run dev

# 백엔드 개발 서버
cd backend
python manage.py runserver

# 로컬 E2E 테스트
FRONTEND_URL=http://localhost:5173 npm run test:e2e
```

## CI/CD 통합

### GitHub Actions
`.github/workflows/api-smoke-test.yml` 파일이 자동으로:
- PR 생성 시 API 응답 검증
- main 푸시 시 배포 후 검증
- HTML 응답 차단 확인
- 404 JSON 응답 확인

### 실패 시 알림
CI 테스트 실패 시:
1. GitHub Actions 로그 확인
2. 실패한 테스트 케이스 확인
3. `TROUBLESHOOTING.md` 참고
4. 필요 시 롤백

## 재발 방지

### 1. PR 체크리스트
- [ ] `bash scripts/release-checklist.sh` 통과
- [ ] 로컬에서 `npm run test:e2e` 통과
- [ ] API 엔드포인트 변경 시 E2E 테스트 업데이트

### 2. 배포 후 자동 검증
- [ ] CI smoke test 통과
- [ ] `bash scripts/quick-smoke-test.sh` 실행
- [ ] 브라우저에서 수동 확인

### 3. 모니터링
- Render 대시보드에서 에러 로그 모니터링
- 사용자 피드백 수집
- 정기적인 E2E 테스트 실행

## 참고 자료

- [Playwright 문서](https://playwright.dev/)
- [curl 치트시트](https://devhints.io/curl)
- [jq 매뉴얼](https://stedolan.github.io/jq/manual/)
- `DEPLOYMENT_CHECKLIST.md` - 배포 체크리스트
- `TROUBLESHOOTING.md` - 문제 해결 가이드
- `DEPLOYMENT_SOLUTION.md` - 전체 솔루션 문서
