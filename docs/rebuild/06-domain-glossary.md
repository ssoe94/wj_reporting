# 도메인 용어집

## 1. 목적

이 문서는 현재 `wj_reporting` 코드 전반에서 반복적으로 등장하는 핵심 용어를 정리한다.

목표는 아래 세 가지다.

1. 같은 개념을 다른 이름으로 부르는 문제를 줄인다.
2. 프런트, 백엔드, DB, AI 서비스가 같은 뜻으로 용어를 쓰게 한다.
3. 재구축 시 공통 마스터와 API 계약의 기준점을 만든다.

## 2. 가장 먼저 고정해야 하는 용어

현재 코드 기준으로 특히 혼동 가능성이 높은 용어는 아래다.

- `part_no`
- `model`
- `model_code`
- `model_name`
- `material_code`
- `material_name`
- `specification`
- `machine_no`
- `machine_name`
- `line_no`
- `plan_date`
- `report_dt`
- `snapshot_date`
- `business_date`
- `plan_type`
- `section`

## 3. 용어 정의

## 3.1 품목/모델 계열

| 용어 | 현재 쓰이는 위치 | 현재 의미 | 권장 정의 | 비고 |
| --- | --- | --- | --- | --- |
| `part_no` | 사출, 가공, 품질, 생산계획, 통합품목 | 부품/품목 식별자 | 시스템 전반의 기본 품목 키 후보 | 가장 중요한 공통 키 |
| `fg_part_no` | Product | 완제품 part no | 제품-완제품 매핑용 키 | product mapping 전용 |
| `wip_part_no` | Product | 반제품 part no | 제품-반제품 매핑용 키 | product mapping 전용 |
| `model` | InjectionReport, AssemblyReport, QualityReport 일부 | 현장/보고서에서 쓰는 모델명 | 사용자 입력/표시용 모델명 | 정규 기준 필드는 아님 |
| `model_code` | PartSpec, UnifiedPartSpec, CycleTimeSetup 일부 | 기준 모델 코드 | 공통 모델 기준값 | 품목 마스터에서 우선 사용 권장 |
| `model_name` | ProductionPlan, ProductionExecution, MES 통계 | 생산계획/실적에서 쓰는 모델명 | 생산 도메인 표시용 모델명 | `model_code`와 관계 정의 필요 |
| `material_code` | 재고, 완성품 입출고 | MES/재고 계열 품목 코드 | 재고 시스템 기준 품목 코드 | `part_no`와 동일한지 정의 필요 |
| `material_name` | 재고, 완성품 입출고 | 재고 시스템 품목명 | 재고 시스템 표시명 | 모델명과 혼동 주의 |
| `specification` | 재고, 완성품 입출고 | 규격/사양 문자열 | 재고 표시용 규격 | 품목 기본키로 쓰지 않음 |
| `description` | PartSpec, UnifiedPartSpec, EcoPartSpec | 설명 텍스트 | 품목 설명 | 화면 표시용 보조 필드 |

### 권장 기준

- 공통 식별 키 1순위는 `part_no`로 검토
- 재고 연동에서 `material_code`가 `part_no`와 1:1인지 먼저 검증
- `model_code`는 기준 모델 코드
- `model`/`model_name`/`material_name`은 표시/입력용 문자열로 구분

## 3.2 설비/라인 계열

| 용어 | 현재 쓰이는 위치 | 현재 의미 | 권장 정의 | 비고 |
| --- | --- | --- | --- | --- |
| `machine_no` | InjectionReport | 사출기 번호 | 사출 설비의 숫자 식별자 | 사출 전용 |
| `machine_name` | ProductionPlan, ProductionExecution, MES, 모니터링 | 설비명/설비 라벨 | 생산 설비의 표시명 | 예: `3호기`, MES 설비명 |
| `line_no` | AssemblyReport | 가공 라인 번호 | 가공/조립 라인 식별자 | 가공 전용 |
| `equipment_key` | MES 실적, 생산 통계 | 정렬/집계용 설비 키 | 설비 정규화 키 | API 내부 계산용 |

### 권장 기준

- 사출은 `machine_no`와 `machine_name`을 같이 유지 가능
- 가공은 `line_no`를 우선 기준으로 사용
- 장기적으로는 `equipment` 공통 마스터를 두고 `equipment_type = injection | machining` 식으로 확장 가능

## 3.3 날짜/시간 계열

