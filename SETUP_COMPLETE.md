# ✅ 설정 완료 가이드

## 🎉 모든 코드 작업 완료!

이제 GitHub에서 몇 가지만 설정하면 자동 배포가 시작됩니다.

## 📋 남은 작업 (5분 소요)

### 1️⃣ Render Deploy Hook URL 가져오기 (2분)

#### Backend
1. https://dashboard.render.com 접속
2. `wj_reporting_backend` 서비스 클릭
3. **Settings** 탭
4. **Deploy Hook** 섹션에서 URL 복사
   ```
   https://api.render.com/deploy/srv-xxxxx?key=yyyyy
   ```

#### Frontend
1. `wj_reporting` 서비스 클릭
2. **Settings** 탭
3. **Deploy Hook** 섹션에서 URL 복사
   ```
   https://api.render.com/deploy/srv-xxxxx?key=zzzzz
   ```

### 2️⃣ GitHub Secrets 등록 (2분)

1. GitHub 레포지토리 페이지
2. **Settings** 탭
3. **Secrets and variables** → **Actions**
4. **New repository secret** 클릭

**등록할 2개:**
- Name: `RENDER_DEPLOY_HOOK_BACKEND`
  - Value: (위에서 복사한 백엔드 URL)
- Name: `RENDER_DEPLOY_HOOK_FRONTEND`
  - Value: (위에서 복사한 프론트엔드 URL)

### 3️⃣ Render Auto-Deploy 끄기 (1분)

GitHub Actions에서 배포를 제어하므로 Render 자동 배포는 꺼야 합니다.

#### Backend
1. `wj_reporting_backend` → **Settings**
2. **Build & Deploy** 섹션
3. **Auto-Deploy** 토글 **OFF**
4. **Save Changes**

#### Frontend
1. `wj_reporting` → **Settings**
2. **Build & Deploy** 섹션
3. **Auto-Deploy** 토글 **OFF**
4. **Save Changes**

### 4️⃣ Render Health Check 설정 (선택, 1분)

#### Backend
1. `wj_reporting_backend` → **Settings**
2. **Health Check Path**: `/api/health/`
3. **Save Changes**

## 🚀 테스트 배포

모든 설정이 완료되었으면:

```bash
# 1. 변경사항 푸시
git push origin main

# 2. GitHub Actions 확인
# GitHub → Actions 탭에서 워크플로 실행 확인

# 3. 배포 완료 후 검증
bash scripts/quick-smoke-test.sh
```

## 🔍 확인 방법

### GitHub Actions에서
1. GitHub 레포지토리 → **Actions** 탭
2. 최근 워크플로 실행 클릭
3. 각 단계 확인:
   - ✅ test (테스트 실행)
   - ✅ deploy (배포 트리거)
   - ✅ verify (배포 검증)

### Render에서
1. Render 대시보드
2. 각 서비스의 **Events** 탭
3. "Deploy triggered by deploy hook" 확인

## 🎯 이제 작동하는 것

### PR 생성 시
```
PR 생성
  ↓
✅ 린트 & 테스트 자동 실행
  ↓
✅ 현재 프로덕션 스모크 테스트
  ↓
✅ 통과 → 머지 가능
```

### main 브랜치 푸시 시
```
main 푸시
  ↓
✅ 모든 테스트 실행
  ↓
✅ 백엔드 배포 트리거
  ↓
⏳ 백엔드 Health Check 대기
  ↓
✅ 프론트엔드 배포 트리거
  ↓
⏳ 프론트엔드 준비 대기
  ↓
✅ 배포 검증 (smoke test)
  ↓
🎉 완료!
```

## 📚 유용한 명령어

```bash
# 빠른 스모크 테스트
npm run test:smoke

# 전체 배포 검증
npm run verify:deployment

# 릴리즈 체크리스트
npm run release:check

# E2E 테스트
npm run test:e2e

# Health check 대기
bash scripts/wait-health.sh https://wj-reporting-backend.onrender.com/api/health/ 180
```

## 🐛 문제 해결

### "Secret not found" 에러
→ GitHub Secrets 이름 확인 (대소문자 구분)

### Deploy Hook이 작동하지 않음
→ Render Deploy Hook URL 확인 (`?key=` 포함)

### 테스트는 통과했는데 배포가 안 됨
→ main 브랜치에 푸시했는지 확인

### Health Check 타임아웃
→ Render 서비스 로그 확인, Health Check Path 확인

## 📖 상세 문서

- [GITHUB_SETUP.md](GITHUB_SETUP.md) - 상세 설정 가이드
- [README_DEPLOYMENT.md](README_DEPLOYMENT.md) - 배포 가이드
- [TESTING.md](TESTING.md) - 테스트 가이드
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - 문제 해결

## ✨ 완료 체크리스트

배포 전:
- [x] 코드 작성 완료
- [x] 테스트 스크립트 작성
- [x] CI/CD 워크플로 작성
- [x] 문서화 완료

GitHub 설정:
- [ ] Render Deploy Hook URL 복사
- [ ] GitHub Secrets 등록 (2개)
- [ ] Render Auto-Deploy 비활성화
- [ ] Render Health Check 설정

배포 후:
- [ ] GitHub Actions 워크플로 실행 확인
- [ ] Render 배포 로그 확인
- [ ] `bash scripts/quick-smoke-test.sh` 실행
- [ ] 브라우저에서 수동 확인

## 🎊 축하합니다!

모든 설정이 완료되면:
- ✅ PR마다 자동 테스트
- ✅ main 푸시 시 자동 배포
- ✅ 배포 후 자동 검증
- ✅ 실패 시 자동 알림

이제 코드만 작성하면 나머지는 자동입니다! 🚀
