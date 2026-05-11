# 데이터 계보 맵

## 1. 목적

이 문서는 현재 시스템에서 데이터가 어디서 생성되고, 어떤 가공을 거쳐, 어떤 화면/API에서 소비되는지 정리한다.

이 문서의 목표는 아래와 같다.

1. 도메인별 원천 데이터와 파생 데이터를 구분한다.
2. DB 정리와 AI 연동 시 무엇을 기준 데이터로 삼아야 하는지 정한다.
3. 배치/동기화/스냅샷 흐름을 한눈에 본다.

기준 파일:

- [backend/inventory/mes.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/inventory/mes.py:1)
- [backend/production/management/commands/sync_mes_progress_reports.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/production/management/commands/sync_mes_progress_reports.py:1)
- [backend/inventory/tasks.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/inventory/tasks.py:1)
- [backend/production/models.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/production/models.py:1)
- [backend/inventory/models.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/inventory/models.py:1)

## 2. 큰 흐름

현재 시스템의 데이터 흐름은 크게 4종으로 나눌 수 있다.

1. 사용자 직접 입력 데이터
2. 외부 시스템(MES) 동기화 데이터
3. 스냅샷/집계 파생 데이터
4. 화면/AI 소비용 조회 데이터

## 3. 도메인별 데이터 계보

## 3.1 사출 데이터

### 원천

- 사용자가 직접 입력한 사출 보고서
- MES 기반 모니터링 데이터

### 주요 테이블

- `InjectionReport`
- `CycleTimeSetup`
- `CycleTimeTestRecord`
- `InjectionMonitoringRecord`
- `PartSpec`
- `Product`

### 생성 흐름

1. 사용자가 사출 보고 입력
2. 보고 데이터가 `InjectionReport` 저장
3. 모니터링 데이터는 MES 연동 또는 갱신 작업으로 `InjectionMonitoringRecord` 적재
4. 셋업/사이클타임 데이터는 `CycleTimeSetup`, `CycleTimeTestRecord`로 저장

### 소비처

- `/injection`
- `/injection/dashboard`
- `/injection/setup`
- `/injection/monitoring`
- `/analysis`

### 재구축 시 기준 데이터

- 원장성 입력 데이터: `InjectionReport`
- 기준 마스터 데이터: `PartSpec`, `Product`
- 운영 모니터링 데이터: `InjectionMonitoringRecord`

## 3.2 가공/조립 데이터

### 원천

- 사용자가 직접 입력한 가공 보고서

### 주요 테이블

- `AssemblyReport`
- `DefectHistory`

### 생성 흐름

1. 사용자가 가공 실적 입력
2. 데이터가 `AssemblyReport` 저장
3. 불량 유형 사용 이력은 action API를 통해 `DefectHistory` 축적

### 소비처

- `/assembly`
- `/assembly/dashboard`
- `/analysis`

### 재구축 시 기준 데이터

- 원장성 입력 데이터: `AssemblyReport`
- 보조 추천 데이터: `DefectHistory`

## 3.3 품질 데이터

### 원천

- 사용자가 직접 입력한 품질 보고서
- 품질 이미지 업로드는 Cloudinary 외부 저장

### 주요 테이블

- `QualityReport`
- `Supplier`

### 생성 흐름

1. 사용자가 품질 보고 입력
2. 이미지가 Cloudinary로 업로드
3. 이미지 URL과 보고 본문이 `QualityReport` 저장
4. 공급자 마스터는 `Supplier` 저장/관리

### 소비처

- `/quality`
- `/quality/daily-attention`
- 향후 AI 품질 요약

### 재구축 시 기준 데이터

- 원장성 입력 데이터: `QualityReport`
- 기준 마스터: `Supplier`
- 외부 미디어 저장소: Cloudinary

## 3.4 생산 계획/실행 데이터

### 원천

- 업로드된 생산 계획 파일
- 사용자가 콘솔에서 입력한 실행 실적
- MES 진행 실적 데이터

### 주요 테이블

- `ProductionPlan`
- `ProductionExecution`
- `ProductionPartCavity`
- `ProductionPlanPart`
- `ProductionMesReportRecord`

### 생성 흐름

#### 계획

1. 파일 업로드
2. 파싱/정규화
3. `ProductionPlan` 저장
4. 파트-모델 매핑 보조 데이터 `ProductionPlanPart` 갱신

#### 실행

1. 콘솔/화면에서 실적 입력
2. `ProductionExecution` 저장 또는 upsert

#### MES 진행 실적

1. `sync_mes_progress_reports` 명령 실행
2. MES API 호출
3. 정규화
4. `ProductionMesReportRecord` 저장

### 소비처

- `/production`
- `/production/plan`
- `/production/stats`
- `/quality/daily-attention`
- 향후 AI 생산 요약

### 재구축 시 기준 데이터

- 계획 원장: `ProductionPlan`
- 실행 원장: `ProductionExecution`
- 외부 실적 원장: `ProductionMesReportRecord`
- 보조 파트/캐비티 기준: `ProductionPlanPart`, `ProductionPartCavity`

## 3.5 재고 데이터

### 원천

- MES 재고 API

### 주요 테이블

- `StagingInventory`
- `FactInventory`
- `DailyInventorySnapshot`
- `DailyReportSummary`
- `FinishedGoodsTransactionSnapshot`
- `FinishedGoodsTransaction`

### 생성 흐름

#### 실시간/근실시간 재고

