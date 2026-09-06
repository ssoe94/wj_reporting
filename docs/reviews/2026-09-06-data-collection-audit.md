# 수집 데이터와 대시보드 지표 검토

검토일: 2026-09-06 · 기준 소스: `origin/main`의 `47dd7c8` · 범위: 데이터 계보, 지표 정의, 빈 화면의 구조적 원인, 추가 수집 우선순위.

이 문서는 소스코드와 저장소 문서를 검토한 개발 인계 자료다. 운영 DB, 자격증명, `.env`에 접근하지 않았고 배포 설정을 변경하지 않았다. 실제 행 수, 마지막 적재 시각, 입력률, 스케줄러 가동 여부를 확인하지 않았으므로 **모델·수집 코드가 있다는 사실을 실제 데이터가 충분하다는 뜻으로 해석하면 안 된다.** 아래의 빈 화면 원인은 재현 가능한 코드 경로 또는 확인할 가설이며, 운영 데이터의 결측 원인을 확정한 것은 아니다.

## 우선 결론

현재 가장 큰 기회는 새 차트를 늘리는 것보다 **MES 중심으로 발전한 수집 경로와 일보 중심으로 남은 분석 화면을 연결하고, 같은 지표를 같은 계산식으로 보여주는 것**이다.

1. `/analysis`의 사출 OEE·정지 분석은 수기 `InjectionReport`, 조립 분석은 `AssemblyReport`를 읽는다. 최신 생산 대시보드와 전광판의 MES·계획·수기 대사 경로와 다르다. 따라서 MES가 계속 수집돼도 분석 화면은 비거나 과거 기록만 표시할 수 있다.
2. analytics mart가 한 번 저장되면 원천 변경·경과 시간과 무관하게 계속 반환하고 `is_stale=False`로 표시한다. 이 API를 새 분석 화면에 연결하기 전에 신선도 검증이 필요하다.
3. 같은 저장소 안에서 OEE, 생산실적, 지연 판정의 정의가 충돌한다. 경영진용 화면에 그대로 합치면 빈 화면보다 더 큰 판단 오류가 발생할 수 있다.
4. 정지 원인 확인, 계획외 가동 분류, 가공 수기/MES 대사, 품질 검사수·불량수, 품목 표준CT·중량, 전력, 출고 목표·이행수량은 이미 코드 기반이 있다. 먼저 이들의 입력률·연결률·보존기간을 검증하고 재사용한다.
5. 신규 수집의 첫 순서는 수집 성공/실패 이력과 원천 커버리지, 실행 품목/금형의 시작·종료, 조치 담당·완료시각, 주문 납기와 실출하 이벤트 이력이다. 원가·생산성·정식 OEE는 이 기반 이후 단계로 둔다.

## 수집·저장·사용 계보

표의 주기는 코드에 선언된 주기이며 운영 실행의 증거가 아니다. 보존기간을 찾지 못한 항목은 영구 보존으로 단정하지 않았다.

