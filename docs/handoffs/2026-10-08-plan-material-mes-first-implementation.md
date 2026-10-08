# 생산계획 → 원료 확인 → MES 工单 준비: 첫 구현 검토

2026-10-08. 실제 MES writer는 OFF이며 생성·수정 호출, 생산 조작, 권한 변경, 운영 설정 변경, 운영 migration, 배포를 실행하지 않았다. push / PR / 원격 main merge는 하지 않았고 승인된 독립 브랜치의 로컬 main 통합만 수행했다.

## 최신 보완: 현장용 원료 상세와 한 건 시험 생성 bridge

사용자의 후속 지시로 `50d9e858` 이후 펼침 영역을 다시 정리했다. 내부 UID/version, 원본 시각, 로컬 준비번호, 조회되지 않은 실적의 `?`와 개발 용어를 일반 펼침에서 제거했다. 감사 데이터와 immutable snapshot은 삭제하지 않았다. 제품·설비 연결, BOM/물료 version·ID는 기존 superuser에게만 기본적으로 접힌 **관리자 연결 설정**으로 표시한다. 전송 기록과 로컬 준비번호는 **관리자 기록**에 격리했다. 일반 현장 계정의 DOM에는 이 진단 입력 자체가 없다.

현장 상세는 원료명·코드·배합·실제 단위·필요량과 날짜별 담당자 확인만 보여준다. 선택한 하루 1,000개의 소요량 20kg과 연속 工单 전체 2,300개의 소요량 46kg을 분리했다. 원료/배합 수정은 확인 체크를 해제한다. 409 발생 시 초안 보존·저장 차단 후 **최신 계획 확인**을 눌러 같은 명시적 UID의 현재 계획을 다시 읽고 수량·원료를 검토해야 한다. 삭제된 작업이나 작업 동일성이 바뀐 행은 자동 연결하지 않는다. 초안의 확인 사유·배합은 유지하며 현재 version과 승인 ID는 서버 검증을 계속 받는다.

`plan_workflow_trial.py`에 한 건 시험 생성용 trusted server bridge를 추가했다. HTTP/worker 진입점과 일반 전송 활성화 flag는 추가하지 않았다. 기본 상태는 비활성이다. `MES_PLAN_TRIAL_APPROVAL`이라는 **서버 내부의 별도 승인 기록**이 있어야 하며 다음 조건을 모두 검사한다.

- 정확한 요청 UID와 intent/contract digest, WJ actor와 MES 사용자/tenant/origin, 시험 제품·설비 코드, 수량·단위가 일치한다.
- 승인 시각~만료는 최대 30분이며 시험 master 확인 근거와 자동 下达/开工·입출고/backflush·검사 영향 검토 근거가 명시돼야 한다. 영향 관련 boolean은 근거에 결합된 검토 진술이며 MES 동작을 자동 증명하는 값이 아니다.
- 현재 사용자 권한·MES 연결 정책이 허용돼야 한다. 기존 APP 공급과 USER lease만 사용한다. APP 공급이 없으면 예약 전에 멈추고 발급·갱신으로 대체하지 않는다. 기존 broker의 사용자별 재확인·거절 처리·사용 기록 정책을 재사용한다.
- 먼저 사용자 인증을 확인하고 그 transaction이 끝난 뒤 요청 예약을 영속 commit한다. 다시 인증 잠금을 잡은 callback에서 현재 계획/승인을 검증하고 계획 lock을 유지한 채 한 번 생성한다. 예약 이후 timeout/인증 실패/불확실 결과는 재전송하지 않는다. 생성 뒤 전체 工单/BOM/산출/공정과 base clock을 재조회한다.

이 코드와 승인 기록은 운영에 설치/설정하지 않았다. 로컬 합성 sender와 모의 credential broker로 생성→전체 재조회, 동일 요청 재실행 차단, scope/만료/영향 조건 거절, APP 공급 없음, timeout의 영속 uncertain 상태를 검증했다. 실제 tenant의 기본 상태와 side effect, master 매핑, 인증·생성 성공을 확인한 시험이 아니다. 운영 UI의 생성 버튼이나 일반 worker 활성화도 없다.

### 이번 변경의 검증·캡처

