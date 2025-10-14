# GitHub Actions 설정 가이드

## 🎯 목표
GitHub에서 테스트 → 배포 자동화 파이프라인 구축

## 📋 설정 체크리스트

### 1. Render Deploy Hook URL 가져오기

#### Backend 서비스
1. [Render 대시보드](https://dashboard.render.com) 접속
2. `wj_reporting_backend` 서비스 선택
3. **Settings** 탭 클릭
4. **Deploy Hook** 섹션에서 URL 복사
   - 형식: `https://api.render.com/deploy/srv-xxxxx?key=yyyyy`

#### Frontend 서비스
1. `wj_reporting` (프론트엔드) 서비스 선택
2. **Settings** 탭 클릭
3. **Deploy Hook** 섹션에서 URL 복사

### 2. GitHub Secrets 등록

1. GitHub 레포지토리 페이지 이동
2. **Settings** 탭 클릭
3. 왼쪽 메뉴에서 **Secrets and variables** → **Actions** 선택
4. **New repository secret** 버튼 클릭

#### 등록할 Secrets

| Secret Name | Value | 설명 |
|------------|-------|------|
| `RENDER_DEPLOY_HOOK_BACKEND` | `https://api.render.com/deploy/srv-xxxxx?key=yyyyy` | 백엔드 Deploy Hook URL |
| `RENDER_DEPLOY_HOOK_FRONTEND` | `https://api.render.com/deploy/srv-xxxxx?key=zzzzz` | 프론트엔드 Deploy Hook URL |

**주의:** Deploy Hook URL은 절대 코드에 직접 넣지 마세요!

### 3. Render Health Check 설정

#### Backend 서비스
1. Render 대시보드에서 `wj_reporting_backend` 선택
2. **Settings** 탭
3. **Health Check Path** 입력: `/api/health/`
4. **Save Changes**

#### Frontend 서비스 (선택)
1. `wj_reporting` 선택
2. **Settings** 탭
3. **Health Check Path** 입력: `/` 또는 `/index.html`
4. **Save Changes**

### 4. Render Auto-Deploy 비활성화 (중요!)

GitHub Actions에서 배포를 제어하므로 Render의 자동 배포는 꺼야 합니다.

1. 각 서비스 **Settings** 탭
2. **Build & Deploy** 섹션
3. **Auto-Deploy** 토글을 **OFF**로 변경
4. **Save Changes**

이제 배포는 GitHub Actions에서만 트리거됩니다.

## 🚀 워크플로 동작 방식

### PR 생성 시
```
PR 생성
  ↓
테스트 실행 (lint, unit test, backend test)
  ↓
현재 프로덕션 환경 스모크 테스트
  ↓
✅ 통과 → 머지 가능
❌ 실패 → 수정 필요
```

### main 브랜치 푸시 시
```
main 푸시
  ↓
테스트 실행
  ↓
✅ 통과
  ↓
백엔드 배포 트리거
  ↓
백엔드 Health Check 대기 (최대 5분)
  ↓
프론트엔드 배포 트리거
  ↓
프론트엔드 준비 대기 (1분)
  ↓
배포 검증 (smoke test)
  ↓
✅ 완료!
```

## 📝 워크플로 파일 구조

`.github/workflows/api-smoke-test.yml` (이미 생성됨)

```yaml
jobs:
  test:        # 1단계: 테스트
  deploy:      # 2단계: 배포 (main만)
  verify:      # 3단계: 검증 (main만)
  pr-smoke-test: # PR용 스모크 테스트
```

## 🔍 확인 방법

### 1. GitHub Actions 탭에서 확인
1. GitHub 레포지토리 → **Actions** 탭
2. 최근 워크플로 실행 확인
3. 각 단계별 로그 확인

### 2. Render 대시보드에서 확인
1. 각 서비스의 **Events** 탭
2. Deploy Hook으로 트리거된 배포 확인
3. 배포 로그 확인

### 3. 로컬에서 수동 테스트
```bash
# Deploy Hook 테스트 (실제 배포됨!)
curl -X POST "https://api.render.com/deploy/srv-xxxxx?key=yyyyy"

# Health Check 테스트
bash scripts/wait-health.sh https://wj-reporting-backend.onrender.com/api/health/ 180
```

## 🎨 PR Preview 환경 (선택)

PR마다 격리된 미리보기 환경을 원하면:

1. Render 대시보드에서 서비스 선택
2. **Settings** → **Preview Environments**
3. **Enable PR Previews** 토글 ON
4. **Auto-Deploy** 선택

이제 PR마다 자동으로 미리보기 URL이 생성됩니다.

## 🐛 문제 해결

### "Secret not found" 에러
- GitHub Secrets 이름이 정확한지 확인
- 대소문자 구분 확인
- Secrets 값에 공백이 없는지 확인

### Deploy Hook이 작동하지 않음
- Render Deploy Hook URL이 올바른지 확인
- URL에 `?key=` 파라미터가 포함되어 있는지 확인
- Render 서비스가 활성 상태인지 확인

### Health Check 타임아웃
- Render 서비스가 정상 시작되었는지 확인
- Health Check Path가 올바른지 확인 (`/api/health/`)
- 타임아웃 시간 늘리기 (300초 → 600초)

### 테스트는 통과했는데 배포가 안 됨
- `github.ref == 'refs/heads/main'` 조건 확인
- main 브랜치에 푸시했는지 확인
- GitHub Actions 로그에서 `deploy` job이 실행되었는지 확인

## 📊 모니터링

### GitHub Actions 배지 추가
README.md에 추가:

```markdown
![Test and Deploy](https://github.com/YOUR_USERNAME/YOUR_REPO/actions/workflows/api-smoke-test.yml/badge.svg)
```

### Slack/Discord 알림 (선택)
워크플로에 알림 단계 추가:

```yaml
- name: Notify Slack
  if: always()
  uses: 8398a7/action-slack@v3
  with:
    status: ${{ job.status }}
    webhook_url: ${{ secrets.SLACK_WEBHOOK }}
```

## 🔐 보안 체크리스트

- [x] Deploy Hook URL을 Secrets로 관리
- [x] API 키/토큰을 코드에 직접 넣지 않음
- [x] Secrets 값에 공백/개행 없음
- [x] 민감한 정보를 로그에 출력하지 않음

## 📚 추가 자료

- [GitHub Actions 문서](https://docs.github.com/en/actions)
- [Render Deploy Hooks](https://render.com/docs/deploy-hooks)
- [Render Health Checks](https://render.com/docs/health-checks)
- [GitHub Secrets 관리](https://docs.github.com/en/actions/security-guides/encrypted-secrets)

## 🎉 완료!

이제 다음과 같이 작동합니다:

1. **PR 생성** → 테스트 자동 실행
2. **main 머지** → 테스트 → 배포 → 검증
3. **배포 실패** → 자동 롤백 (Render Health Check)
4. **모든 단계 로그** → GitHub Actions에서 확인

문제가 있으면 `TROUBLESHOOTING.md`를 참고하세요!