| 데이터 / 분석 단위 | 수집·저장 경로와 코드상 주기 | 현재 사용 / 활용 범위 | 제한과 확인 항목 |
| --- | --- | --- | --- |
| 생산계획: 업무일×공정×설비×품번×LOT×순서 | `ProductionPlan`, 업로드·수정 시 저장. `ProductionPlanChangeLog`에 before/after와 사용자 기록 | 생산 대시보드, 현장 칸반, 전광판, AI·mart의 계획 기준 | 재업로드·순서변경 시 동일 실행과의 매칭 및 확정계획 버전 필요. 근거: `backend/production/models.py:7`, `:29`, `:39`, `:58` |
| 사출 MES: 설비×측정시각 | `InjectionMonitoringRecord`에 누적 capacity·오일온도·누적전력. Celery Beat 120초. 5/30/60분 rollup 생성. 상세 168시간 이후 시간당 마지막 원천행으로 압축 | MES 모니터링, 생산 추정, 설비 가동 추이, 전력, 전광판, AI | 실제 유효 capacity 커버리지·설비별 지연·리셋을 확인해야 함. rollup sample_count가 있어 커버리지 점검에 재사용 가능. 근거: `backend/injection/models.py:475`, `:497`; `backend/config/celery.py:22`; `backend/injection/mes_service.py:1022`, `:1147` |
| Mac 로컬 MES 로그: 시간슬롯×설비 | collector는 운영 API의 최근 180개 1분 슬롯을 조회해 SQLite upsert. launchd 템플릿 60초. 상세 60일 이후 시간 집계 | 로컬 장기 조사 후보 | 설치·가동·실제 보존량 미확인. 서버가 2분 수집이면 1분 조회만으로 실제 1분 관측을 보장하지 않음. 근거: `scripts/mes_collector/collect_mes_minute_logs.py:15`, `:24`, `:90`, `:149`; `scripts/mes_collector/com.wj.mes-collector.plist:15` |
| 가공/조립 MES 완료보고: source report detail ID | `ProductionMesReportRecord`에 report_time·business_date·equipment_key·part_no·report_qty·raw_payload upsert. 명령 기본 최초 24h, 이후 최근 5분 조회 | 가공/조립 실적, 수기 대사, 전광판, AI·mart | **최근 5분 조회 범위는 실행 주기가 아니다.** 중단/늦게 수정된 보고 복구를 위한 watermark·repair 필요. 실제 실행 스케줄 미확인. 근거: `backend/production/models.py:283`; `backend/production/management/commands/sync_mes_progress_reports.py:27`, `:39`, `:68`, `:94` |
| 현장 실행·보정·확인 | `ProductionExecution`: 실적·불량·정지·인원·CT·시간. `MachiningManualReport`: 양품·불량·대사상태·귀속업무일. `InjectionDowntimeConfirmation`: 정지사유·분·확인자. `InjectionActivityConfirmation`: 계획외 가동 분류 | 실행 콘솔, 현장 칸반, 가공 대사, 생산 화면 일부 | 모든 항목을 새로 수집할 필요 없음. 입력률과 실제 대시보드 연결부터 조사. 근거: `backend/production/models.py:111`, `:163`, `:233`, `:326` |
| 기존 생산일보: 날짜×작성기록 | `InjectionReport`, `AssemblyReport`, 수기·업로드 | `/analysis`의 OEE·정지·조립 분석, 기존 보고서 화면 | MES·신규 확인 테이블과 동일 원천이 아님. 일보 미작성/기간 차이만으로 분석 화면이 비어 보일 수 있음. 근거: `backend/injection/models.py:34`; `backend/assembly/models.py:5`; `frontend/src/pages/analysis/index.tsx:2` |
| 현재고·원료: 물류 식별키×창고×품질상태 | `StagingInventory`, `RawMaterialMESDataset`, `RawMaterialSyncState`. MES 전체 페이지 검증 후 트랜잭션으로 교체. 수동/일일 수집 경로 | 현재고·원료, 원료변동 분석 | 기존 데이터가 있을 때 빈 응답·페이지 불완전성을 검출하고 보존하는 방어가 이미 있음. 성공 수집시각과 원천 수정시각을 구분해야 함. 근거: `backend/inventory/models.py:71`, `:102`, `:165`; `backend/inventory/management/commands/fetch_inventory.py:69`, `:129`, `:148` |
| 일일 재고: 날짜×품번×창고×품질상태 | `DailyInventorySnapshot`; `create_daily_snapshot`는 현재 staging을 날짜로 저장한 후 10일 초과분 삭제. 별도 task는 30일 삭제 | 일일 재고, 일부 전광판 재고 | 10/30일 경로가 공존해 월간·분기 추세를 지속 보장하지 못함. 과거 날짜 실행이 당시 재고를 복구하지 않음. 근거: `backend/inventory/models.py:240`; `backend/inventory/management/commands/create_daily_snapshot.py:27`, `:56`, `:129`; `backend/inventory/tasks.py:98` |
| 완성품 입출고: 오전/오후 구간×품번×창고 | `FinishedGoodsTransactionSnapshot` + 집계행. Beat 08:00/20:00 Asia/Shanghai | 구간 입출고와 전광판 재고 흐름 | 순변동·집계는 개별 주문 납기 준수를 뜻하지 않음. 근거: `backend/inventory/models.py:301`, `:340`; `backend/config/celery.py:30` |
| 출고 주문 이행: MES 주문품목 라인 | `outbound_performance`는 plan/done amount·계획시각·주문 분류·창고·단위 검증, 5분 캐시. 상세 미달·미출고 품목 생성 | 전광판 출고 실적·우선 조치 품목 | 출고 데이터의 최초 도입보다 주문 변경 이력·실출하 이벤트·고객 약속납기 연결이 다음 단계. 캐시는 장기 시점 이력과 다름. 근거: `backend/inventory/services/outbound_performance.py:1059`, `:1211`, `:1392` |
| 품질: 보고/검사 기록 | `QualityReport`: 보고일·부문·품번·검사수·불량수·문자열 불량률·판정·현상·조치·이미지. Excel import 계보/검수 저장 | 품질 이력, 일일 주의품목, 현재 실행 추정품번에 대한 과거 유사이력 | 보고건수는 전수 검사수나 현재 불량률이 아님. 정상 검사 포함 여부, 분모, 품번/LOT/공정 연결, 중복 출판 여부를 확인. 근거: `backend/quality/models.py:7`, `:80`, `:187`; `backend/production/overview_board.py:788`, `:831` |
| 금형/품목 사양 | `MouldDataSnapshot`에 source_latest/refreshed/error. `PartSpec`에 유효일·표준CT·cavity·중량·수지 | 금형 관리/전광판; 사양은 원료·생산 기준 후보 | 품목CT·cavity 여러 저장소의 기준 통일 및 유효일 연결 필요. 근거: `backend/injection/models.py:136`, `:525`; `backend/production/models.py:80` |
| 분석 mart·예외 | 일/설비/파트 생산 mart + `FactExceptionEvent`; `refresh_analytics_marts --scope production`만 구현 | API `/api/analytics/production-progress/`; 저장 없으면 live 계산 fallback | frontend에서 이 API 호출을 찾지 못함. 정기 refresh 가동 여부 미확인. 재고·품질 mart는 설계문서의 후보이지 이 앱 모델로 구현된 상태는 아님. 근거: `backend/analytics/models.py:5`, `:54`, `:87`, `:118`; `backend/analytics/services.py:642`; `backend/analytics/management/commands/refresh_analytics_marts.py:16` |

