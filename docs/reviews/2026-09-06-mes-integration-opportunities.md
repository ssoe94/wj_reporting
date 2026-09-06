# MES 연동 데이터 활용과 개발 우선순위

검토일: 2026-09-06. 기준: `fd92316`과 사출 업무 개선 작업 트리. 이 문서는 코드·기존 기술 문서·한정된 MES 화면의 필드 구조 관찰을 연결한 개발 검토다. 운영 수량, 품번, 사용자 이름, 인증 정보, 원본 응답은 포함하지 않는다. 실제 API 권한, 수집 작업 실행 이력, 전체 데이터 완전성을 전수 확인한 문서는 아니다.

## 판단과 권장 순서

새 MES 메뉴를 통째로 복제하는 것보다 **이미 저장하는 생산보고 원장을 설명 가능한 대사 근거로 재사용하는 일**의 효과가 크다. 현재 사출 실적은 형합 증가량과 Cavity·계획 배분에 의존하는 추정값이고, MES 사출 `ZS` 보고도 별도의 원장에 수집한다. 이 둘을 합산하거나 즉시 대체하지 말고, 보고 단위·품질 상태·실제 실행 구간을 확인하면서 차이의 원인을 찾는 자료로 연결한다.

우선순위는 다음과 같다.

1. 저장된 자료만 읽는 수집 상태·보고 원장 요약을 만든다. 자료 없음과 수량 0, 최근 성공 수집과 최근 생산보고를 구분한다.
2. 생산보고의 단위·품질 상태·작업/task·공단/작업지시 식별자를 검증하고 보존한다. 신고 수량을 양품·입고·출하 수량으로 바꾸어 부르지 않는다.
3. 설비·품번·실행 구간의 연결을 확정해 형합 추정 ↔ MES 보고 ↔ 현장 불량 ↔ 재고 이동을 대사한다.
4. 수요·BOM·투입/반납·납기 이벤트를 확인한 뒤 원료 소요·수율·납기 지표를 확장한다. 화면 메뉴의 존재만으로 API 제공이나 데이터 충실도를 확정하지 않는다.

## 근거의 등급과 점검 범위

| 등급 | 이번에 확인한 범위 | 해석의 한계 |
| --- | --- | --- |
| 코드 확정 | 아래 Blacklake 호출 함수, 정규화 필드, 저장 모델, 로컬 API와 화면 소비자 | 구현 존재를 뜻한다. 현재 운영 권한·정기 수집 성공·충분한 데이터 보존은 별도 확인이 필요하다 |
| UI 표본 관찰 | 로그인된 MES 생산보고 첫 페이지에서 ZS/사출과 JG/가공의 보고 구조를 확인했다. 설비, 생산 task 번호, 공정, 품질 상태, 수량, 단위, 식별 코드, 공단 번호가 채워진 행을 관찰했다 | 편의 표본이다. 전체 보고의 품질 상태나 결측률로 일반화하지 않는다. 화면의 필드명과 OpenAPI JSON 키가 같은지도 미확인이다 |
| UI에서 공백 관찰 | 같은 표본에서 배치번호·시작·종료·공수·주문번호가 비어 있는 행을 확인했다 | 실제 작업이 없었다는 뜻이 아니다. 실행 구간·노무시간·납기 연결의 입력 또는 별도 원천을 확인할 사유다 |
| 메뉴만 확인 | 用料清单, 投料记录, 撤回, 领退补料, 工序计划, 任务, BOM, routing, workCenter, 生产过程原因 | 사용 권한, API, 반환 필드, 입력 실적은 미확인이다 |
| 미확인 | 工序报工统计의 별도 BI 화면 내용, 품질·재고 세부 화면의 추가 표본 | BI 화면이 비어 읽히거나 브라우저 제어가 중단된 범위다. 빈 데이터나 미사용 기능으로 단정하지 않는다 |

이번 문서 작성자는 운영 API/DB를 추가 조회하지 않았다. UI 관찰은 주 작업의 읽기 점검 결과를 전달받아 기록했다. API 전체 지원 목록은 Blacklake 공식 스키마·권한이 확인된 뒤 보완해야 한다.

## 현재 코드로 확인되는 연동 인벤토리

