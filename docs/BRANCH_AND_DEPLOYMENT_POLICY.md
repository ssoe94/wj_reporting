# 브랜치 및 배포 운영 규칙

## 1. 운영 환경

| 구분 | Git 브랜치 | Render 서비스 | URL |
| --- | --- | --- | --- |
| 운영 프런트엔드 | `main` | `wj_reporting` | `https://wj-reporting.onrender.com` |
| 운영 백엔드 | `main` | `wj_reporting_backend` | `https://wj-reporting-backend.onrender.com` |

프런트엔드 소스와 빌드는 `frontend` 한 곳에서 관리한다. 별도 베타
프런트엔드 서비스는 사용하지 않는다.

## 2. 개발 절차

1. 최신 `main`에서 작업 브랜치를 만든다.
2. 구현 후 프런트엔드 빌드, 관련 테스트, 로컬 브라우저 검증을 수행한다.
3. Pull Request에서는 검증만 실행하고 배포하지 않는다.
4. 검토가 끝난 변경만 `main`에 병합한다.
5. `main` push 또는 승인된 수동 실행에서 운영 배포 훅을 호출한다.

긴급 수정도 별도 브랜치에서 검증한 뒤 `main`에 병합한다. 운영 브랜치를
force push로 덮어쓰지 않는다.

## 3. 자동 및 수동 배포

- `main` push: 전체 검증 후 운영 백엔드와 프런트엔드를 배포한다.
- Pull Request: 전체 검증만 수행한다.
- 수동 실행: `action=deploy` 또는 `action=test-only`를 선택한다.
- `main` 이외 브랜치에서는 운영 배포 훅을 호출하지 않는다.

필수 GitHub Actions secrets:

- `RENDER_DEPLOY_HOOK_BACKEND`
- `RENDER_DEPLOY_HOOK_FRONTEND`

## 4. 데이터 및 API 안전 규칙

- DB 마이그레이션은 운영 백엔드 배포에서만 실행한다.
- 삭제, 초기화, 일괄 변경에는 확인 절차와 권한 검사를 둔다.
- 새 API는 기존 화면과 호환되는 추가형 변경을 우선한다.
- 프런트엔드가 생산 수치를 임의 계산하거나 LLM 출력으로 대체하지 않는다.

## 5. 배포 전 확인

- `.env`, 토큰, 비밀번호가 변경 파일에 포함되지 않았는지 확인한다.
- `frontend` 린트와 빌드가 통과하는지 확인한다.
- 관련 백엔드 테스트와 마이그레이션 충돌 여부를 확인한다.
- `/production`, `/mes/monitoring`, `/sales/raw-materials`, 사출 현황판을 확인한다.
- DB 쓰기 동작이 운영 사용자에게 미칠 영향을 확인한다.

## 6. 배포 후 확인

- Actions와 Render 배포 작업이 성공했는지 확인한다.
- `/build-info.json`의 `commit`과 `branch`가 배포 대상과 일치하는지 확인한다.
- 로그인, 핵심 업무 화면, `/api/health/`를 스모크 테스트한다.
- 오류가 발생하면 재배포 전에 최초 실패 로그와 커밋을 기록한다.

## 7. 장애 예방 원칙

- 테스트 실패를 `|| echo` 등으로 성공 처리하지 않는다.
- Render 자동 배포는 끄고 검증을 통과한 Actions 배포 훅만 사용한다.
- 배포 성공은 HTTP 200뿐 아니라 커밋 SHA와 브랜치까지 확인한다.
- 운영 비밀값이나 배포 설정을 로컬 추측으로 변경하지 않는다.