| 검증 | 실제 결과 |
|---|---|
| SQLite backend·기존 upload 회귀·새 trial bridge | 141개 중 138개 통과·PG 전용 3개 제외 |
| 핵심 원료 계산/계획 저장 Node 시험 | 5개 통과 |
| 전체 lint / 변경 component·API lint | 오류 0·기존 경고 31 / 오류·경고 0 |
| TypeScript·modern/legacy 실제 앱 build | 통과; 기존 큰 chunk 경고 유지 |
| migration check | production 변경 누락 없음; 이번 변경은 신규 migration 없음 |
| 실제 앱 CUA·합성 계정/DB | 관리자/비관리자 표시 분리, 한국어/중국어, 펼침·원료 입력, 키보드 dropdown/Tab·Space 확인, 취소·초안 유지, 409 후 최신 계획 확인 전 저장 차단/재확인, 승인 저장·준비 요청 확인 |

목표 1280×720, 실제 CSS viewport 1280×719(기존 IAB 확대율 반올림), 가로 넘침 없음이다. 캡처는 브라우저가 반환한 1281×720 JPEG 원본이며 합성·리사이즈하지 않았다. 아래 세 파일을 다시 열어 내용·레이아웃을 확인하고 Library에 저장했다. 모두 **합성 fixture**이다. 일반 현장 계정의 editor 입력은 배합량·기준 제품수·확인 사유·확인 체크뿐이며 관리자 연결 설정은 DOM에 없다.

| 자료 | Library ID / version |
|---|---|
| 한국어 현장 상세 | `libfile_463a10b1713c81918ca9c75a5eda5b73` / 0 |
| 한국어 현장 원료 입력 | `libfile_d457f71963a081918e50b517eae76a5f` / 0 |
| 중국어 현장 상세 | `libfile_6204f6693c888191a4fa1805d369c495` / 0 |

로그는 `field-{backend-tests,frontend-tests,lint,lint-full,build,migration-check}.log`이다. 선택 실행용 browser script를 최신 문구/409 재확인에 맞췄지만 이번에는 문법 검사만 했고 화면 검증은 CUA로 수행했다. `--preview --field-user`와 fixture server의 `--field-user`로 비관리자 현장 계정을 재현한다. 이 옵션은 운영 권한을 바꾸지 않는다.

### 실제 MES 시험: 현재 막힘과 다음 묶음

Render connector의 workspace 목록 조회는 성공했다. 확인된 연결 계정은 `ssoe94@gmail.com`, 후보는 **My Workspace / tea-d14drsripnbc73f9nje0** 하나다. 선택된 workspace는 없고 서비스/DB 조회 도구가 **사용자에게 workspace를 확인한 뒤 해당 ID로 재호출**하라고 반환했다. 이 확인을 비동기 질문으로 요청했으며 답변 전 서비스/DB를 임의 선택하지 않았다. 이는 자동 승인 심사 거절이 아니다. CLI나 다른 경로로 이 선택 요구를 우회하지 않았다.

따라서 이번에는 실제 credential 상태·시험 품목/설비·과거 시험 패턴·tenant side effect를 조회하지 못했다. 신규 token/로그인/권한을 만들거나 비밀번호를 채팅으로 요청하지 않았다. 이전 완료 QC와 기존 실제 생산작업에도 접근/조작하지 않았다. 이전 회차의 로컬 credential 부재를 현재 Render 인증 상태의 결론으로 사용하지 않는다.

workspace 확인 뒤 다음 자료를 한 묶음으로 읽어 실제 시험 계획을 확정해야 한다.

1. WJ 서비스/DB와 배포 commit·필요 schema 적용 여부, 현재 계정의 기존 MES 연결/consent/만료 및 재사용 가능한 APP 공급(비밀값 제외).
2. 회사가 이미 사용하는 시험 제품·원료·단위/version·설비·금형·공정/route와 기존 격리 시험 工单의 명시적 근거. 테스트 문자열이라는 이유만으로 실제 master를 시험 대상으로 판정하지 않는다.
3. 생성 초기 상태/reportFlag, 자동 下达/开工·입출고/backflush·검사 영향, 취소/정리의 재고 영향과 감사 기록 잔존. 사실이 없으면 후보를 사용자에게 묶어 확인하고 전송하지 않는다.
4. 고유 시험 code, 최소 유효 수량·단위·배합, 계획 시작/종료, 원료 확인 actor 및 request digest를 고정한다. 생성 1회→ID/전체 내용 재조회→재업로드 수량/end 변경→원료 재확인→허용 상태 검증 순서로 진행한다. 불확실 결과는 조회만 한다.

