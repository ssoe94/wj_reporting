# 생산계획 → 원료 확인 → MES 工单 준비: 첫 구현 검토

2026-10-08. 실제 MES writer는 OFF이며 생성·수정 호출, 생산 조작, 권한 변경, 운영 설정 변경, 운영 migration, 배포를 실행하지 않았다. push / PR / 원격 main merge는 하지 않았고 승인된 독립 브랜치의 로컬 main 통합만 수행했다.

## 후속 보완: 생성 transport와 캠페인 전체 조회

아래 초기 검토 이후 사용자 지시로 최신 main `b857c50e`를 독립 브랜치에 충돌 없이 통합했다(로컬 merge `f939d07d`). 인증 예외 코드 보존과 그 테스트가 포함됐다. 원본 checkout과 Claude 작업에는 쓰지 않았다.

`plan_workflow_transport.py`와 `plan_workflow_read_contract.py`를 추가했다. 문서화된 v2 import payload를 기존 USER route gateway로 보내는 transport, 영속 예약을 commit한 후 단 한 번 전송하는 coordinator, 개별 import의 순차 batch/부분 결과, 17자리 생성 ID 보존, timeout 이후 공번 재조회가 구현됐다. 운영 쓰기 gate는 그대로 OFF다. 실제 생성 시험은 synthetic credential과 injected sender로만 실행된다. 운영 send endpoint·Celery 자동 송신·08시 개시·검사 생성은 추가하지 않았다.

조회는 기본정보 → 입력 원료/BOM → 산출 → 공정계획 → 기본정보 재확인의 최대 5회다. 문서 `1686655055663531/3539/3541/3542`의 공식 경로만 사용하고 날짜별 보고 필터를 넣지 않는다. 캠페인 전체 계획량·단위·제품/원료 ID·version·배합비·손실률·설비·공정/route·창고 정책·tenant custom field를 승인 snapshot과 대조한다. 숨겨진 필드, 잘못된 수량/단위/ID, 추가 산출/대체원료, 누락 자료, weak control, 변한 clock은 확인 완료로 만들지 않는다.

생성 응답에서 받은 ID를 event에 보존하여 이후 다른 ID가 조회되면 차단한다. 생성 snapshot 확인만으로 MES 보고량·순입고량·실행 완료를 확정하지 않는다. `observation_complete`는 false로 유지하고 실제 시작시각은 기존 값이 있으면 보존한다. 수정 요청은 기존 생산량/입고량과 허용 상태·task 수량 전파를 검증하기 전까지 차단한다.

읽기 API는 기존 same-user session/credential broker를 사용한다. 원래 요청 actor의 unresolved create만 재조회하며 USER credential 거절은 broker에 전달한다. 토큰 발급·USER refresh·다른 사용자/APP fallback이나 자동 재전송이 없다. 조회 실패 안내를 UI에 표시하며 성공처럼 표시하지 않는다.

`MES_PLAN_REVIEWED_CONTRACT`에는 단순 setup fingerprint 외에 정확한 tenant, 품번/호기 binding, 실제 resource/product material ID, read/write 창고 enum 대응, 금형/BOM version의 실제 custom-field code 및 literal object 값이 필요하다. 금형/BOM version custom fields는 tenant가 그 표현을 명시적으로 검토한 경우만 쓴다. 이것은 실제 금형 교체 수행이나 별도 MES master BOM version 선택을 증명하지 않는다. 승인된 inline BOM 내용은 전부 조회 대조한다.

기본정보 `updatedAt`이 원료/산출/공정 수정까지 반영한다는 보장은 현재 공식 문서에 없다. `base_clock_covers_children`에 대한 별도 검증 근거가 없으면 생성 계약부터 fail-closed다. 아무 boolean을 켜면 검증됐다고 볼 수 없으며 vendor의 보장 또는 승인된 통제 시험 증거가 필요하다. 계약 검토 내용이 바뀌면 기존 disabled 요청을 덮어쓰지 않고 같은 工单 code에 새 영속 요청을 준비하고 과거 요청은 superseded로 보존한다.

### 후속 검증

| 검사 | 결과 |
|---|---|
| 최종 PostgreSQL | 138개 통과; 실제 두 dispatcher에서 import 1회, partial batch timeout 독립 보존 포함 |
| 최종 SQLite | 138개 중 135개 통과·PG 전용 3개 제외 |
| 최신 main 인증 + workflow + upload 통합 | 76개 통과; 실제 config URL/JWT 설정으로 실행, network 차단 |
| 별도 session activity 회귀 | 17개 통과; definitive rejected-session code 검증 포함 |
| migration check | 새 schema 변경 없음 |
| frontend lint/typecheck/production build | 통과; 기존 큰 chunk 경고 유지 |