## 확인된 위험과 수정 우선순위

아래 신뢰도는 코드 경로의 확인 수준이다. 실제 영향을 받은 운영 행 수·빈도·페이지 사용량은 확인하지 않았다.

### P0 — 분석 mart가 항상 최신으로 표시되는 경로

- 근거: `backend/analytics/services.py:599`는 저장된 일별 mart가 있으면 반환하고, `:620`에서 `is_stale=False`, `:642`에서 saved payload를 무조건 우선한다. 원천이 뒤에 바뀌거나 한 공정만 저장된 경우도 이 경로에서 최신성·완전성 확인이 없다. 라이브 계산 payload 역시 `:412`에서 고정 False다.
- 영향: MES/계획은 바뀌었는데 예전 생산량을 정상 최신 값으로 볼 수 있다. 심각도 높음, 정적 근거 신뢰도 높음.
- 최소 개선: 원천별 `source_event_latest_at`, `last_successful_ingestion_at`, `computed_at`, 공정 커버리지를 구분하고 유효기간/원천 버전을 비교. stale은 stale로 전달하고 원천 누락을 0으로 표시하지 않는다. 저장된 과거 업무일도 late correction 후 재계산 가능해야 한다.
- 검증: 저장 후 MES·계획·수기 대사 각각 변경, 공정 1개만 존재, 당일 stale, 과거 확정일, 미래일을 독립 fixture로 검증. 운영 접근 없이 단위 테스트 가능.

### P0 — 분석 화면이 수집 중인 MES와 연결되지 않음