| 용어 | 현재 쓰이는 위치 | 현재 의미 | 권장 정의 | 비고 |
| --- | --- | --- | --- | --- |
| `date` | InjectionReport, AssemblyReport | 현장 보고 기준 날짜 | 업무상 보고 날짜 | 시간 없는 생산/보고 날짜 |
| `report_dt` | QualityReport | 품질 보고 일시 | 품질 이벤트 발생/기록 일시 | datetime |
| `plan_date` | ProductionPlan, ProductionExecution | 생산 계획 기준일 | 생산 계획이 속한 날짜 | 생산 도메인 기준 날짜 |
| `snapshot_date` | DailyInventorySnapshot | 스냅샷 기준 날짜 | 특정 시점 기준 재고 날짜 | 재고 스냅샷 날짜 |
| `business_date` | MES 실적 | 교대/업무 규칙 반영 날짜 | 업무일 계산용 날짜 | 자정 기준이 아닐 수 있음 |
| `created_at` | 공통 | 생성 시각 | 시스템 생성 시각 | UTC 저장 권장 |
| `updated_at` | 공통 | 수정 시각 | 시스템 수정 시각 | UTC 저장 권장 |
| `start_datetime` | 사출/생산실행 | 작업 시작 시각 | 실제 작업 시작 시각 | datetime |
| `end_datetime` | 사출/생산실행 | 작업 종료 시각 | 실제 작업 종료 시각 | datetime |
| `report_time` | MES 실적 | MES 보고 시각 | 실적 원천 시각 | datetime |
| `scheduled_at` | 재고 스냅샷 | 집계 기준 시각 | 스냅샷 생성 기준 시각 | datetime |

### 권장 기준

- `date`, `plan_date`, `snapshot_date`, `business_date`는 절대 같은 필드처럼 취급하지 않는다.
- DB 저장은 UTC
- 화면 표시는 사업장 기준 시간대
- `business_date`는 교대 기준 규칙을 명시적으로 정의

## 3.4 생산/계획 계열

| 용어 | 현재 쓰이는 위치 | 현재 의미 | 권장 정의 | 비고 |
| --- | --- | --- | --- | --- |
| `plan_type` | ProductionPlan, ProductionExecution, MES 통계 | `injection` 또는 `machining` | 생산 흐름 구분값 | enum 고정 필요 |
| `planned_quantity` | ProductionPlan | 계획 수량 | 계획 기준 수량 | production 표준명 |
| `plan_qty` | InjectionReport, AssemblyReport | 계획 수량 | 현장 보고용 계획 수량 | production 쪽과 이름 통일 검토 |
| `actual_qty` | 다수 도메인 | 실제 수량 | 실제 생산/실적 수량 | 공통 사용 가능 |
| `defect_qty` | ProductionExecution 등 | 불량 수량 | 생산 실행 기준 불량 수량 | quality와 구분 필요 |
| `reported_defect` | InjectionReport | 보고된 불량 수 | 현장 기입 불량 | actual defect와 구분 |
| `actual_defect` | InjectionReport | 실제 불량 수 | 실집계 불량 | 현장 보고 불량과 구분 |
| `lot_no` | ProductionPlan, ProductionExecution | lot 식별자 | 생산 lot 기준 키 | 문자열 형식 표준 필요 |
| `sequence` | ProductionPlan, ProductionExecution | 업로드 순서 | 설비 내 작업 순서 | 정렬용 |

### 권장 기준

- production 도메인 표준명은 `planned_quantity`, `actual_qty`, `defect_qty`
- 현장 보고 테이블의 `plan_qty`는 호환 필드로 두되, API 계층에서 매핑 규칙을 문서화

## 3.5 품질 계열

| 용어 | 현재 쓰이는 위치 | 현재 의미 | 권장 정의 | 비고 |
| --- | --- | --- | --- | --- |
| `section` | InjectionReport, QualityReport | 구분/공정/부문 | 도메인별 enum 필드 | 같은 이름이지만 의미가 다름 |
| `judgement` | QualityReport | 판정 결과 | 품질 판정 enum | `OK/NG` 등 표준화 필요 |
| `phenomenon` | QualityReport | 불량 현상 | 품질 이슈 설명 | 텍스트 |
| `disposition` | QualityReport | 처리 방식 | 조치 방향 | 텍스트 |
| `action_result` | QualityReport | 처리 결과 | 후속 처리 결과 | 텍스트 |
| `supplier` | Quality 도메인 | IQC 공급자 | 품질 공급처 기준 마스터 | 품질 전용 master |