로그는 `transport-postgres-tests.log`, `transport-backend-tests.log`, `integrated-auth-workflow-tests.log`, `integrated-auth-tests.log`, `transport-migration-check.log`, `transport-lint.log`, `transport-build.log`이다. 아래 14개 화면 검증과 Library 캡처는 최초 버전의 합성 화면 증거이며 이 후속 transport의 실제 MES 검증을 의미하지 않는다.

### 남은 일을 구분한 운영 수용 기준

| 구분 | 대상과 최소 정보/승인 |
|---|---|
| 코드 구현 완료·모의 검증 완료 | v2 생성 요청/응답 transport, durable reservation, single send, batch 개별 결과, timeout fence, 전체 캠페인/BOM readback, 기존 USER 읽기 broker 연결. 운영 gate OFF를 유지한다. |
| 아직 운영 코드 연결 없음 | HTTP/UI 또는 worker에서 서버 승인된 한 건 쓰기 권한과 USER lease를 writer에 전달하는 운영 bridge 및 activation 정책. 현재는 어떤 설정 flag로도 실제 쓰기를 켤 수 없다. 승인을 받으면 정확한 actor/tenant/요청 digest/기간이 고정된 bridge만 연결해야 한다. |
| 첫 생성 범위 밖·코드 아직 없음 | 진행 중 계획량/end 변경 transport 실행, task 수량 전파·전체 생산보고/순입고량의 freshness adapter. 수정 payload는 있으나 송신은 미연결·차단이다. 08시 下达/开工, 마감, 검사 생성은 후속 범위다. |
| 읽기 권한/정보로 진행 가능 | 대상 tenant의 네 상세 조회 권한, 제품/원료·unit·resource code/ID/version, process/route, custom field 정의/값, 초기 status/reportFlag, 창고 enum 의미. 기존 대상 한 건과 공식/tenant 설정 근거로 바인딩을 검토할 수 있다. task detail 권한이 네 상세 조회 권한을 대체하지 않는다. 현재 live 조회는 수행하지 않았다. |
| vendor 보장 또는 별도 통제 시험 필요 | 자식 BOM/산출/공정 변경과 base updatedAt의 연동. 정보만으로 보장이 없으면 승인된 변경 시험이 필요하며 현재 fail-closed다. |
| 실제 MES 쓰기 시험 후에만 확정 | 승인된 제품·호기·금형·원료/BOM·수량·기간 한 건의 생성, custom-field/inline BOM 및 창고/SOP side effect, 생성 응답 ID와 공번 조회의 일치. 진행 상태에서 qty/end 변경 허용 여부, 실제 시작 보존, task 전파는 별도 수정 시험이 필요하다. |
| 별도 운영 승인 필요 | migration `production.0016`, 역할·tenant 설정, 제한된 시험 scope, push/PR/merge/배포. 운영 DB/mapping/permissions는 변경하지 않았다. |

따라서 생성 transport와 조회 구현을 preview 상태로 남겨두지는 않았지만, **실제 MES 생성 성공과 운영 활성화는 아직 수용 완료가 아니다**. 필요한 최소 대상과 미검증 값을 위처럼 고정한 후 명시적 시험 승인으로 진행해야 한다.

아래는 최초 commit `4da3634b` 당시의 구현·검증 기록이다. transport가 미구현이었다는 초기 문구는 위 보완으로 대체됐다.

## 작업공간과 충돌 확인

- 독립 clone: `/Users/macstudio_ted/Documents/Codex/2026-10-08/task-3/wj_reporting`
- 브랜치: `codex/plan-material-mes-20261008`
- 검증 기준: PR96 `492f305dc1f1d2c1dba8a61b257051acf078dce7`.
- 마지막 fetch에서 `origin/main`은 PR97 `b857c50e`였다. 기준 이후 차이는 `backend/config/exceptions.py`, `backend/mes_oauth/test_session_activity.py`의 인증 오류 변경으로 이번 파일과 겹치지 않는다. main 병합이나 rebase는 실행하지 않았다. 운영 반영 전 최신 main에서 재검증해야 한다.
- 원본 `/Users/macstudio_ted/Developer/wj_reporting`은 `9039735f`, `.claude/settings.local.json` 수정 및 `output/` untracked를 그대로 보존했다. Claude 생산현황판 브랜치 `5d91b21a`, 다른 MES 작업 `0b8a3e12`에도 쓰지 않았다.
- 다른 채팅 API와 Codex 앱 CUA 접근을 사용하거나 우회하지 않았다. 원본 dependencies는 링크해 읽었으며 새 패키지를 설치하지 않았다. 빌드 캐시는 이 clone의 output에 저장했다.
- 이전 제안은 실제 로컬 파일을 읽어 확인했다. 일일 사출 工单안보다 최신 연속생산 결정이 우선한다.