- 근거: `frontend/src/pages/analysis/index.tsx:78`, `:88`, `:108` → OEE/정지/조립 컴포넌트. OEE는 `frontend/src/components/OEEDashboard.tsx:44` → `frontend/src/hooks/useReports.ts:83`의 `/injection/reports/`. 조립은 `frontend/src/components/AssemblyDashboard.tsx:130` → `frontend/src/hooks/useAssemblyReports.ts:48`의 `/assembly/reports/`.
- 영향: MES 수집이 정상이어도 legacy 일보를 쓰지 않으면 분석 화면은 비어 보인다. 이 원인이 실제 현장의 빈 화면에 해당하는지는 최신 날짜별 row count로 검증해야 한다. 구조적 연결 차이의 신뢰도 높음.
- 최소 개선: 새 분석 첫 화면은 검증한 canonical 생산 진행·예외·출고로 구성. 기존 일보 분석은 ‘일보 기반 과거 분석’으로 이동하고 원천·최종기록일·사용 가능한 날짜를 안내한다. 비어 있는 카드를 반복하지 말고 하나의 수집 상태 패널에서 이유와 입력/조회 동선을 제공한다.
- 추가 결함 후보: 조립 분석은 필터 없이 API의 한 페이지 `results`만 가져와 브라우저에서 기간을 집계한다(`AssemblyDashboard.tsx:130`, `:149`; `useAssemblyReports.ts:48`). 페이지네이션이 켜져 있고 행이 많은 경우 기간 합계가 일부 페이지에 제한될 수 있다. 서버의 기간 집계 API로 옮기고 실제 pagination 계약을 확인한다.

### P0 — OEE의 명칭·계산 근거 충돌

- 근거: `frontend/src/components/OEEDashboard.tsx:118`의 가용시간은 일마다 `17×24×60`분 고정. `:137` 성능은 `총수량/계획수량`. 최신 전광판은 `backend/production/overview_board.py:1942`에서 동일 설비/시간 단위의 검증된 Availability/Performance/Quality가 없으면 OEE를 계산하지 않도록 설계됐다(`:1997`).
- 영향: 누락 일보·비가동 예정 설비가 생산성 저하처럼 표시되거나 계획 변경이 OEE를 바꾼다. 전광판과 분석 페이지가 동일 명칭으로 서로 다른 의미를 전달한다. 심각도 높음, 신뢰도 높음.
- 최소 개선: 현재 legacy 계산은 근거가 명확한 ‘일보 기반 계획·가동 참고지표’로 이름을 바꾸거나 보조 화면으로 이동한다. 공식 OEE는 계획 가동시간, 실제 가동시간, 유효 표준CT, 총수량/양품의 동일 단위 연결과 데이터 커버리지 확보 이후에만 노출한다. 단순 최근 가동 설비 비율을 OEE로 사용하지 않는다.

### P1 — 구조화된 정지사유를 수집해도 기존 정지 차트는 채워지지 않음

- 근거: `frontend/src/components/DowntimeAnalysis.tsx:125`는 일보 `note`의 ‘분/min/分钟’ 정규식만 추출, `:148`에서 합산. 새 정지 확인은 `backend/production/models.py:163`에 event key, 시작/종료, 사유, 확정/기각, 확인자를 보존한다.
- 영향: 현장에 입력 부담을 늘려도 관리자가 보는 개선 효과가 없다. 자유문구 형식 차이·중복 정규식 매칭에 따라 원인 비중도 달라질 수 있다. 심각도 중간, 구조적 신뢰도 높음.
- 최소 개선: 확인된 정지 이벤트를 기준으로 원인별 정지분·미확인분·반복 설비를 분석한다. 자동 감지와 사람 확인을 구분하고 감지 건수와 실제 정지 손실을 혼합하지 않는다. 기존 note는 원천이 표시된 역사 참고자료로 둔다.

### P1 — 지연/데이터누락 예외가 실제 원인을 혼동

