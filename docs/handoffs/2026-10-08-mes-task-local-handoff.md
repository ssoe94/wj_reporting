# MES 대사 작업 — 클라우드에서 Mac 로컬로 인계

## 사용자 요청과 현재 상태

2026-10-08 사용자가 클라우드 작업을 로컬로 옮기고 로컬에서 재개하도록 요청했다.
우선 변경된 화면을 사용자의 Mac에서 열어 검토하는 것이 다음 작업이다.
클라우드의 5173 서버는 Mac의 localhost가 아니다. 클라우드 브라우저 검증을
사용자 로컬 서버가 실행됐다는 근거로 사용하지 않는다.

소스 인계 브랜치: `codex/mes-task-reconciliation-20261008`.
기준 커밋: `9039735fc73443419ac392f9618e42d58207186e`.
클라우드 작업 폴더: `/workspace/wj-mes-task-reconciliation`.
기존 Mac 프로젝트: `/Users/macstudio_ted/Developer/wj_reporting`.
추천 로컬 작업 폴더: `/Users/macstudio_ted/Developer/wj-mes-task-reconciliation-local`.

GitHub 전용 브랜치와 별도의 이관 ZIP/Git bundle을 제공한다. 이 문서 작성 시점에는
Mac에 직접 파일을 쓸 도구가 없으므로 실제 Mac 수신·서버 실행은 로컬에서 확인해야 한다.
클라우드의 node_modules와 Python venv는 Mac 환경으로 복사하지 않는다.
필요한 기존 의존성 설치는 사용자가 승인한 작업의 연속이며 새로 승인을 요청할 필요가 없다.
실제 운영 MES/DB 연결, 작업 변경, 운영 배포는 이번 이관 범위에 포함되지 않는다.

## 로컬에서 바로 시작

이관 ZIP을 풀고 `bash 옮기기.command`를 실행하면 Git bundle에서 전용 로컬 브랜치와
별도 worktree를 만들고, 이 인계서 및 미리보기 경로를 출력한다.
기존 main, 작업 중 변경분, 다른 브랜치는 덮어쓰지 않는다. 대상 폴더나 로컬 브랜치가
이미 있으면 자동 덮어쓰기 대신 중단하고 현재 상태를 확인한다.

ZIP 없이 GitHub에서 받는 경우:

```bash
git -C /Users/macstudio_ted/Developer/wj_reporting fetch origin codex/mes-task-reconciliation-20261008
git -C /Users/macstudio_ted/Developer/wj_reporting worktree add \
  -b codex/local-mes-task-reconciliation-20261008 \
  /Users/macstudio_ted/Developer/wj-mes-task-reconciliation-local \
  FETCH_HEAD
```

이관 ZIP의 `preview/run-preview.command`는 이미 검증한 전체 앱 빌드와 합성 API를
Node 기본 모듈만으로 실행한다. 패키지 설치나 운영 인증정보가 필요 없다.
`bash preview/run-preview.command`로 실행한 뒤 다음 주소를 연다:

`http://localhost:5173/production#mes-task-reconciliation-title`

화면 상단에 합성 데이터 표시, 정상/부분/실패/빈 목록 전환, 한국어/중국어 전환,
변경 설명 링크가 있다. 다른 프로세스가 포트를 사용하면 종료하지 않고 오류를 표시한다.
실제 MES 데이터와 운영 로그인은 사용하지 않는다.
`MES-대사-미리보기.html`은 Node 설치 없이 패널만 볼 수 있는 보조 자료다.

개발용 Vite 서버는 전체 앱 API와 인증 환경이 별도로 필요하다. `.env`를 복사하거나
운영 backend로 연결해 화면을 억지로 열지 않는다. 먼저 위 합성 미리보기를 실행해
사용자가 요청한 수정 위치와 동작을 함께 확인한다.

## 복구·변경한 내용

원래 16개 구현 파일은 이전 클라우드 채팅 「개발 방향 재검토」
(`01a119d8-cf35-707f-b457-becb64538012`)의 완료 패치 기록에서 복구했다.
현재 구현 설명은 `docs/reviews/2026-10-08-mes-task-reconciliation.md`에 있다.

