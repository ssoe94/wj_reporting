# 화면-API 매핑

## 1. 목적

이 문서는 현재 프런트 화면이 어떤 API를 호출하는지 정리한다.

이 문서의 목표는 아래와 같다.

1. 화면별 API 의존성을 한눈에 본다.
2. 재구축 시 먼저 정리해야 할 API를 찾는다.
3. 현재 프런트 코드와 백엔드 엔드포인트의 불일치 지점을 표시한다.

## 2. 상태 표기

이 문서에서는 각 API 연결을 아래 상태로 표시한다.

- `confirmed`
  - 현재 프런트 호출과 백엔드 엔드포인트가 대체로 맞는다.
- `legacy`
  - 현재는 동작할 수 있지만 향후 정리가 필요하다.
- `mismatch`
  - 프런트 호출 경로나 기대 응답이 현재 백엔드 정의와 어긋날 가능성이 있다.
- `review`
  - 코드상 호출은 확인되지만 실제 계약 검증이 더 필요하다.

## 3. 화면별 매핑

## 3.1 공통 / 인증

### `/login`

기준 파일:

- [frontend/src/pages/LoginPage.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/LoginPage.tsx:67)
- [frontend/src/contexts/AuthContext.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/contexts/AuthContext.tsx:88)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `POST /token/` | 로그인 | confirmed | JWT 발급 |
| `POST /token/refresh/` | 토큰 갱신 | confirmed | axios interceptor 사용 |
| `GET /injection/user/me/` | 현재 사용자 정보 | confirmed | 장기적으로 `/users/me` 권장 |
| `POST /signup-request/` | 회원가입 요청 | confirmed | 공개 엔드포인트 |

## 3.2 분석 / 대시보드

### `/analysis`

기준 파일:

- [frontend/src/pages/analysis/index.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/analysis/index.tsx:1)

화면 구성상 직접 API 호출은 하위 컴포넌트에 위임된다.

주요 하위 의존 예상:

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `GET /injection/reports/summary/` | 사출 요약 | confirmed | OEE/현황 기초 데이터 일부 |
| `GET /injection/production-matrix/` | 사출 생산 매트릭스 | confirmed | 모니터링 계열 |
| `GET /assembly/reports/summary/` | 가공 요약 | confirmed | assembly summary 액션 존재 |
| `GET /assembly/reports/trend-data/` | 가공 추이 | confirmed | assembly action 확인됨 |

### `/production`

기준 파일:

- [frontend/src/pages/production/Dashboard.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/production/Dashboard.tsx:1)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `GET /production/status/` | 설비/라인 진행 현황 | confirmed | 주 화면 핵심 API |
| `GET /production/dashboard/` | 생산 대시보드 데이터 | confirmed | `lib/api.ts` 사용 |

### `/production/stats`

기준 파일:

- [frontend/src/pages/production/Stats.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/production/Stats.tsx:1)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `GET /production/mes-report-stats/` | MES 실적 통계 | confirmed | stats 핵심 |

## 3.3 생산 계획

### `/production/plan`

기준 파일:

- [frontend/src/pages/production/Plan.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/production/Plan.tsx:1)
- [frontend/src/lib/api.ts](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/lib/api.ts:137)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `POST /production/plan/upload/` | 계획 파일 업로드 | confirmed | 핵심 import |
| `GET /production/plan-dates/` | 계획 존재 날짜 | confirmed | 날짜 선택 |
| `GET /production/plan-summary/` | 요약 조회 | confirmed | 캘린더/요약 |
| `GET /production/plans/?date=...&plan_type=...` | 계획 목록 | confirmed | 편집 기본 |
| `PATCH /production/plans/{id}/` | 계획 수정 | confirmed | 인라인 수정 |
| `POST /production/plans/` | 계획 추가 | confirmed | 신규 row 생성 |
| `DELETE /production/plans/{id}/` | 계획 삭제 | confirmed | 편집 기능 |
| `GET /production/plan-parts/` | part 검색 보조 | confirmed | 자동완성 |
| `POST /production/part-cavity/` | cavity 저장 | confirmed | 품목 기준 정리 필요 |

## 3.4 사출

### `/injection`

기준 파일:

- [frontend/src/pages/summary/index.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/summary/index.tsx:1)
- [frontend/src/hooks/useReports.ts](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/hooks/useReports.ts:1)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `GET /injection/reports/` | 기록 목록 | confirmed | 날짜 필터 기반 |
| `GET /injection/reports/dates/` | 기록 날짜 목록 | confirmed | 캘린더 |
| `GET /injection/reports/summary/` | 요약 통계 | confirmed | 상단 카드 |
| `POST /injection/reports/` | 신규 기록 생성 | confirmed | `RecordForm` 사용 |
| `PATCH /injection/reports/{id}/` | 기록 수정 | confirmed | 테이블 수정 |
| `DELETE /injection/reports/{id}/` | 기록 삭제 | confirmed | 테이블 삭제 |
| `GET /injection/reports/export/` | CSV 다운로드 | confirmed | export |
| `POST /injection/reports/bulk-import/` | CSV 업로드 | confirmed | import |
| `GET /injection/reports/historical-performance/` | 과거 성과 비교 | confirmed | 모달에서 사용 |

### `/injection/setup`

기준 파일:

- [frontend/src/pages/injection/Setup.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/injection/Setup.tsx:48)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `GET /injection/setup/dashboard/` | 셋업 대시보드 | confirmed | action 존재 |
| `GET /injection/setup/` | 셋업 목록 | confirmed | history/modal 계열 |
| `POST /injection/setup/` | 셋업 생성 | confirmed | modal/form |
| `PATCH /injection/setup/{id}/` | 셋업 수정 | confirmed | modal |
| `DELETE /injection/setup/{id}/` | 셋업 삭제 | confirmed | modal |
| `POST /injection/setup/bulk-create/` | 일괄 생성 | confirmed | action 존재 |
| `POST /injection/setup/{id}/add-test/` | 테스트 기록 추가 | confirmed | action 존재 |
| `GET /injection/setup/cycle-time-history/` | CT 히스토리 | confirmed | action 존재 |
| `GET /injection/parts/{part_no}/standard-cycle-time/` | 표준 CT 조회 | confirmed | custom action |
| `GET /injection/reports/avg-cycle-time/` | 평균 CT 조회 | confirmed | custom action |
| `GET /injection/parts/` | 부품 검색 | confirmed | 셋업 보조 검색 |

### `/injection/monitoring`

기준 파일:

- [frontend/src/pages/injection/MonitoringPage.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/injection/MonitoringPage.tsx:97)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `GET /injection/production-matrix/` | 생산 매트릭스 | confirmed | 핵심 조회 |
| `POST /injection/update-recent-snapshots/` | 최신 스냅샷 갱신 | confirmed | 현재 보안 재검토 필요 |
| `GET /injection/update-recent-snapshots/status/` | 갱신 상태 확인 | confirmed | 현재 보안 재검토 필요 |

## 3.5 가공 / 조립

### `/assembly`

기준 파일:

- [frontend/src/pages/assembly/index.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/assembly/index.tsx:1)
- [frontend/src/hooks/useAssemblyReports.ts](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/hooks/useAssemblyReports.ts:1)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `GET /assembly/reports/` | 기록 목록 | confirmed | 기본 목록 |
| `GET /assembly/reports/summary/` | 요약 | confirmed | summary action |
| `GET /assembly/reports/dates/` | 날짜 목록 | confirmed | dates action |
| `GET /assembly/reports/trend-data/` | 추이 | confirmed | trend action |
| `POST /assembly/reports/` | 신규 기록 | confirmed | create |
| `PATCH /assembly/reports/{id}/` | 수정 | confirmed | update |
| `DELETE /assembly/reports/{id}/` | 삭제 | confirmed | delete |
| `GET /assembly/reports/export/` | CSV export | confirmed | export action |
| `POST /assembly/reports/bulk-import/` | CSV import | confirmed | action 존재 |
| `GET /assembly/reports/historical-performance/` | 과거 성과 | confirmed | action 존재 |
| `GET /assembly/reports/defect-history/` | 불량 유형 조회 | confirmed | action 존재 |
| `POST /assembly/reports/record-defect-usage/` | 불량 유형 사용 기록 | confirmed | action 존재 |
| `POST /assembly/reports/delete-defect-type/` | 불량 유형 삭제 | confirmed | action 존재 |

## 3.6 품질

### `/quality`

기준 파일:

- [frontend/src/pages/quality/index.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/quality/index.tsx:1)
- [frontend/src/pages/quality/QualityReportForm.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/quality/QualityReportForm.tsx:67)
- [frontend/src/pages/quality/QualityReportHistory.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/quality/QualityReportHistory.tsx:379)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `GET /quality/reports/` | 보고서 목록 | confirmed | history 탭 |
| `POST /quality/reports/` | 보고서 생성 | confirmed | form 탭 |
| `PATCH /quality/reports/{id}/` | 보고서 수정 | confirmed | history 편집 |
| `DELETE /quality/reports/{id}/` | 보고서 삭제 | confirmed | history 삭제 |
| `GET /quality/suppliers/` | 공급자 목록 | confirmed | IQC 공급자 |
| `POST /quality/suppliers/get_or_create/` | 공급자 생성 | confirmed | action 존재 |
| `POST /quality/cloudinary-signature/` | 이미지 업로드 서명 | review | 메서드 정책 재확인 권장 |
| `GET /assembly/products/search-parts/` | part prefix 검색 | mismatch | backend action은 injection product 쪽에서 확인됨 |
| `POST /assembly/partspecs/create-or-update/` | 품목 보조 생성 | mismatch | backend assembly router에는 action 미확인 |

### `/quality/daily-attention`

기준 파일:

- [frontend/src/pages/quality/DailyAttention.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/quality/DailyAttention.tsx:641)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `GET /quality/daily-attention/` | 생산계획 기반 품질 주의 목록 | confirmed | 핵심 화면 |

## 3.7 재고 / 영업

### `/sales/inventory`

기준 파일:

- [frontend/src/hooks/useInventoryStatus.ts](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/hooks/useInventoryStatus.ts:1)
- [frontend/src/hooks/useWarehouses.ts](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/hooks/useWarehouses.ts:1)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `GET /inventory/` | 현재고 목록 | confirmed | 핵심 조회 |
| `GET /inventory/warehouses/` | 창고 목록 | confirmed | 필터 |
| `GET /inventory/last-update/` | 최근 갱신 시각 | confirmed | 상단 정보 |
| `GET /inventory/unified-parts/search/` | 통합 품목 검색 | confirmed | selector 사용 |
| `POST /inventory/unified-parts/` | 통합 품목 생성 | confirmed | selector 생성 |
| `GET /inventory/unified-parts/models/` | 모델 목록 | confirmed | selector |

### `/sales/inventory-status`

기준 파일:

- [frontend/src/pages/sales/InventoryStatus.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/sales/InventoryStatus.tsx:49)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `POST /inventory/refresh/` | 재고 갱신 시작 | confirmed | background refresh |
| `GET /inventory/refresh/` | 갱신 상태 | confirmed | polling |
| `GET /inventory/export/` | CSV export | confirmed | export |

### `/sales/daily-report`

기준 파일:

- [frontend/src/hooks/useDailyReport.ts](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/hooks/useDailyReport.ts:1)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `GET /inventory/daily-report/` | 일일 리포트 상세 | confirmed | 핵심 조회 |
| `GET /inventory/daily-report/summary/` | 요약 | confirmed | 상단 요약 |
| `GET /inventory/daily-report/calendar/` | 캘린더 | confirmed | 날짜 선택 |
| `GET /inventory/daily-report/compare/` | 날짜 비교 | confirmed | 일부 `fetch('/api/...')` 직접 사용 |
| `GET /inventory/daily-report/export-csv/` | CSV export | confirmed | 일부 `fetch('/api/...')` 직접 사용 |
| `POST /inventory/snapshot/create/` | 스냅샷 생성 | confirmed | action |
| `POST /inventory/email/schedule/` | 이메일 예약 | confirmed | 일부 `fetch('/api/...')` 직접 사용 |
| `GET /inventory/email/status/` | 이메일 상태 | confirmed | 일부 `fetch('/api/...')` 직접 사용 |
| `GET /inventory/finished-goods/transactions/` | 완성품 입출고 스냅샷 조회 | confirmed | 별도 hook |
| `POST /inventory/finished-goods/transactions/` | 완성품 입출고 스냅샷 갱신 | mismatch | 현재 `urls.py`에서 POST 라우트 확인 필요 |

## 3.8 품목 / 모델 관리