- 근거: `backend/analytics/services.py:305`는 사출 계획이 있고 actual=0이면 `missing_mes_data`를 생성한다. 정상 수집 중 정지한 설비도 같은 조건이다. `:322`는 가공 계획 미달이면 업무시간과 관계없이 지연으로 분류한다. 일별 가공 time_progress는 `:116`에서 None인 반면 최신 daily context는 `backend/production/ai_retrievers.py:613`에서 시간 진도를 제공한다.
- 영향: 오전 시작 직후 미완료 가공을 지연으로 부르고, 실제 설비정지와 수집장애가 같은 경고로 보일 수 있다. 반복적인 오탐은 실무 조치의 우선순위를 흐린다. 심각도 중간, 신뢰도 높음.
- 최소 개선: 관측 없음/관측 있으나 무생산/계획 시작 전/시간진도 미달을 분리한다. 공통 지연 임계값은 기존 계약의 ‘시간진도 대비 5%p 초과 부족’을 유지하되 계획 교대·계획 중단시간이 확보되면 실제 계획 가동시간 기준으로 고도화한다.
- 참고: 전광판 가공 source 상태 역시 계획이 있으면 `ok`이고 stale=False다(`backend/production/overview_board.py:2457`, `:2470`); 완료보고 간격과 수집 성공시각을 별도로 보아야 한다.

### P1 — 재고 이력이 장기 의사결정에 남지 않을 수 있음

- 근거: `backend/inventory/management/commands/create_daily_snapshot.py:129` 10일 삭제와 `backend/inventory/tasks.py:98` 30일 삭제 공존. 전자는 지정한 과거 날짜에도 당시 데이터가 아니라 현재 `StagingInventory`를 저장한다(`:56`).
- 영향: 재고 누적·장기체류·월말 증감·계절성 비교를 보장하기 어렵다. 과거 날짜를 넣어 재실행하는 작업을 ‘백필’로 부르면 잘못된 역사 수치가 생길 수 있다. 심각도 높음, 코드 경로 신뢰도 높음.
- 최소 개선: 운영 current 정리와 분석 일별 보존을 분리해 최소 13개월을 목표로 용량 검토. backfill은 당시 원천이 있는 날짜만 허용하고 `observed_at`과 `snapshot_date`를 보존한다. 과거 원천 부재 구간은 결측으로 남긴다. 보존/DB 변경은 별도 검토 작업이다.

### P1 — 누적 MES를 합산하는 legacy endpoint 잔존

- 근거: `backend/production/views.py:1218`–`:1223`은 누적 capacity를 sum, `:1227`은 가공 실적을 AssemblyReport로 읽는다. canonical은 reset-safe delta×cavity×계획순서와 MES+미대사 수기보정이다(`backend/production/ai_retrievers.py:74`, `:438`, `:553`).
- 영향: legacy `/production/dashboard/`를 재사용하면 canonical 실적과 불일치한다. 현재 helper는 `frontend/src/lib/api.ts:215`에 남지만 검색상 외부 호출부는 발견하지 못했다. **현재 활성 대시보드가 이 endpoint를 사용한다고 단정하지 않는다.**
- 최소 개선: endpoint 사용 여부를 확인한 뒤 canonical API 위임 또는 명시적 폐기. 신규 화면은 이 경로에 연결하지 않는다.

### P2 — 운영문서와 코드의 주기·보존 계약 불일치

- 근거: `docs/rebuild/mes-local-log-strategy.md:12`는 서버 1분/24시간 보존, 실제 저장소 `backend/config/celery.py:25`는 2분, `backend/injection/mes_service.py:1034`는 168시간. 설계문서의 inventory mart refresh(`docs/rebuild/20-analytics-storage-visualization-design.md:430`)는 현재 command scope에 없다(`backend/analytics/management/commands/refresh_analytics_marts.py:16`).
- 영향: 조사자가 잘못된 기대 행 수·신선도·백필 범위를 적용할 수 있다.
- 최소 개선: ‘구현됨/설정됨/실행확인됨/설계안’을 구분해 문서를 정리한다. 로컬 로그 문서의 frontend→Mac 직접 연결 제안은 최신 `AGENTS.md`의 운영 frontend 직접 연결 금지 원칙에 맞게 갱신한다.

## 권장 대시보드 정보 구성과 KPI 계약

경영진은 ‘오늘 목표에서 얼마나 벗어났고 어느 문제가 출하/품질에 영향을 주는가’를, 실무진은 ‘지금 어느 설비·품목에서 어떤 확인·조치를 해야 하는가’를 빠르게 확인해야 한다. 두 화면은 같은 지표 API와 업무일을 공유한다. 생산 업무일은 **Asia/Shanghai 08:00~익일 08:00**, 주간/야간 교대는 08~20/20~08이다(`backend/production/ai_metrics.py:16`, `:21`).