- backend: 조회 리더, 순수 대사 판정, 서비스, GET 권한/API, 관련 테스트와 URL.
- frontend: `/production` 하단 패널, API/view-model, 번역, CSS, 테스트와 합성 fixture.
- 검증 도구: `scripts/check-mes-task-reconciliation.py`.
- 공식 목록 API의 중첩 상태·물료·보고 수량 구조 지원과 모바일 grid 너비 수정.

계획 일치는 실제 생산 확정이 아니다. 동일 품번의 다중 작업·다중 계획 LOT는 연결 확인
대상으로 남긴다. 동시생산은 기존 cavity_group을 쓰며 순서만 같다고 묶지 않는다.
부분 응답, 미연결 설비, 과거/미래 날짜, 계획 부족은 조치 판정을 보류한다.
조회 실패는 정상 0건으로 바꾸지 않는다. 暂停/继续 실행 API·쓰기 버튼은 없다.

## 완료한 검증

- 원본 package.json/lockfile 그대로 `npm ci --no-fund --no-audit` 성공, 535개 패키지.
  SheetJS 공식 CDN HTTP 200, xlsx 0.20.3, Node와 실제 브라우저 XLSX 왕복 확인.
- 순수 판정·MES reader·Django 권한/캐시/격리 DB 테스트 40개 통과.
- Node 대사 view-model 테스트 6개 통과.
- 전체 `npm run build` 통과: TypeScript, Vite 현대/레거시 JS, 레거시 CSS, 빌드 정보.
  큰 번들 경고는 남는다.
- Chromium 전체 앱 한국어 데스크톱·중국어 모바일 검증. 17개 호기, 키보드 필터,
  수동 새로고침, focus 자동 갱신 방지, 실패·부분·빈 상태 확인.
- 이관 ZIP에 백엔드/빌드 로그와 대표 화면을 포함한다. 모두 합성 데이터 검증이다.

Mac에서 재검증할 때 기존 Node 환경을 확인하고 아래 명령을 사용한다.
Node 타입 제거 기능을 지원하는 버전이 필요하다(예: Node 22.6 이상).
Python venv가 없으면 Mac에서 `python3 -m venv backend/.venv` 후 기존
`backend/requirements.txt`로 설치한다. 프로젝트 .env나 운영 DB를 쓰지 않는 검증이다.

```bash
npm --prefix frontend ci --no-fund --no-audit
node --experimental-strip-types --test frontend/tests/mes-task-reconciliation.test.ts
backend/.venv/bin/python scripts/check-mes-task-reconciliation.py
npm --prefix frontend run build
git diff --check
```

## 다음 개발과 주의할 분기

1. Mac에서 실제 서버의 LISTEN과 HTTP 응답을 확인하고 사용자가 화면을 검토하게 한다.
2. 로컬 기존 main과 인계 브랜치의 차이를 확인한다. 로컬에만 있는
   `codex/inspection-resume-20261008`는 원격에 없었으므로 그 전체 브랜치를 무조건
   합치거나 이전 변경을 버리지 않는다. 이번 이관은 별도 worktree에서 유지한다.
3. 실제 WJ 비식별 응답과 앱 조회 권한, 설비 매핑 계약을 확보해 검증한다.
   공식 문서의 목록에는 설비 연결 정보와 입고 수량이 보장되지 않는다.
   누락을 숫자 코드 추정이나 보고 수량으로 대체하지 않는다.
4. 대표 호기의 계획 일치·중복 작업·동시생산·계획 변경을 현장과 확인한다.
5. 이후 暂停/继续는 권한·조작 사유·운영 책임자·감사 기록을 별도 설계한다.
   실제 시범 조치는 지정 작업과 승인이 필요하다.

이번 이관은 소스와 재현 자료 보존이다. PR 병합, Render 배포, 운영 migration,
운영 MES/DB 조회·변경은 수행하지 않았다.