1. `fetch_inventory` 명령 또는 `/inventory/refresh/`
2. MES 재고 API 호출
3. `StagingInventory` 적재
4. 일부 구조는 `FactInventory` 또는 조회용 결과로 사용

#### 일일 스냅샷

1. Celery 또는 cron으로 재고 갱신
2. `create_daily_snapshot`
3. `DailyInventorySnapshot` 생성
4. 요약 생성
5. `DailyReportSummary` 생성/갱신

#### 완성품 입출고 스냅샷

1. 완성품 입출고 캡처 태스크 실행
2. MES 변화 로그 기반 집계
3. `FinishedGoodsTransactionSnapshot` 생성
4. 하위 `FinishedGoodsTransaction` 행 생성

### 소비처

- `/sales/inventory`
- `/sales/inventory-status`
- `/sales/daily-report`
- 완성품 입출고 관련 화면
- 향후 AI 재고 변화 요약

### 재구축 시 기준 데이터

- 외부 원천 staging: `StagingInventory`
- 운영 스냅샷 기준: `DailyInventorySnapshot`
- 요약 기준: `DailyReportSummary`
- 입출고 스냅샷 기준: `FinishedGoodsTransactionSnapshot`

## 3.6 공통 품목 마스터 데이터

### 주요 테이블

- `PartSpec`
- `EcoPartSpec`
- `UnifiedPartSpec`
- `Product`

### 현재 상태

품목 기준이 도메인별로 나뉘어 있다.

- 사출 기준: `PartSpec`
- ECO 기준: `EcoPartSpec`
- 재고/통합 기준: `UnifiedPartSpec`
- 제품-완성품/반제품 매핑: `Product`

### 재구축 방향

장기적으로는 아래 방향이 유력하다.

- 공통 마스터 중심: `UnifiedPartSpec`
- 도메인 특화 정보는 확장 필드 또는 도메인별 보조 구조로 유지

## 4. 계보 레벨별 분류

## 4.1 Source of Truth 후보

| 도메인 | 기준 원장 |
| --- | --- |
| 사출 입력 | `InjectionReport` |
| 가공 입력 | `AssemblyReport` |
| 품질 입력 | `QualityReport` |
| 생산 계획 | `ProductionPlan` |
| 생산 실행 | `ProductionExecution` |
| MES 생산 실적 | `ProductionMesReportRecord` |
| 일일 재고 스냅샷 | `DailyInventorySnapshot` |
| 완성품 입출고 스냅샷 | `FinishedGoodsTransactionSnapshot` |

## 4.2 Derived Data

| 파생 데이터 | 원천 |
| --- | --- |
| 생산 대시보드 | `ProductionPlan`, `ProductionExecution`, `ProductionMesReportRecord` |
| 사출 OEE/분석 | `InjectionReport`, `InjectionMonitoringRecord` |
| 품질 daily attention | `ProductionPlan`, `QualityReport` |
| 재고 일일 요약 | `DailyInventorySnapshot` |
| 완성품 입출고 요약 | `FinishedGoodsTransactionSnapshot`, `FinishedGoodsTransaction` |
| defect history | `AssemblyReport` 사용자 입력 패턴 |

## 4.3 External Dependency

| 외부 시스템 | 사용 영역 | 저장 방식 |
| --- | --- | --- |
| MES inventory API | 재고 | staging/snapshot |
| MES progress report API | 생산 실적 | normalized DB record |
| MES monitoring/resource API | 사출 모니터링 | monitoring record |
| Cloudinary | 품질 이미지 | URL 저장 |

## 5. AI 연동 관점의 계보

AI 서비스는 쓰기 권한 없이 아래 계층만 읽는 것이 좋다.

### 우선 읽을 데이터

- `ProductionPlan`
- `ProductionExecution`
- `ProductionMesReportRecord`
- `QualityReport`
- `DailyInventorySnapshot`
- `DailyReportSummary`
- `UnifiedPartSpec`

### 가능하면 직접 읽지 말고 계약 API로 감쌀 데이터

- `StagingInventory`
- `InjectionMonitoringRecord`
- debug/temporary status 데이터
- 배경 작업 상태 캐시

### AI용 읽기 모델 예시

- `production_daily_summary_view`
- `quality_issue_context_view`
- `inventory_snapshot_summary_view`
- `part_master_view`

즉 AI는 원장 테이블 전체를 바로 읽기보다, 읽기 전용 context API나 뷰를 통해 접근하는 것이 좋다.

## 6. 현재 구조에서 주의할 점

### 6.1 staging과 snapshot을 혼동하면 안 됨

- `StagingInventory`는 원천 수집 상태에 가깝다.
- `DailyInventorySnapshot`은 업무 기준으로 고정된 결과다.

AI 요약이나 경영 보고는 주로 snapshot 기준이 더 적합하다.

### 6.2 계획, 실행, MES 실적은 서로 다름

- 계획: `ProductionPlan`
- 현장 입력 실행: `ProductionExecution`
- 외부 실적: `ProductionMesReportRecord`

이 셋을 합치되, 절대 같은 데이터처럼 다루면 안 된다.

### 6.3 품목 기준 통일 전까지 join 규칙을 문서화해야 함

현재는 `part_no`, `material_code`, `model_code`, `model_name`이 교차 사용된다.
재구축 전까지는 어떤 화면/집계에서 무엇으로 join하는지 명시해야 한다.

## 7. 권장 차기 산출물

이 문서 다음으로 가장 유용한 작업은 아래다.

1. `join-rules.md`
2. `source-of-truth-matrix.md`
3. `ai-read-models.md`