### `section` 주의

`section`은 현재 도메인마다 뜻이 다르다.

- 사출: `C/A`, `B/C`, `COVER`
- 품질: `LQC_INJ`, `LQC_ASM`, `IQC`, `OQC`, `CS`

따라서 재구축에서는 아래 중 하나가 필요하다.

1. 도메인별로 `section` 유지하되 문서에서 명확히 분리
2. 더 명확한 필드명으로 변경

## 3.6 재고 계열

| 용어 | 현재 쓰이는 위치 | 현재 의미 | 권장 정의 | 비고 |
| --- | --- | --- | --- | --- |
| `warehouse_code` | 재고/입출고 | 창고 코드 | 창고 식별 키 | master 후보 |
| `warehouse_name` | 재고/입출고 | 창고명 | 표시용 창고명 | code 우선 사용 |
| `location_name` | 재고 | 위치명 | 창고 내 위치 | 보조 필드 |
| `qc_status` | 재고 | 품질 상태 | 재고 품질 구분값 | enum 정리 필요 |
| `cart_count` | 일일 보고 | 대차 수 | 집계 지표 | snapshot 전용 지표 |
| `cart_details` | 일일 보고 | 대차 상세 목록 | 스냅샷 상세 JSON | 구조 문서화 필요 |

## 3.7 권한 계열

| 용어 | 현재 쓰이는 위치 | 현재 의미 | 권장 정의 | 비고 |
| --- | --- | --- | --- | --- |
| `is_staff` | Django User | 전체 운영 관리자 성격 | 시스템 관리자 상위 권한 | Django 기본 |
| `is_admin` | UserProfile | 관리자 메뉴 접근 | 앱 수준 관리자 capability | `is_staff`와 구분 |
| `can_view_*` | UserProfile | 모듈 조회 권한 | 모듈 read capability | capability map으로 이행 권장 |
| `can_edit_*` | UserProfile | 모듈 편집 권한 | 모듈 write capability | capability map으로 이행 권장 |
| `field terminal user` | 프런트 로직 | 현장 단말 전용 사용자 | kiosk/현장 사용 역할 | 별도 role 권장 |

## 4. 권장 canonical vocabulary

재구축 문서와 신규 API에서는 아래 용어를 우선 사용한다.

| 주제 | 권장 기준 용어 |
| --- | --- |
| 공통 품목 키 | `part_no` |
| 공통 모델 기준 | `model_code` |
| 재고 품목 키 | `material_code` |
| 사출 설비 번호 | `machine_no` |
| 설비 표시명 | `machine_name` |
| 가공 라인 식별 | `line_no` |
| 생산 계획 날짜 | `plan_date` |
| 품질 보고 일시 | `report_dt` |
| 재고 스냅샷 날짜 | `snapshot_date` |
| 업무일 계산 날짜 | `business_date` |
| 생산 흐름 구분 | `plan_type` |

## 5. 재구축 시 rename 또는 alias 후보

| 현재 용어 | 문제 | 권장 방향 |
| --- | --- | --- |
| `model` | 의미가 넓고 도메인마다 다름 | 표시용 문자열로만 제한 |
| `model_name` | `model_code`와 혼동 | 생산 표시용으로 문서화 |
| `section` | 도메인마다 의미 다름 | 도메인별 enum 문서화 또는 rename 검토 |
| `plan_qty` | `planned_quantity`와 이중 구조 | API 계층에서 매핑 규칙 명시 |
| `actual_defect` / `reported_defect` | 현장/집계 의미 차이 | 보고 불량 vs 실제 불량 정의 고정 |

## 6. AI 연동을 위해 특히 중요한 용어

AI 기능을 붙일 때 아래 용어는 절대 모호하면 안 된다.

- `part_no`
- `material_code`
- `model_code`
- `business_date`
- `plan_date`
- `snapshot_date`
- `section`
- `plan_type`

이 항목들이 흔들리면 요약, 비교, 검색, RAG 근거 연결이 모두 불안정해진다.

## 7. 다음 작업 추천

이 문서 다음으로 가장 유용한 작업은 아래다.

1. `screen-to-api-map.md`
2. `permissions-matrix.md`
3. `data-lineage-map.md`