핵심 KPI는 처음에 세 묶음으로 한정한다. 신규 외부 벤치마크나 목표치는 제안하지 않았으며 아래 목표는 기존 계획/계약을 기준으로 한다.

| 주 지표 | 정의·분모·단위 | 의사결정 / 연결 드라이버 | 근거·주의점 |
| --- | --- | --- | --- |
| 생산 목표 진행과 부족수량 | 공정별 진행률=`동일 업무일 실적/계획×100`. 현시점 부족수량=`max(0,계획×시간진도−실적)` | 책임자: 생산관리, 매 교대·당일. 병목 설비/파트, 최근 60분 변화, 미확인 정지로 바로 이동 | 사출은 추정량, 가공은 MES+미대사 보정. 양품 확정량/납기준수율과 구분. 공정별 합계·가중 비율 사용, 설비 비율 단순 평균 금지. 현재 5%p 경고는 계약상 휴리스틱 |
| 출고계획 이행과 미출고 품목 | 기존 출고 라인별 이행수량/계획수량, 미달 잔량. 단위·주문종류·창고별 집계 | 책임자: 물류/영업운영, 5분 참고·교대 마감. 금일 미출고, 최대 미달 품목, 준비재고 연결 | 기존 `outbound_performance` 재사용. 고객 약속납기·실출하 타임스탬프 확보 전 OTIF로 부르지 않음. 다른 단위의 수량 합산 금지 |
| 조치 필요한 운영 예외 | 미해결 생산지연/계획외 가동/미확인정지/가공미대사/품질 주의항목을 근거·발생시각·담당·기한과 표시 | 책임자: 각 공정 반장/품질/자재, 당일. 오래된 미처리와 재발 사유 중심 | 현재 예외는 자동 탐지·상태 필드까지만 있음. 담당자·마감·조치 기록은 추가 필요. 소스 결측으로 예외가 사라지면 해결로 처리하지 않음 |

공통 가드레일은 ‘데이터 최신성·커버리지’와 ‘확정/추정·품질 분모의 신뢰도’다. 품질 총불량률, OEE, 인시생산성, 에너지/양품단위는 분모 연결 검증 전 경영진 주 KPI에 넣지 않는다.

추천 첫 화면:

- 공통 상단: 선택 업무일·교대·기준시각, 원천별 정상/지연/미수집, 추정/확정 표시.
- 경영진: 위 세 KPI → 전일 동일시각/최근 비교 가능한 업무일 추이 → 부족수량이 큰 설비·출고품목 → 담당자별 주요 미해결 조치. 데이터 비교구간이 없으면 비교 카드를 숨기고 보존/수집 현황을 안내한다.
- 실무진: 내 공정/설비의 지금 할 일 → 정지 사유 확인·계획외 가동 분류·수기/MES 대사 → 현재 실행품목의 과거 품질 주의와 실제 검사 입력 → 조치 완료.
- 원료·재고·금형·일보의 상세 페이지는 원천 확인/운영 작업용 drilldown으로 유지한다. 전광판은 요약 전달 역할로 두고 편집/조치 기능은 기존 권한 있는 화면으로 연결한다.

## 추가 수집과 기존 데이터 연결 우선순위

기간은 작업 순서를 위한 제안이며 확정 일정·비용 견적이 아니다. 실제 입력률과 수집 부담을 확인한 뒤 범위를 나눈다.