Blacklake 경로는 공통 `/api/openapi/domain/web/v1/route` 아래의 경로를 표기했다. `POST` 조회 API도 원천 데이터를 변경하는 작업은 아니다. 아래는 **현재 소스에 구현된 호출**이며 Blacklake 제품 전체 API 목록이 아니다.

| 데이터와 Blacklake 조회 경로 | 코드가 읽거나 저장하는 필드 | 현재 사용과 확장 기회 |
| --- | --- | --- |
| 설비 파라미터 `/resource/open/v1/resource_monitor/_page_list` | `deviceCode`, 조회 시작/끝, parameter ID/code/name, `recordTime`, `val` → 설비·시각·형합 누적계수·오일온도·누적전력 | `InjectionMonitoringRecord`와 rollup, `/api/injection/production-matrix/`, 모니터링과 생산 canonical. 실제 측정 시각·수집 성공 범위·parameter 단위 보존이 우선이다. [호출](../../backend/injection/mes_service.py#L92), [정규화](../../backend/injection/mes_service.py#L195), [모델](../../backend/injection/models.py#L475) |
| 생산보고 `/mfg/open/v1/progress_report/_list` | report detail/record ID·code, `reportTime`, `processCode`, 첫 설비, 자재 코드/명, `reportBaseAmount.amount`; 전체 행은 `raw_payload` | `ZS`와 `JG`를 저장. `/api/production/mes-report-stats/`, 가공 수기 대사에 사용. 사출 보고 원장도 존재하지만 새 모니터링의 중복 추정 대사표는 제거했다. 원장 조회·연결 검증을 별도 관리 화면에 둔다. [수집](../../backend/production/management/commands/sync_mes_progress_reports.py#L52), [모델](../../backend/production/models.py#L285), [stats](../../backend/production/views.py#L1824) |
| 현재 재고 `/inventory/open/v1/material_inventory/_list` | 자재 ID/code, label/QR·카트, 창고·위치, 보관/품질 상태, 첫 work order, 수량·단위·`updatedAt` | 현재고·재고일보·원료 재고 상세. 품질 보류와 가용재고 구분, 자재/작업지시 연결의 출발점이다. 전체 work-order 목록은 staging에서 첫 항목만 정규화한다. [호출](../../backend/inventory/mes.py#L149), [저장 필드](../../backend/inventory/management/commands/fetch_inventory.py#L250), [모델](../../backend/inventory/models.py#L69) |
| 재고 변동 `/inventory/open/v1/material_inventory/_list_change_log` | 자재·창고, 변동 수량/방향/단위, action, 생성시각; 원료 서비스는 배치·문서 관련 상세도 활용 | 원료 입출고와 완성품 12시간 입출고 스냅샷. 재고 이동은 공정 실소비·고객 출하와 동일하지 않다. action·문서·주문 관계를 확인해야 한다. [호출](../../backend/inventory/mes.py#L195), [원료](../../backend/inventory/services/raw_materials.py#L996), [완성품 집계](../../backend/inventory/services/finished_goods.py#L209) |
| 출고 지시 `/inventory/open/v1/outbound_order/_list` | 출고단/품목행, 계획시각, 창고·종류·취소 상태, 품목, 단위, `planAmount`, 현재 누적 `doneAmount` | overview의 JIT/CSKD 이행·미출고 상세. 이미 EA 단위 필터와 제외 사유가 있다. 실제 출하일 기준 실적이나 OTIF는 별도 이벤트가 있어야 한다. [호출](../../backend/inventory/services/outbound_performance.py#L33), [정의](../../backend/inventory/services/outbound_performance.py#L273), [단위 검증](../../backend/inventory/services/outbound_performance.py#L914) |
| 금형 custom object `.../custom_object/list`, `.../detail`, `.../page_son_object`, metadata 조회 | 이력번호·자산/금형·모델·Cavity·위치, 생산/이동/수리/보전 자식 이력; 실제 테넌트 명칭과 metadata로 매핑 | 금형 board/detail와 overview의 상태·보전 추세. 이미 일부 지표가 구현되어 있으므로 새 빈 메뉴를 추가하기보다 미수신 상세·지연 목록의 조치 연결이 우선이다. [엔드포인트/매핑](../../backend/injection/mould_service.py#L39), [스냅샷](../../backend/injection/models.py#L524) |
| 금형 resource `/resource/open/v2/resources/resource_mold/list`, `.../detail`, 운영 log `_list`/`_detail` | 자원 ID/link code, 현재 사용량, 수명·보전·수리·자원·이동·잠금 상태, 위치, 원천 수정시각 | custom object와 자원 상태를 병합한다. 금형 ID·실제 설비 장착 시작/끝이 확정되면 계획 준비도·실행 이력 연결이 가능하다. [경로/필드](../../backend/injection/mould_service.py#L53), [소스별 시점 처리](../../backend/injection/mould_snapshots.py#L132) |

로컬 조회/작업 API 전체는 [생산 라우팅](../../backend/production/urls.py), [재고 라우팅](../../backend/inventory/urls.py), [사출 라우팅](../../backend/injection/urls.py)을 기준으로 확인한다. 모니터링 화면이 제공하는 과거·설비 필터는 로컬 저장 자료를 조회하며 화면 열 때 Blacklake 전 기간을 다시 수집하지 않는다.

## 데이터가 있는데도 판단에 충분히 쓰기 어려운 이유

### 생산보고: 저장은 하지만 단위와 신고 성격을 평탄화한다

`extract_qty()`는 `reportBaseAmount.amount`를 정수 반올림하며 파싱 실패를 0으로 바꾼다. 정규화 모델에는 품질 상태·보고 단위·생산 task·공단/작업지시 연결 필드가 없다. 원본 행에 해당 값이 들어오면 `raw_payload`에 남을 수 있으나, 현재 코드는 그 JSON 키의 존재나 의미를 검증하지 않는다. 따라서 UI에서 보인 ‘合格’가 모든 저장 보고에 적용된다고 가정할 수 없다. [변환](../../backend/production/mes_progress.py#L156), [저장](../../backend/production/management/commands/sync_mes_progress_reports.py#L75)

현재 stats의 `matched`는 **계획 수량과 보고 수량이 모두 양수**인 상태다. 수량이 일치한다는 뜻이 아니다. `plan_only`도 수집 완전성 없이 미보고를 확정할 수 없고, 유효한 0 보고가 있더라도 양수 조건 때문에 그 의미가 사라질 수 있다. read-only 대사 화면에서는 보고 행 존재·유효 수량 존재·수량 차이를 별도로 표시해야 한다. [분류 조건](../../backend/production/views.py#L1933)

사출은 설비+품번으로, 가공 stats는 품번으로 묶는다. 같은 품번의 여러 task/LOT/교대가 합쳐지며, 같은 업무일에 생산하고 다음 업무일에 신고한 수량도 발생일을 자동 복원할 수 없다. 신고일과 실제 생산일을 별도 축으로 두고, 차이를 생산 손실 또는 입고 누락이라고 단정하지 않는다. 가공의 기존 `credit_business_date`·대사 이벤트 계약은 사출의 후속 설계에 참고할 수 있다. [집계 키](../../backend/production/views.py#L1854), [가공 계약](../rebuild/21-machining-mes-first-manual-reconciliation.md)

### 시간대 원천: 저장 시각과 실제 센서 관측 시각이 다를 수 있다

정기 snapshot 수집은 목표 분의 앞뒤 1분에서 가장 가까운 원천 값을 고른 다음, 원천 `recordTime` 대신 `target_timestamp`로 저장한다. 현재 `source_latest_at`와 slot coverage는 **저장된 형합 관측의 근거**다. 원시 센서 이벤트를 빠짐없이 저장했다는 의미가 아니며, 한 slot의 샘플 존재도 전 구간의 완전한 관측을 보장하지 않는다. [선택·저장](../../backend/injection/mes_service.py#L965)

이번 matrix 증분은 저장된 계수 샘플의 증가량을 reset-aware 규칙으로 계산하고 관측 mask·설비별 상태·원천 조회 범위를 제공한다. 형합 정책과 전력 정책은 별개다. 예전 rollup에는 계산 버전이 없어 이를 사용한 경우 ‘정책 미확정’ 경고를 보존한다. 원시 계수의 정확한 수집·보존을 고치기 전에는 모니터링 합계를 최종 일일 ea 결산으로 대체하지 않는다. [matrix 구현](../../backend/injection/mes_service.py#L691), [프런트 상태 계약](../../frontend/src/domains/mes/monitoring-state.ts)

### 재고·출고·금형: 현재 상태와 발생 이벤트를 나누어야 한다

현재고는 조회/수집 시점의 snapshot이고 원료 일일 증감은 보존된 두 08:00 snapshot 비교다. 창고 이동·상태 변경을 자재 소비로 해석하지 않는다. outbound의 `doneAmount`는 계획시간으로 분류한 주문의 현재 누적 이행량이다. 과거 계획기간을 조회해도 당시 마감시점의 완료량이 복원되는 것은 아니다. 금형 최신 상태도 선택 업무일 당시 위치/보전 상태와 구분한다. [원료 일일 기준](../../backend/inventory/services/raw_materials.py#L1352), [출고 기준](../../backend/inventory/services/outbound_performance.py#L273)

완성품 변동 수집의 pagination은 total이 0/없을 때 첫 페이지에서 종료할 수 있는 코드 경로가 있다. 변동 방향이 없으면 inbound로 간주하고, 물량 변환 실패는 0으로 처리하며, 집계 키도 품번 중심이다. **이것이 운영 데이터에서 발생했다는 확인은 아니다.** 이 경로를 납기·생산입고 대사의 원천으로 확장하기 전에 page 완전성·단위·방향·event ID의 fixture 검증을 먼저 한다. [페이지 종료](../../backend/inventory/services/finished_goods.py#L162), [변동 변환](../../backend/inventory/services/finished_goods.py#L92), [집계](../../backend/inventory/services/finished_goods.py#L271)

## 바로 구현할 수 있는 작은 read-only 후보

| 우선순위·후보 | 읽는 저장 자료와 최소 응답 | 경영/실무 화면과 완료 조건 |
| --- | --- | --- |
| P0 · 생산보고 근거 요약 | 단일 업무일 `ProductionMesReportRecord`: 공정·설비별 보고 행 수, 유효/파싱불명 수량, 첫/마지막 신고시각, 마지막 저장시각, 계획만/보고만/양쪽 자료 목록 | `/production`의 ‘MES 보고 근거’ 섹션. `/analysis`는 요약과 주의 링크만 사용. 외부 API 호출 0회, 08:00 경계·ZS/JG 구분·실제 0 보고·빈 원장·잘못된 수량 테스트. 수량은 단위 검증 전 ‘기존 신고 수량’으로 제한하고 양품/입고 라벨 금지 |
| P0 · 보고 필드 완전성 감사 | 저장 `raw_payload`에서 확인된 허용 키만 집계. 단위/품질/task/order 연결의 valid/missing/invalid, 미인식 enum, 여러 설비/작업지시 존재 수 | 데이터 관리용 summary. 원본 JSON·개인 이름을 브라우저나 공개 보고서에 반환하지 않는다. UI 라벨만 보고 API 키를 추측하지 않는다. 작은 비공개 schema 표본에서 키와 의미를 확정한 뒤 구현 |
| P0 · 수집 근거 패널 | 저장 자료의 기간별 min/max/count, 설비별 관측 슬롯, null parameter 수, 정책 버전, 기존 snapshot 오류 | 새 테이블 없이 먼저 조회할 수 있다. ‘신규 보고 없음’과 ‘수집 실패’는 **실행 원장이 없으면 분리 불가**라고 표시. 뒤이어 collector 실행 원장을 추가해야 수집 성공률로 승격 가능 |
| P1 · 대사 대상 목록 | 같은 업무일·설비·정규화 품번의 계획/보고/추정 원천을 각각 제시. 근거가 불완전하면 차이 null. task/LOT 미연결 상태를 포함 | `/injection/dashboard`에서 공통 실적, `/production`에서 대사, `/mes/monitoring`에서 시간대 근거 확인. 모니터링에 ea 계산식을 다시 만들지 않는다. 근거 양쪽 없음·정상 0·단위 불일치·늦은 보고·복수 계획을 회귀 검증 |

첫 후보의 범위는 “저장된 보고가 무엇인가”다. 수집기나 회계적 실적 확정 로직을 바꾸지 않으므로 작은 증분으로 검토하기 좋다. 다만 현재 `report_qty`만 읽으면 파싱불명과 원래 0이 구분되지 않으므로 strict 원본 변환을 거친 `quantity_state`를 별도로 두어야 한다. 기존 응답의 0을 그대로 믿는 새 차트는 추가하지 않는다.

## 후속 데이터 계약과 연결키

| 목적 | 추가 보존·검증할 데이터 | 연결과 grain | 수집/확정 시점 제안 |
| --- | --- | --- | --- |
| 수집 실패·누락 판단 | collector run ID, source, 요청 범위/필터, 시작·종료·성공시각, 원천 min/max 시각, page/행 수, 거절/중복 수, 종료 이유, schema/계수 정책 버전, watermark | 실행 ID + 원천 + 요청 scope. 생산량과 별도의 운영 원장 | 매 실행. 완전 성공 후에만 watermark 전진; 부분 실패는 실패 범위 재시도 |
| 생산보고 실적의 의미 | 원본 detail ID, 개정/취소 여부, 생산 task·공단 ID, report time/updated time, 실제 시작·종료, 수량 Decimal, 단위 ID/명, 품질 상태, 보고 종류, 원본 hash | source detail ID를 원장 PK로, `task_id`를 실행과 연결. 설비/품번/업무일은 보조 대사 키 | 2~5분 증분은 후보. 최근 변경의 중첩 창과 일일 재대사 필요. 실제 API 수정일/취소 기능을 먼저 확인 |
| 생산 구간 확정 | canonical execution segment ID, task/계획행 ID, 설비 ID, 품번 revision, 금형 ID, Cavity/막힌 cavity, 시작/종료, 시험/양산, 승인 관계 | 한 실제 설비의 한 실행 구간. 현장 event·수기일보·MES 보고를 관계로 연결하고 합산하지 않음 | 작업 전환·교대 마감·정정 때. 정정 전후 이력 보존 |
| 검사·재작업·양품 | inspection event ID, 대상 LOT/segment, 검사 수량, 1차 양품/불량/미검사, 재검사·재작업 부모 이벤트, 처분, 발생 설비의 직접 근거 | 검사 이벤트 단위. 현재 계획의 동일 품번만으로 과거 불량 발생 설비를 지정하지 않음 | 검사/재검사/처분 시. 대상·검사 방식이 같은 분모에서만 비율 계산 |
| 원료 실소비·수율 | BOM revision·유효일·환산단위, 투입/반납/폐기 이벤트 ID, 원료 LOT, 계량량 kg, task/segment, 스크랩·재생재 처리 | material+LOT+task/segment+event. 재고 감소와 실소비를 분리 | 투입·반납 시; 교대 kg 수불과 일일 창고 이동 대사 |
| 납기 피드백 | 주문 라인 ID, 약속납기와 수정버전, 실제 출하 이벤트 시각/수량/단위, 분할·취소·반품, 출고단 line ID | 주문라인↔출하 이벤트의 다대다 연결. `planTime`/누적 `doneAmount`와 별도 축 | 계획/출하 변경 시. 일일 계획 코호트 합계와 실제 이벤트 합계 교차 검증 |
| 설비 효율·에너지 | 근무/휴일/휴식·계획보전, 실제 정지 시작/끝·사유·확인자, 표준 C/T 유효일, 계기 ID·단위·배율·리셋 이벤트 | 설비×실제 가동계획 구간. 전력은 동일 계기·측정기간에 한해 합산 | 계획 변경·정지 확인·계기 변경 시. 검증 전 OEE/절감액을 계산하지 않음 |

추천 주기는 설계 초안이며 운영 스케줄 변경 지시가 아니다. 호출 한도·재시도·페이지 수·사용자 권한·허용 지연을 측정한 뒤 정한다.

## 수집·보관·오류 처리의 구현 순서

현재 Celery 코드에는 모니터링 120초, 완성품 08:00/20:00 수집이 선언되어 있다. 이는 실제 스케줄러가 가동한다는 증거가 아니다. 생산보고 명령은 처음 24시간, 이후 최근 5분을 조회하는 기본값이고, 이번에 읽은 Celery schedule에는 이 명령이 없다. 외부 scheduler 여부와 실행 공백은 운영 이력으로 확인해야 한다. [schedule](../../backend/config/celery.py#L22), [생산보고 명령](../../backend/production/management/commands/sync_mes_progress_reports.py#L25)

1. **수집 실행 원장부터**: 통신 성공·응답 성공·전체 페이지 수신·정규화 성공·저장 성공을 따로 기록한다. `latest_report_time`이 오래됐다는 이유만으로 수집 장애를 확정하지 않는다. 수집 중단 후 고정 5분 창만 재개하면 공백이 남을 수 있으므로 마지막 성공 watermark와 중첩 조회를 사용한다.
2. **원시 관측과 snapshot을 분리**: `observed_at`과 `collected_at`, 원천 event/parameter ID·단위, 원본 계수, 보정 계수·버전을 구분한다. 최근 관측을 한 slot에 맞추어 저장하는 경우에도 원시 시간과 선택 규칙을 잃지 않는다.
3. **계산 버전을 보존**: raw→시간대→일일 집계의 각 grain, 업무일 경계, reset·단위·Cavity 적용 정책을 기록한다. 원시 없는 과거 rollup은 새 정책으로 정확히 재현할 수 있다고 가정하지 않는다. 재생성은 영향 비교와 별도 승인된 운영 절차로 수행한다.
4. **Mac Studio 보관을 확인 가능한 운영으로**: 저장소의 로컬 수집기는 production matrix를 SQLite와 JSON에 보관하며 minute 기본 보존은 60일이다. 그러나 정규화 테이블은 새 관측 mask·정책·원천 시각 필드를 아직 보존하지 않는다. raw JSON만 남는 구조를 재검토하고 설치 경로·실행 이력·백업 복원을 점검한다. 이 문서에서 실제 설치나 보관을 확인한 것은 아니다. [수집기](../../scripts/mes_collector/collect_mes_minute_logs.py#L15), [스키마](../../scripts/mes_collector/collect_mes_minute_logs.py#L34), [압축](../../scripts/mes_collector/collect_mes_minute_logs.py#L149)
5. **보관 기간 합의**: 고해상도 raw 60~90일, 업무일 확정집계 13개월 이상은 분석 목적을 위한 제안이다. 용량·계약·복구 요구에 맞게 결정한다. 원료·현재고·금형 snapshot의 범위 키와 과거 보존을 점검하고 ‘현재 최신’ 캐시를 역사 테이블로 오인하지 않는다.
6. **권한과 오류를 API 경계에서 표준화**: 현재 inventory 쪽은 credential을 지우는 오류 정리가 있지만 모든 MES wrapper가 동일 경로를 사용하지는 않는다. source 코드·안전한 오류 코드·request ID만 노출하는 공통 어댑터를 사용한다. 관리자 분석의 원본 보고/작업 식별자는 인증·역할별 API에 두고, 현장 공개/전광판에는 필요한 집계만 전달한다. 토큰을 URL·사용자 오류·공개 문서에 남기지 않는다. [오류 정리](../../backend/inventory/mes.py#L42), [생산보고 wrapper](../../backend/production/mes_progress.py#L26), [현행 금형 공개 경계](../../backend/injection/mould_views.py#L462)

기존 [로컬 로그 전략](../rebuild/mes-local-log-strategy.md)의 1분 수집 설명과 현재 2분 Celery 선언은 다르다. 문서·코드·실제 스케줄을 대조하고 인계 문서에서 실제 검증한 값만 운영 기준으로 확정해야 한다.

## 화면 구성과 개발 순서

| 화면 | 남겨야 할 핵심 | 다음 개발 |
| --- | --- | --- |
| `/analysis` | 업무일 공통 KPI, 자료의 신뢰 상태, 경영진 확인 항목과 실무 상세 링크 | 수집 누락/대사 미해결/입력 미확정 목록. 확인자·기한·종결을 붙이면 차트보다 업무 피드백이 좋아진다 |
| `/injection/dashboard` | 사출 canonical 일일 추정, 같은 날짜·설비의 현장/일보 기록, 현장 입력으로 이동 | MES 신고 원장 상태와 연결 진척 요약. 공통 segment ID가 확정되면 해당 구간을 함께 조회 |
| `/mes/monitoring` | 선택 설비의 시간대 shot·온도·전력, 관측 공백, C/T·전환 확인 | 원시 `observed_at`과 저장시각 차이, 계수 reset 근거. ea 계획 배분과 보고 대사 계산은 관리 화면으로 연결 |
| `/production` | 계획/task 실행, 신고 원장, 수기 보정, 대사 | 위의 read-only 보고 근거 요약을 우선 추가. ‘입고’·‘양품’ 용어는 원천 계약 검증 후 사용 |
| 현장 `/field/immNN` | 현재 작업·신고·확인 입력 | 새 양식을 중복 추가하기 전에 실행 구간 ID와 입력 마감/정정 책임을 통일 |
| 품질·재고·금형 상세 | 해당 원천의 대상·기간·단위와 업무 조치 | 메뉴 축소는 이용률/업무행동 데이터를 확인한 뒤 결정. 행 0건만으로 미사용 페이지라 부르지 않음 |

완료 순서는 **보고 원장 read-only 요약 → collector 실행 이력 → 단위·품질·task 연결 → 실제 구간 대사 → 자재/납기 확장**이다. 새 MES 쓰기 연동이나 생산실적 자동 확정은 이 순서의 첫 증분에 포함하지 않는다.

## Mac Studio에서 확인할 질문과 인수 조건

- MES 보고의 task/공단/품질/단위/취소·수정 정보는 어떤 OpenAPI 키로 제공되는가? UI의 생산 보고가 재고 입고를 동시에 발생시키는지, 별도 승인·이동이 필요한가?
- 보고의 실제 발생일을 보존할 필드가 있는가? 없으면 누가 어떤 증거로 발생일을 확인하는가?
- 생산보고 정기 실행은 어디에서 돌고, 마지막 완전 성공 watermark와 중단 후 복구는 무엇인가?
- 자재 투입·반납·BOM·공정 원인 메뉴에 읽기 API 권한이 있는가? 실행 task와 LOT까지 같은 ID로 연결되는가?
- raw·rollup·로컬 로그의 실제 보존과 복원은 검증됐는가? 원시 계수를 삭제하기 전에 집계 버전과 재계산 가능 범위를 합의했는가?

인수 시 새 관리 화면은 선택일·설비를 유지하고, 단일일 API 한 번으로 요약하며, source 오류/부분 응답/유효한 0/단위 불명/늦은 수정/중복 이벤트를 테스트한다. 원본 수치와 JSON은 저장소 밖의 승인된 비공개 증거 위치에 보관한다. 이 문서는 설계·코드 검토이고 운영수집 설정·DB·MES 원장·권한을 변경하지 않았다.

## 이번에 적용한 보고 원장 화면 증분

`/production/stats`는 기존 단일일 API를 재사용한다. 상단을 계획 수량·저장 신고 수량·신고 행 수·최종 신고시각으로 구성하고, 잘못된 응답·조회 실패·캐시 갱신 실패에서는 숫자를 보류한다. `plan_row_count`와 `mes_report_count`로 자료 존재를 판정하므로 신고 행이 있는 0과 미관측을 구분한다. 양쪽 기록의 존재는 수량 일치가 아니며 가공은 품번으로 합산한 대표 설비 표시임을 명시했다. 업무일·표시시각을 Shanghai에 맞추고, 과거 날짜는 자동 반복 조회하지 않는다.

이는 기존 저장 원장의 조회 개선이다. `raw_payload` 단위/품질/취소·정정 검증, collector 실행 원장, 신규 MES API 수집은 아직 구현하지 않았다. 기존 `report_qty=0`에 파싱 실패가 섞였는지 프런트 응답만으로 판별할 수 없으므로 양품/입고/완료율 확정으로 승격하지 않는다. 원장 grain·업무일·숫자·중복·합계 검증과 실제 QueryObserver의 캐시 갱신 실패를 포함한 회귀 테스트를 추가했다. [화면](../../frontend/src/pages/production/Stats.tsx), [근거 모델](../../frontend/src/domains/production/mes-report-evidence.ts), [회귀](../../frontend/tests/mes-report-evidence.test.ts)