## 구현된 동작

1. 기존 upload의 파싱·날짜별 교체·응답·변경 로그를 유지하면서 `ProductionPlan.work_uid / work_version`을 추가했다. 미확정 원료나 MES 상태가 기존 계획 저장과 조회를 제한하지 않는다. 준비 UI는 별도 접기 패널이며 실패해도 기존 현황이 표시된다.
2. 동일 날짜/호기/품번/LOT/모델/규격에서 하나인 행과 동일 순서만 UID를 재사용한다. 수량 변경은 새 immutable revision, 동일 재업로드는 같은 version이다. 복수행, 순서 변경, 날짜/호기 이동 후보는 새 UID와 확인 대기로 남긴다. 담당자가 이전 retired UID 또는 신규 작업을 명시적으로 확인한다. active 행끼리 자동 합치지 않는다. 과거 revision, approval, request와 실행 이력을 삭제하지 않는다.
3. 원료는 기존 저장 MES inventory 원본에서 실제 ID·code·name·unit ID/name이 있는 항목만 제공한다. `syntheticZero`, ID fallback, `-` 단위를 쓰기 값으로 인정하지 않는다. 이는 전체 MES material master가 아닌 저장 inventory 부분집합이며 출처와 갱신 시각을 표시한다.
4. 담당자는 원료 선택과 BOM 분자/분모, BOM version, 금형·resource·process·route, 제품 단위 ID/name/version, 확인 사유를 입력한다. 정확한 소수로 소요량을 계산하여 작업 version에 snapshot을 결합한다. 17자리 ID는 문자열로 보존한다. 수량 변경 뒤 이전 확인값을 초안으로 추천하지만 현재 version 재확인이 필요하다. 품번 기본원료는 별도의 superuser 명시적 동작과 기본 version 충돌 검사로만 저장한다. 일회 대체원료 승인으로 기본값을 갱신하지 않는다.
5. 사출은 동일 호기·제품·LOT·확인된 셋업/원료와 연속 일자가 일치할 때만 하나로 준비한다. 전체 호기 일정을 읽어 선택 범위가 연속 작업을 잘라 새 工单을 만들지 않도록 한다. 미확정 행, 공백 일자, 다른 제품, 같은 날짜 복수행은 경계 또는 차단이다. 5,000행 범위를 넘으면 준비를 차단한다. 가공은 날짜별 행마다 별도 工单을 준비하며 첫 작업 자동 건너뛰기를 구현하지 않았다.
6. 준비된 작업의 구성원이 유지되는 연장에는 같은 工单 code를 사용한다. 제품/호기/LOT, 셋업, 계획 시작, 구성원 제거/분할은 확인을 요구한다. 실제 MES 대상이 있으면 계획량과 종료만 수정 payload에 넣는다. 기존 actual start를 덮어쓰지 않는다.
7. 계획량·생산보고량·입고량을 분리한다. 조회 미검증 수치는 `?`로 표시한다. 입고 부족분으로 계획량을 늘리지 않는다. 확인된 보고/입고량보다 줄이는 경우와 기존 로컬 ProductionExecution 실적보다 줄이는 경우는 차단한다. UID의 과거 순서 등 복합키도 보수적으로 검사하되 이를 MES 보고량이나 확정된 동일성으로 표시하지 않는다.
8. 타입별 DB lock, version/approval pinning, unique dedupe key, 작업 code, append-only event를 영속 저장한다. 미리보기 후 변경은 409로 초안을 보존한다. 준비 batch의 차단 항목은 개별 결과로 남기고 유효 항목을 저장한다. 실제 전송 batch adapter는 없다.
9. 전송 상태의 격리 시험 경로는 `disabled → sending → uncertain/readback_pending → confirmed/review`를 검사한다. sending 중 crash, timeout, 불확실 결과는 재전송할 수 없다. 현재 외부 `recheck`는 기존 세션과 권한으로 읽기 관찰만 저장하고 캠페인 전체·BOM이 미검증이면 계속 차단한다. HTTP 성공만으로 confirmed 처리하지 않는다.