| 순서 | 필요한 데이터 / 최소 필드 | 이미 있는 것 / 추가할 것 | 담당 제안·주기 | 얻게 되는 피드백 / 완료 조건 |
| --- | --- | --- | --- | --- |
| P0, 첫 단계 | 수집 실행 이력: source, batch_id, 시작/종료, 성공/실패, 요청범위, 원천최신시각, 수집행수, 거절수, watermark, 오류코드 | `RawMaterialSyncState`, quality import batch, source metadata를 재사용. 공통 append-only 실행 이력과 소스별 기대관측 수 추가 | 개발/데이터 운영; 매 수집 실행 | 무생산과 수집장애 구분. 실패 후 이전 정상값 보존, 사용자에게 ‘마지막 성공/지연 이유’ 표시. 재실행·빈 응답·부분 실패 fixture 통과 |
| P0/P1 | 지표 키·상태: business_date, process, equipment_key, part_no, lot, source_type, as_of, confirmed/estimated, cavity_source, 적용 사양버전 | ProductionPlan·Cavity·PartSpec의 기존 필드 연결. 실적 source와 미등록 cavity(default 1)를 명시 | 생산기술/생산관리; 변경 시 | 추정생산과 양품확정 구분. 계획/실적 매칭률 및 default cavity 영향수량 확인 |
| P1 | 실제 실행품목·금형·교체 이벤트: 설비, 품번/LOT, 금형, start/end, 시험shot/양산, 확인자 | 기존 실행시간·계획외 가동/정지 확인을 통합 사용하고 부족한 안정적 실행 ID·금형 연결 추가 | 현장 반장/생산기술; 교체·생산전환 시 | 계획순서만으로 추정하던 품번 배분 검증. 전력·품질·재료를 실제 실행 단위로 연결 |
| P1 | 정지/문제 조치: event_id, reason_code, 원인확정, 담당, 기한, 시작/해결/재개시각, 조치, 재발 연결 | 구조화 정지 확인 재사용. `FactExceptionEvent`에는 담당·기한·조치 이력이 없으므로 추가 필요 | 각 공정 담당; 감지 후 확인/완료 시 | 반복 정지 손실 Pareto와 미해결 체류시간, 실제 개선효과. 자동 감지→확인→완료의 상태 전이가 감사 가능 |
| P1 | 출하 약속과 사건 이력: order_line_id, 고객 약속일시, 원계획/변경계획, 변경이유, 실제 출하일시, 출하수량/단위, 취소/분할/반품 | 기존 출고 plan/done·분류·상세 미달 활용. 원천에 있는 필드 존재 확인 후 누적 이력 저장·고객 약속과 연결 | 물류/영업운영; 변경/출하시, 일일 대사 | 금일 이행량에서 납기준수·부족재고·지연원인까지 확장. 약속 기준 버전과 부분 출하 정의 합의 후 OTD/OTIF 계산 |
| P1/P2 | 검사 분모·양품·폐기/재작업: inspection_event_id, 검사일시/설비/공정/품번/LOT, 검사유형(표본/전수), 검사수, 결함품수, 결함건수, good/rework/scrap, disposition | 기존 QualityReport·수기불량·일보 필드 재사용. 양품/검사분모/결함품vs결함건 정의와 실행 연결 강화 | 품질/현장; 검사·판정 시 | 검사범위가 확인된 불량률·재작업률, 품번별 재발. 정상 검사도 포함 여부 확인, 분모 없는 비율은 null |
| P2 | 계획 가동시간·표준CT·작업인시: 교대 캘린더, 설비별 planned_run_minutes, 확정가동분, effective ideal_CT, 실제 투입 인원×분 | `PartSpec`, `ProductionExecution`, `AssemblyReport` 재사용. 다품번 CT/교대 휴무·인시 누락 연결 추가 | 생산관리/생산기술; 교대·사양변경 시 | 같은 조건의 생산성/OEE. 결측 인원을 기본 1명으로 확정 취급하지 않음. 품번별 표준공수 가중으로 비교 |
| P2 | 재고 history와 수요: 일별 가용/보류량, LOT 입고일, 유효기한, 확정수요, 재료 BOM·소요량, 예정입고 | 현재고·원료변동·완성품 입출고·PartSpec 중량 재사용. 13개월 일별 이력, 주문/생산계획 수요·입고예정 연결 | 자재/구매; 일일 마감·변경 시 | 부족 예상시점, 장기체류, 준비 가능한 출고. 품번·단위·품질상태별 계산. 근거 없는 평균수요로 재고일수 단정 금지 |
| P3 | 손실 금액: 품번/재료 단가와 유효일, 에너지 요율/시간대, 재작업 인시, 폐기량, 환율/통화, 비용 귀속 | 누적전력·중량·생산량을 출발점으로 단가원장 연결 | 재무/원가/생산기술; 월마감·변경 시 | 불량·정지·에너지의 금액 우선순위. 현재는 실수량 손실 우선, 수집 검증 전 절감액/영업이익 효과를 계산하지 않음 |