**남은 구현 경계:** 생성 bridge는 로컬 구현됐지만 서버 설치/승인 기록·HTTP 진입점·운영 전역 활성화는 실행하지 않았다. qty/end 수정 실행 및 전체 캠페인의 보고량·순입고량/freshness adapter는 아직 미구현·차단이다. 기존 보고/입고 조회 계약은 취소·역처리와 순수량을 보장하지 않으며 task 수량 전파·수정 허용 상태도 확인되지 않았다. 실제 tenant 자료 없이 완성됐다고 가정하거나 단순 receipt 합계/boolean으로 채우지 않는다. 이 부분은 읽기 증거를 확인한 뒤 계약에 맞춰 구현·격리 시험해야 한다.

push·PR·배포, 운영 migration/전역 설정, 인증 발급·지속 접근 추가와 권한 확대는 실행하지 않았다. 실제 시험 생성 의도는 승인돼 있으므로 동일한 의도를 다시 묻지 않는다. workspace 선택과 시험 대상·영향처럼 아직 정해지지 않은 정보, 그리고 필요한 구체적 운영 적용/인증 행위만 확인한다.

아래의 이전 UI·transport 기록은 역사적 검증이다. 일반 생성 writer에 대한 기존 비활성 설명은 유지되며, 한 건 scoped trial bridge 없음이라는 부분만 위 로컬 코드 보완으로 대체한다.

## 이전 보완: 工单별 간결한 표와 원료 확인

생성 transport 보완 commit `d68a814f` 이후, 사용자의 작은 모니터 표 요구를 독립 브랜치에 구현했다. Product Design audit 지침을 기존 앱의 색상·14px 글자·38px 입력/버튼에 적용했다. 원본 checkout의 `.claude/settings.local.json` 수정과 `output/`는 그대로 보존됐으며 충돌은 없었다.

- 서버가 검증한 연속 사출 묶음 또는 날짜별 가공 工单을 한 행으로 표시한다. 품번/工单, 호기, 기간 08→08, 계획량, 원료, 확인 상태, 행 동작을 나란히 배치했다. 클라이언트에서 작업을 추측해 합치지 않는다.
- 주원료 선택은 해당 행 안에서 한다. 배합·추가 원료·단위/물료 version·셋업 상세는 기본적으로 접혀 있다. 연속 묶음 총량과 선택한 일자·version의 승인 수량을 분리해 표시한다. 조회 기간 밖 날짜는 기간을 넓혀 승인해야 한다.
- 실제 MES ID가 없으면 `준비중 · MES 생성 전`으로 표시한다. 영속 로컬 준비번호는 확장 상세에서만 그 이름으로 표시한다. 실제 17자리 MES ID는 문자열 그대로 표시하며 숫자로 변환하지 않는다.
- 원료/배합/셋업 변경 시 확인 체크를 해제하고 미저장 초안으로 표시한다. 취소, 다른 행/공정/종료일 이동, 패널 접기 전에 초안 버림 여부를 묻는다. 계속 편집하면 입력을 보존한다. 409 응답은 초안을 보존하고 승인 체크를 해제한다. 이 보호는 패널 내부 동작 범위이며 SPA 전체 이동이나 브라우저 종료의 초안 보존을 추가한 것은 아니다.
- 승인 snapshot, 단위/ID 검증, 일회 대체와 기본원료의 구분, 영속 요청 및 중복 방지, 기존 생산계획의 비차단 사용을 유지했다. 요청 이력은 별도 접기 영역에 남는다. 운영 writer·검사 생성·08시 개시·마감은 계속 비활성이다.

### 최신 검증과 화면 증거

