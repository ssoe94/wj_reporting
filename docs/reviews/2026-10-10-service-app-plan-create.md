# 생산계획 → 원료 확정 → 서비스 APP 工单 생성

기준: `origin/main 294d4fc953a0296b49ae4db49b97ea15874cde68`.
독립 작업공간: `wj_reporting-service-plan`, 브랜치 `codex/service-plan-create-20261010`.
이번 결과는 로컬 구현과 합성 HTTP/DB/화면 검증이다. 운영 배포와 실제 MES 호출은 실행하지 않았다.

## 적용된 흐름

기존 계획 업로드·생산 현황은 그대로 사용한다. 기존 계획 UID/버전, 재업로드 차이 확인,
버전별 원료 승인 및 연속 사출/날짜별 가공 미리보기를 재사용한다.

1. 담당자가 MES 원료 목록과 유효한 단위를 선택하고 계획 버전별 원료·BOM/배합·설비/공정 snapshot을 확정한다.
2. 승인된 미리보기를 기존 `PlanWorkOrder`/`PlanMesRequest`에 저장한다. 서비스 APP 생성 계약은 품번별 서버 허용 목록 없이 만들어진다.
3. 쓰기가 켜진 경우 준비된 생성 요청을 선택하고 **선택 工单 MES 생성**을 누른다. 화면에서는 최대 50개를 선택하되 HTTP 요청당 최대 3개로 나누어 순차 전송하고, 완료된 묶음부터 행별 결과를 표시한다. 서버는 4개 이상인 요청 전체를 MES 인증/호출 전에 거절한다.
4. `exactWorkOrderCode`로 base 목록을 먼저 조회한다. 기존 工单이 있으면 import하지 않고 base detail을 확인한다.
5. 없으면 생성 시도 상태를 DB에 먼저 확정한 뒤 `_doimport`를 호출한다. 이후 code와 base detail로 생성 결과를 기록한다.
6. timeout이나 응답 유실은 자동 재전송하지 않는다. 같은 code의 읽기 재조회로 확인한다.

서비스 인증은 `inventory.mes`의 기존 APP 토큰 발급·캐시를 재사용하는 APP 전용 함수다.
USER OAuth/vault, worker 내 existing-only APP 공급, trial permit 및 `MES_PLAN_REVIEWED_CONTRACT`/`setup_fingerprints`는 공장 경로에서 사용하지 않는다.
현재 WJ 작업자 ID는 서버가 판단하여 요청 이벤트에 기록하며, 준비한 작업자의 기존 이력도 유지한다.
`MES_PLAN_WRITES_ENABLED` 하나가 공장 import 스위치이고 기본값은 **False**다.
초기 `status=1`, `reportFlag=1`은 코드 상수다. 下达·开工·입고·검사 생성은 호출하지 않는다.

## 계약과 결과의 범위

사용하는 업무 endpoint는 `/med/open/v2/work_order/base/_list`,
`/med/open/v2/work_order/base/_detail`, `/med/open/v2/work_order/_doimport` 세 개다.
[공식 HW import 문서](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1686645473258363&url=%2Fmed%2Fopen%2Fv2%2Fwork_order%2F_doimport)의 필드표와 기존 코드의 list/detail 계약을 사용했다.

`code==200`이고 선택 필드 `needCheck`가 없거나 정수 0이면 응답을 수락한다.
`needCheck=1`은 확인 대기로 남긴다. import ACK의 `data.id`는 필수로 가정하지 않으며 code 조회로 MES ID를 얻는다.
HTTP/본문의 명시적 401에 한해 APP 토큰을 한 번 갱신한다. 그 외 불확실한 쓰기는 재시도하지 않는다.
17자리 ID는 Python의 정확한 정수/JSON 및 프런트의 문자열로 보존한다.

생성 성공/기존 工单 확인은 **base의 ID·code·계획 시작/종료·상태 확인**만 뜻한다.
원료 적용, 계획량, 생산보고량, 입고량의 전체 검증을 뜻하지 않는다.
요청 증거는 `verified_scope=base_creation`, `material_assignment_verified=False`,
`production_totals_verified=False`로 이 한계를 보존한다.

확정 원료를 직접 보내기 위해 `useBomFlag=0`을 선택했다. inline 원료와 MES master BOM의 실제 우선순위는 tenant 시험으로 확인해야 한다.
가동 중 工单 수량/종료 수정은 기존 미리보기만 유지하고 실제 쓰기는 활성화하지 않았다.

## 변경과 동시 요청 보존

현재 계획 UID/버전·revision fingerprint·최근 원료 승인·계약 digest를 전송 전 재검증한다.
계획 종류 lock과 요청 row lock으로 한 요청의 생성 시도는 하나만 확정한다.
기존 checking 이벤트 ID로 조회 세대를 구분하여 늦게 도착한 재조회가 새로운 전송 상태를 덮어쓰지 못하게 한다.
조회 중이거나 이미 import를 시도한 미해결 요청은 계획 변경 후 새 요청으로도 재전송하지 못한다.
import 전 조회 실패(`failed`, attempt 0)는 최신 서버 조회 확인 후 명시적 재시도가 가능하다.
import 시도 이후 attempt 1은 읽기 재조회만 허용한다.