## 공식 계약 근거와 남은 검증

공식 문서 [API index](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/api-index.json)의 다음 문서 및 기존 코드를 확인했다. 임의 endpoint를 만들지 않았다.

| 용도 | 공식 문서 ID | 경로/결론 |
|---|---|---|
| v2 工单 import | 1686655055663528 | `/med/open/v2/work_order/_doimport` |
| v2 base edit | 1686655055663530 | `/med/open/v2/work_order/_update_work_order_base_info`; code, plannedAmount 문자열, planFinishTime만 사용 |
| base/BOM/output detail | 1686655055663531 / 3539 / 3541 | 완전 readback adapter의 향후 근거 |
| 원료 목록 | 1681109889047028 | 문서 확인만; 이 작업에서 live master 호출 없음 |

서버 설정 `MES_PLAN_REVIEWED_CONTRACT`가 없으면 `tenant_contract_review_required`다. 유효 설정도 `reference`, tenant의 initial_status/report_flag/manual/no-auto warehousing 값, 해당 셋업 fingerprint를 명시적으로 검토해야 한다. 이 설정은 transport를 활성화하지 않는다. 모든 운영 claim은 항상 거부되고 HTTP send endpoint는 없다.

수정은 `task_quantity_propagation_and_allowed_state_review`로 계속 차단한다. base 계획량 수정이 모든 task에 전파되는지, 어떤 실제 상태에서 허용되는지 문서만으로 보장하지 않았다. BOM/제품/설비/금형/process/route 매핑은 tenant별로 아직 검증되지 않았다. 이전 설비 한 건 조회 성공은 모든 작업 매핑의 증거가 아니다.

## 격리 검증 결과

모든 테스트는 `.env`·운영 DB·실제 MES 토큰을 읽지 않는 독립 설정이며 외부 requests를 차단했다. PostgreSQL은 이 clone output의 별도 클러스터, Unix socket, TCP disabled였다. SQLite와 PostgreSQL migration은 disposable DB에만 적용했다.

| 검증 | 결과 | 실제 검증 범위 |
|---|---|---|
| PostgreSQL backend | 116 tests 통과 | 실제 두 스레드 prepare dedupe, upload/approve 경합, baseline backfill 및 기존 로그/계획 보존, 기존 upload 회귀, 계약/action/delivery 회귀 포함 |
| SQLite backend | 116개 중 114개 통과, PG 전용 2개 skip | 동일 서비스/API/기존 upload 회귀 |
| Migration check | 통과, No changes detected | `0016` 누락 변경 없음; PostgreSQL SQL은 기존 계획 2열 추가 및 신규 8테이블, 기존 schema 파괴 작업 없음 |
| Frontend lint | 통과 | 전체 프로젝트 ESLint |
| TypeScript / production build | 통과 | 실제 앱/Node 설정 typecheck, Vite modern/legacy build와 legacy CSS; 기존 500KB chunk 경고는 남음 |
| Frontend Node tests | 5개 통과 | 정확한 소요량 계산 2개, 기존 plan-save refresh 3개 |
| 실제 빌드 화면 | 14개 통과 | Playwright 1280×720, 한국어/중국어, 미확정 차단, 409 초안 유지, Django 승인 저장, 명시적 기본값, persistent request 재조회, 오류 후 기존 현황 유지, 가로 overflow 없음, runtime error 없음 |

연속생산 2,300개(D1~D4 08)에서 3,200개(D1~D5 08)로 같은 code를 유지하는 검증과 actual start 보존은 합성 backend 시험이다. 실제 MES에서 생성/수정 성공했다는 의미가 아니다. 화면도 전부 `SYNTHETIC` 데이터다. 기존 헤더의 일부 한국어 버튼 줄바꿈은 기존 레이아웃이며 이번 패널 범위에 포함하지 않았다.

검증 파일은 `output/plan-workflow/` 아래에 있으며 git에서 제외했다:

- `postgres-tests.log`, `backend-tests.log`, `migration-check.log`, `postgres-migration.sql`
- `build.log`, `lint.log`, `frontend-tests.log`, `browser-checks.json`, `browser-tests.log`
- `ko-work-order-preview-1280x720.png`, `ko-material-editor-1280x720.png`, `ko-material-action-1280x720.png`
- `ko-stale-draft-1280x720.png`, `ko-explicit-default-1280x720.png`
- `zh-preparation-1280x720.png`, `zh-empty-1280x720.png`, `zh-error-1280x720.png`

재현: `backend/.venv/bin/python scripts/check-plan-workflow.py`; PostgreSQL은 승인된 disposable socket을 `--postgres-test-socket=<이 clone output 하위 socket>`으로 지정한다. `--migration-check`, `--sql-migration`도 지원한다. 화면은 `--preview`, `frontend/scripts/build-plan-workflow-fixture.mjs`, `scripts/serve-plan-workflow-fixture.mjs`, `scripts/check-plan-workflow-browser.cjs`를 순서대로 사용한다. 새 패키지 설치 없이 기존 dependencies가 있어야 한다.

## 변경 파일

- 기존 backend: `injection/views.py`, `production/models.py`, `serializers.py`, `urls.py`, `views.py`.
- 신규 backend: `production/migrations/0016_plan_material_workflow.py`, `plan_workflow.py`, `plan_workflow_contract.py`, `plan_workflow_views.py`, `test_plan_workflow.py`, `test_plan_workflow_concurrency.py`.
- 기존 frontend: `domains/production/api.ts`, `pages/ProductionPlansPage.tsx`.
- 신규 frontend: `components/PlanWorkflowPanel.tsx`, `components/plan-workflow.css`, `plan-workflow-api.ts`, `plan-workflow-form.ts`, `tests/plan-workflow-form.test.ts`, `scripts/build-plan-workflow-fixture.mjs`.
- 신규 검증 scripts: `check-plan-workflow.py`, `check-plan-workflow-browser.cjs`, `serve-plan-workflow-fixture.mjs` 및 이 문서.

모델의 기존 index 이름과 ProductionPlanPart AutoField 선언은 이미 적용된 migration과 상태를 맞추기 위한 것이며 기존 index/ID schema 변경을 생성하지 않는다.

## 운영 전에 필요한 정확한 대상과 승인

1. 최신 main과 통합 검증 후 push/PR/merge 승인. 현재 commit은 로컬 clone에만 있다.
2. 운영 DB에 `production.0016_plan_material_workflow` 적용 승인. 기존 전체 계획 UID baseline backfill과 unique index 추가의 건수/잠금 시간을 staging에서 측정하고 백업·롤백 절차를 검토해야 한다. 운영에는 적용하지 않았다.
3. 담당자/기본원료 관리 역할 수용: 현재 기존 계획 edit 권한으로 원료 승인, superuser만 기본값 변경·MES 재조회. 권한은 변경하지 않았다.
4. 정확한 tenant, 제품, 호기/resource, 금형, BOM·단위/version, process/route, 工单 초기 상태와 창고 정책 검증. 운영 설정은 위 검토 근거와 허용 fingerprint를 명시적으로 추가해야 하며 그 자체로 writer가 켜지지 않는다.
5. 명시적인 한 건 시험 대상(제품/호기/수량/기간/원료/셋업) 승인 후 별도의 transport 및 완전 readback adapter 구현·검토. 생성 응답과 code 조회로 ID·구성원·BOM·수량·기간을 확인하기 전 재전송을 허용하지 않는다. 이번에는 시험 생성도 실행하지 않았다.
6. 실제 진행 상태에서 planned qty/end 수정 가능성, task 수량 전파, 실제 시작 보존 검증 승인. 입고 차이 상세 처리 정책은 계속 미확정이다.

08시 전체 下达, 라인 첫 순서 开工, 익일 미완료 마감 대기, 새 검사 자동 생성·승계·정지재개는 후속 범위다. 회사의 생산 중 2시간 검사 정책을 변경하지 않았다.

## 수용 기준 상태

로컬 수용: 기존 upload/화면 사용 독립, UID/version/이력, 보수적 동일성 확인, 원료·소요량 snapshot, 연속 사출/일별 가공 준비, immutable intent와 중복/불확실 결과 차단, 기본 OFF, 작은 화면 검증은 통과했다.

운영 수용: 모든 tenant 매핑·실제 생성/허용 수정·task 전파·캠페인 전체 readback·운영 migration/배포는 승인 및 후속 검증 대기다. 합성 테스트를 이 수용의 증거로 대체하지 않는다.