| 검사 | 이번 UI 변경 뒤 결과 |
|---|---|
| SQLite backend / 기존 upload 회귀 | 138개 중 135개 통과, PostgreSQL 전용 3개 제외 |
| 원료 계산 / plan-save refresh Node tests | 5개 통과 |
| 현황판 상태 / 원료 계산 추가 Node 검증 | 17개 통과; 위 계산 시험 일부 중복 |
| migration check | production 변경 누락 없음; 이번 UI는 schema 변경 없음 |
| 전체 ESLint | 오류 0, 기존 경고 31; 변경 component/API 단독 검사 경고·오류 0 |
| TypeScript / 실제 앱 modern·legacy build | 통과; 기존 큰 chunk 경고 유지 |
| 실제 앱 CUA / 합성 Django fixture | 6개 工单 행, 한국어/중국어, 일자별 version, 키보드 원료 선택·Tab/Space 체크, 취소/계속 편집, 접기 초안 보호, 2원료 정확한 20kg/10kg 계산, 409 재확인, 승인 저장, 요청 1건 영속/재로드 중복 없음, 가공 빈 상태, workflow 503 중 기존 계획 사용 확인 |

작은 모니터 목표는 1280×720이다. IAB 확대율 반올림 때문에 실제 CSS viewport는 1280×719였으며 이 크기에서 가로 넘침 없이 6개 행을 확인했다. 기본 행 높이는 약 57px, 긴 합성 품번은 약 75px이다. 브라우저 원본 캡처는 1281×720 JPEG이며 리사이즈·합성하지 않았다. 촬영 장면은 모두 `SYNTHETIC` 데이터와 로컬 준비 상태이고 실제 MES 조회/생성의 증거가 아니다. 한국어 편집 캡처의 상태 세부 문구는 최종 저장상태 문구 축약 직전 빌드이며 편집·초안 동작은 동일하다. 최종 중국어 표는 마지막 빌드다.

검토용 Library 파일은 다음과 같다. 기존 이미지와 별도 identity로 저장했다.

| 캡처 | Library file ID | version |
|---|---|---|
| 한국어 工单별 표 | `libfile_8dd533fea74c8191a19fe726e06e5977` | 0 |
| 한국어 행 원료 선택·접힌 상세 | `libfile_e6e89c7937a48191bc4b0a3f587f144c` | 0 |
| 중국어 최종 표·영속 준비 상태 | `libfile_9e2d4f33f5f081918bcd694ecc65436b` | 0 |

로그는 `output/plan-workflow/compact-{backend-tests,frontend-tests,migration-check,lint,build}.log`에 있다. 갱신한 `check-plan-workflow-browser.cjs`는 문법 검사만 했으며 이번 화면 검증은 CUA로 수행했다. 갱신 스크립트를 실행한 자동화 시험으로 보고하지 않는다. fixture 장애 제어는 루프백 검증 서버에만 있다.

### 실제 MES 검증의 남은 막힘과 최소 다음 단계

승인된 읽기 확인을 위해 현재 환경의 MES APP/USER credential과 기존 연결 화면을 좁게 확인했지만, 사용 가능한 credential/DB 연결이나 WJ 연결 탭이 없어 실제 조회를 진행하지 못했다. 새 토큰 발급, 로그인, credential refresh, 권한 변경으로 대체하지 않았다. 기존 broker의 APP 토큰 발급/사용 기록 갱신 역시 이번 읽기 확인으로 실행하지 않았다.

다음 단계는 기존 서버에서 **갱신 금지의 bounded read-only probe** 한 번으로 현재 USER identity, 실제 master ID/unit/resource/version 및 지정 工单의 네 상세 권한을 확인하고 비밀값 없이 결과를 반환하는 것이다. 사용 가능한 기존 APP 토큰이 없으면 그 한 번의 발급은 별도 승인 대상이다. 확인할 tenant와 비운영 시험 工单/제품·호기를 먼저 지정해야 한다. 현재 실제 master 매핑, 보고·순입고량/상태 adapter, qty/end 실행 transport와 운영 bridge는 미검증 또는 미연결이므로 생성·수정 운영 수용 완료로 보고하지 않는다. 위조하거나 일반 flag로 우회하지 않는다.

이번 보완은 표 UI·원료 확인 사용성에 대한 로컬 수용을 완료한다. 아래 생성 transport 및 운영 수용 기준은 그대로 남는다. push/PR/배포와 운영 migration·설정·시험 쓰기는 요청과 명시적 승인 전 대기한다.

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