화면도 POST 중복 클릭·인증 자동 재전송·cached 실패 상태를 통한 재전송을 차단한다.
여러 묶음을 보내는 동안 최초 WJ 로그인 세션을 유지하며, HTTP 오류·응답 불확실·세션 변경이면 다음 묶음 전송을 중단한다.
앞서 완료된 행의 결과는 보존하고 실제 요청한 묶음만 불확실 상태/전송 제한에 남긴다. 미전송 행은 준비 상태로 남아 다시 선택할 수 있다.
원료 초안은 생성/재조회 중 유지하고, 미저장 초안이 있으면 생성 버튼을 잠근다.
기존 `mes_create_diagnostic*` 및 0017/0018 migration/table은 수정하지 않았다.
기존 진단 메뉴 연결만 사용 중단했으며 해당 코드와 이력의 정리는 별도 범위다.
이번에 신규 gate, permit, 진단 테이블 또는 migration을 추가하지 않았다.

## 실제 수행한 검증

- 격리 SQLite workflow 회귀 261건: 성공, PostgreSQL 전용 6건은 skip. 기존 업로드/재업로드·승인·이력/연속생산·전송 및 HTTP 상한 3건 허용/4건 거절 회귀 포함.
- 임시 PostgreSQL 17.10: 서비스 전송 41건 모두 성공. 기존 fixture 연결 오류 1건을 legacy 계약으로 수정한 후 동시성/이력 및 새 재준비 회귀 6건 모두 성공. 임시 서버 두 개 모두 정상 종료 확인.
- mock 사례: 정상 생성, 기존 code skip, timeout 후 복구/불확실 유지, needCheck 누락, 401 1회 갱신, 부분 실패, 17자리 ID, 버전/승인 변경, 조회·전송·재조회 동시 충돌.
- 프런트 Node 833/833 성공, lint 오류 0(기존 경고 39), TypeScript와 modern/legacy build 성공. 3/3/1 순차 전송, 50건의 17회 요청, 상한 초과/중복 선택 거절, 두 번째 timeout/응답 불확실/세션 교체 후 중단을 포함한다.
- `makemigrations production --check --dry-run`: 변경 없음. `git diff --check`: 성공.
- 실제 컴포넌트/스타일을 사용하는 localhost 합성 화면: KO/ZH, CSS 1280×720에서 6행·버튼·상태·MES ID 확인. 선택 2건 mock 생성의 성공/불확실 부분 결과와 OFF 상태를 확인했다.

증거: `output/service-plan-create-20261010/workflow-service-final.log`,
`postgres-service-concurrency.log`, `postgres-service-concurrency-followup.log`, `migration-check.log`,
`ui-results-ko-1280x720.jpg`, `ui-results-zh-1280x720.jpg`,
`ui-batch-mock-ko-1280x720.jpg`, `ui-off-ko-1280x720.jpg`.
프런트 로그와 source hash: `output/service-plan-ui-20261010/frontend-verification.json`.
3건 분할 수정의 별도 증거: `output/service-plan-chunks-20261010/frontend-verification.json`,
`output/service-plan-create-20261010/workflow-chunk-limit.log`,
`output/service-plan-chunks-20261010/ui-chunks-ko-1280x720.jpg`,
`ui-timeout-ko-1280x720.jpg`, `ui-timeout-zh-1280x720.jpg`.
캡처의 이름은 CSS viewport 기준이며 JPEG 실제 픽셀 크기는 화면 DPI에 따른다.
Chrome/운영 WJ 인증 화면은 이 검증에 포함하지 않았다.

## 운영 전 남은 확인과 다음 범위

사용자의 별도 명시 승인을 받은 테스트 1건(测试物料 code `0`, 1个, 초안 status 0)으로
WJ APP `_doimport` 권한, inline 원료 적용과 읽기 검증, 실제 ACK 구조를 확인해야 한다.
현재 작업에서는 그 시험·토큰 발급·권한 변경·운영 env 변경·migration 적용·push/PR/merge/deploy를 실행하지 않았다.
큰 선택은 3건씩 순차 HTTP 요청으로 나누지만 느린 단일 묶음의 timeout 가능성은 남는다. 이 경우 현재 3건까지만 불확실 상태로 남고 이후 묶음은 보내지 않는다. 실제 MES 지연과 Render/Gunicorn 제한은 운영 시험에서 확인해야 한다.
기존 제약: WJ 인증 만료나 writer OFF 거절이 예약 전 발생하면 해당 묶음은 UI에서 보수적으로 미확인으로 남지만 서버는 `disabled/attempt0`일 수 있다. 이 상태는 항목별 MES 재조회 대상이 아니므로 정상 로그인 후 전체 화면을 새로 읽어 서버 상태를 확인해야 한다. 새 3건 분할이 자동 복구를 보장하지 않는다.

이후 순서: 한 건 계약 검증 → 배포/수동 일괄 생성 활성화 → 연속 사출 工单의 허용 수량·종료 수정과 생산/입고 충돌 처리 → 가공 08시 下达/라인 첫 순서 开工 및 익일 마감 대기.
생산 중 2시간 검사 정책은 유지하며 검사 승계·정지/재개·자동 생성은 후속 MES 계약 검증 범위다.

수용 기준은 기존 계획 표시를 막지 않는 것, 현재 승인 버전만 생성하는 것,
같은 요청과 미해결 工单의 중복 import를 막는 것, 부분 결과/불확실 상태/ID/작업자 이력을 보존하는 것,
그리고 base 생성 확인을 원료·생산·입고 검증으로 확대 해석하지 않는 것이다.