## Mac Studio에서 이어서 확인할 최소 데이터 프로파일

현재 접근하지 않은 운영 데이터는 기존 승인된 운영 점검 채널에서 **집계값만** 확인한다. 이는 운영 접근을 실행했다는 뜻이 아니다.

1. 최근 30 업무일, 가능하면 90일의 소스별 날짜×공정 row count, 최초/최종 업무일, 최신 원천시각, 마지막 성공 적재시각.
2. 사출 설비별 capacity 유효 샘플/기대 샘플, 연속 누락시간, 카운터 리셋, 전력 동시관측 커버리지. 설정 주기를 기준으로 기대값 계산.
3. 계획×실적 품번·설비 매칭률, plan-only/MES-only, default cavity 건수/계획수량 비중, 실행/품번 확정률.
4. 가공 MES 수량, 미대사 수기잔량, 대사완료량을 각각 집계. 최근 5분 조회 사이 중단·지연 보고가 빠졌는지 확인.
5. `InjectionReport`, `AssemblyReport`, `ProductionExecution`, 정지확인, 품질보고의 일별 입력률. 기존 `/analysis` 원천만 비었는지 확인.
6. 품질 검사수/불량수 채움률, 검사수 0·분모 초과, 중복 import, 품번 연결률. 보고 건수와 결함품/검사수는 별개로 프로파일.
7. 재고 실제 보존일수·날짜 공백·중복 grain, 소스 단위혼합, 스냅샷 생성시각/원천시각 차이. 10일 정리 경로의 최근 실행 여부 확인.
8. analytics mart의 원천시각·생성시각·두 공정 존재 여부·현재 소스와 수량 대사. 아직 저장하지 않거나 API를 쓰지 않는다면 이를 그대로 기록.
9. 기능 사용률은 별도: 페이지 조회/실제 작업 이벤트가 수집되는지 먼저 확인. 0개 데이터/메뉴 존재만으로 ‘사용하지 않는 페이지’를 확정하지 않는다. 필요하면 개인정보 없는 page_key·역할군·작업유형·성공여부·시간부터 수집한다.

프로파일을 받으면 숫자로 채울 항목: 영향 날짜, 영향 설비/품번 수, 전체 대비 비중, last-good 시각, 경영진 지표 영향, 담당자, 수정 완료 기준. 이 값들은 현재 문서에 임의로 채우지 않았다.

## 인계와 검증

- 변경 파일: 이 문서만. 앱 코드·마이그레이션·설정 변경 없음.
- 실행: `git status --short`, `rg --files`, `rg -n`, `nl -ba`/`sed`로 모델·수집기·API·컴포넌트·문서 정적 검토. 관리명령/수집기 실행, 운영 API/DB 조회, 자격증명 접근 없음.
- 적용 워크플로: Data Analytics `analyze-data-quality`, `design-kpis`. 산출물은 지정된 저장소 검토 문서이며 실데이터 기반 통계 보고서를 가장하지 않는다.
- 완료: 코드 기준 계보, 지표 충돌, 빈 화면 원인 후보, KPI 계약, 우선 수집계획, 후속 프로파일 요구사항.
- 남은 위험: 배포 버전 확인 결과는 별도 인계 문서에 기록했다. 수집기 가동, 원천 데이터 밀도, 실제 페이지 이용률, 조직별 책임/입력 부담은 코드 검토만으로 확인할 수 없다.
- 추천 다음 작업: **신선도 계약과 지연/누락 분류를 먼저 검증하는 작은 backend 작업 → canonical MES 기반 분석 첫 화면 → 기존 정지/대사/출고를 조치 동선에 연결 → 보존·품질분모·납기 이력 확장** 순서. 배포나 데이터 변경은 별도 개발 검토를 거친다.