### `/models`

기준 파일:

- [frontend/src/pages/models/index.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/models/index.tsx:1)
- [frontend/src/hooks/usePartSpecs.ts](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/hooks/usePartSpecs.ts:1)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `GET /injection/parts/` | 품목 목록/검색 | confirmed | 현행 기준 master |
| `POST /injection/parts/` | 품목 생성 | confirmed | create |
| `PUT /injection/parts/{id}/` | 품목 수정 | confirmed | update |
| `DELETE /injection/parts/{id}/` | 품목 삭제 | confirmed | delete |

## 3.9 ECO

### `/eco2`

기준 파일:

- [frontend/src/components/Eco2Manager.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/components/Eco2Manager.tsx:184)
- [frontend/src/hooks/useEcos.ts](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/hooks/useEcos.ts:1)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `GET /ecos/` | ECO 목록 | confirmed | top-level include 존재 |
| `POST /ecos/` | ECO 생성 | confirmed | create |
| `PATCH /ecos/{id}/` | ECO 수정 | confirmed | update |
| `DELETE /ecos/{id}/` | ECO 삭제 | confirmed | delete |
| `GET /ecos/{id}/` | 상세 | confirmed | detail |
| `POST /ecos/{id}/details/bulk/` | detail 일괄 저장 | confirmed | action 존재 |
| `POST /ecos/bulk-upload/` | bulk 업로드 | mismatch | backend action 미확인 |
| `GET /ecos/by-part/` | part 기준 조회 | mismatch | backend action 미확인 |
| `GET /ecos/unified-search/` | 통합 검색 | confirmed | action 존재 |
| `GET /eco-parts/` | ECO part 검색 | confirmed | include 존재 |
| `GET /eco-parts/with-eco-count/` | 건수 포함 검색 | mismatch | backend action 미확인 |

## 3.10 관리자

### `/admin/user-management`

기준 파일:

- [frontend/src/pages/admin/UserApproval.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/admin/UserApproval.tsx:67)
- [backend/config/urls_admin.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/config/urls_admin.py:1)

| 사용 API | 목적 | 상태 | 비고 |
| --- | --- | --- | --- |
| `GET /admin/approval-requests/?status=pending` | 승인 대기 목록 | confirmed | admin urls 존재 |
| `POST /admin/approval-requests/{id}/approve/` | 승인 | confirmed | admin urls 존재 |
| `POST /admin/approval-requests/{id}/reject/` | 거절 | confirmed | admin urls 존재 |
| `GET /admin/user-profiles/` | 사용자 프로필 목록 | confirmed | router 존재 |
| `PATCH /admin/user-profiles/{id}/` | 권한 수정 | confirmed | router 존재 |
| `DELETE /admin/user-profiles/{id}/` | 사용자 프로필 삭제 | confirmed | router 존재 |
| `POST /admin/user/reset-password/` | 비밀번호 초기화 | confirmed | admin urls 존재 |

## 4. 지금 바로 보이는 정리 포인트

### 4.1 confirmed 비율이 높은 영역

- 로그인/사용자 기본 인증 흐름
- 생산계획/생산 대시보드
- 사출 기본 CRUD
- 가공 기본 CRUD
- 품질 기본 CRUD
- 재고 일일 리포트
- 관리자 승인 기능

이 영역들은 새 프런트에서 우선 재사용하기 좋다.

### 4.2 mismatch 또는 review가 많은 영역

- ECO 확장 검색/건수 관련 API
- 품질/가공 화면에서 쓰는 part search 우회 호출
- 일부 assembly 관련 `create-or-update` 류 호출
- 완성품 입출고 POST 갱신 API
- 직접 `fetch('/api/...')`를 쓰는 일부 재고 기능

이 영역들은 재구축 초기에 어댑터를 만들거나 API를 먼저 정리하는 편이 좋다.

### 4.3 API 표준화 우선순위

1. 품목/검색 계열 API
2. ECO 확장 액션 API
3. 품질 입력 화면에서 참조하는 보조 검색 API
4. 재고/완성품 스냅샷의 read/write 경계

## 5. 다음 작업 추천

이 문서 다음으로 가장 유용한 작업은 아래다.

1. `permissions-matrix.md`
2. `data-lineage-map.md`
3. `frontend-module-boundaries.md`
