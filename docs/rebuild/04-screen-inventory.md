# 화면 인벤토리

## 1. 목적

이 문서는 현재 프런트엔드 화면을 기준으로 다음을 정리한다.

- 현재 실제 라우트
- 화면의 역할
- 입력/조회/집계 성격
- 관련 도메인
- 차기 재구축 시 우선순위
- 통합/분리/제거 후보

기준 파일:

- [frontend/src/App.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/App.tsx:578)

## 2. 직접 라우트 화면 목록

| 현재 URL | 화면명 | 소스 파일 | 모듈 | 성격 | 현재 역할 | 차기 권장 상태 |
| --- | --- | --- | --- | --- | --- | --- |
| `/login` | 로그인 | `pages/LoginPage.tsx` | 공통 | 입력 | 인증 진입점 | 유지 |
| `/` | 홈 리다이렉트 | `App.tsx > HomeRedirect` | 공통 | 라우팅 | 사용자 유형에 따라 `/analysis` 또는 `/field` 이동 | 유지, 규칙 명확화 |
| `/field` | 현장 런처 | `pages/field/Launcher.tsx` | 현장단말 | 조회/작업 | 현장 사용자 진입점 | 유지, 일반 사용자 흐름과 분리 |
| `/field/:stationId` | 현장 스테이션 | `pages/field/Station.tsx` | 현장단말 | 작업 | 단말별 작업 화면 | 유지, 전용 권한 체계 분리 |
| `/analysis` | 분석 메인 | `pages/analysis/index.tsx` | 분석 | 집계 | 사출/가공 대시보드, OEE, 비가동 분석 | 최우선 재구축 |
| `/production` | 생산 대시보드 | `pages/production/Dashboard.tsx` | 생산 | 집계 | 생산 현황 카드/상세 | 최우선 재구축 |
| `/production/plan` | 생산 계획 | `pages/production/Plan.tsx` | 생산 | 조회/입력 | 계획 조회/업로드/수정 | 우선 재구축 |
| `/production/stats` | 생산 통계 | `pages/production/Stats.tsx` | 생산 | 집계 | 실적/통계 조회 | 우선 재구축 |
| `/injection/dashboard` | 사출 대시보드 | `pages/injection/Dashboard.tsx` | 사출 | 집계 | 사출 운영 현황 | 우선 재구축 |
| `/injection` | 사출 메인 | `pages/summary/index.tsx` | 사출 | 혼합 | 요약 + 기록 조회 + 신규 입력 | 분리 재설계 필요 |
| `/injection/setup` | 사출 셋업 | `pages/injection/Setup.tsx` | 사출 | 입력/관리 | 사이클타임/셋업 관리 | 우선 재구축 |
| `/injection/monitoring` | 사출 모니터링 | `pages/injection/MonitoringPage.tsx` | 사출 | 조회/실시간 | 모니터링/MES 기반 현황 | 유지, API 경계 정리 |
| `/assembly/dashboard` | 가공 대시보드 | `pages/assembly/Dashboard.tsx` | 가공 | 집계 | 가공 현황 | 우선 재구축 |
| `/assembly` | 가공 메인 | `pages/assembly/index.tsx` | 가공 | 혼합 | 요약 + 기록 조회 + 신규 입력 | 분리 재설계 필요 |
| `/quality` | 품질 메인 | `pages/quality/index.tsx` | 품질 | 혼합 | 보고서 입력/히스토리 탭 | 분리 재설계 필요 |
| `/quality/daily-attention` | 품질 일일 주의 | `pages/quality/DailyAttention.tsx` | 품질 | 집계 | 생산계획과 품질 이력 결합 조회 | 우선 재구축 |
| `/sales/inventory` | 재고 분석 | `pages/sales/Inventory.tsx` | 재고/영업 | 조회/집계 | 현재고/검색/필터 | 우선 재구축 |
| `/sales/daily-report` | 일일 재고 보고 | `pages/sales/DailyReport.tsx` | 재고/영업 | 조회/집계 | 스냅샷 기반 일일 리포트 | 우선 재구축 |
| `/sales/inventory-status` | 재고 상태 | `pages/sales/InventoryStatus.tsx` | 재고/영업 | 조회 | 재고 상태 화면 | 유지 |
| `/eco2` | ECO 관리 | `pages/eco2/index.tsx` | 개발/ECO | 조회/입력 | ECO 관리 | 유지, 정보구조 개선 |
| `/models` | 모델/품목 관리 | `pages/models/index.tsx` | 개발/품목 | 조회/입력 | Part spec 관리 | 유지, 공통 품목 마스터 방향으로 재정의 |
| `/admin/user-management` | 사용자 관리 | `pages/admin/UserApproval.tsx` | 관리자 | 승인/관리 | 가입 승인/권한 관리 | 유지, 권한 체계 정비 |
| `/admin/user-approval` | 사용자 승인 레거시 URL | `pages/admin/UserApproval.tsx` | 관리자 | 라우트 호환 | 레거시 호환 | 리다이렉트로 축소 권장 |
| `/overview` | 종합 관리(베타) | `pages/overview/index.tsx` | 개요 | 플레이스홀더 | 베타/미완성 | 범위 재정의 또는 제거 후보 |
| `/sales` | 영업 루트 | `pages/sales/Inventory.tsx` | 재고/영업 | 라우트 호환 | inventory로 연결되는 진입점 | 명시적 리다이렉트 권장 |
| `/eco` | ECO 레거시 URL | `Navigate to /eco2` | 개발/ECO | 라우트 호환 | 구버전 URL 유지 | 리다이렉트 유지 |

## 3. 혼합 화면 분해 대상

현재 몇몇 화면은 "대시보드 + 목록 + 입력"이 한 페이지 안에 같이 있다.
재구축 시 가장 먼저 분리 설계해야 한다.

### 사출 메인 `/injection`

기준 파일:

- [frontend/src/pages/summary/index.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/summary/index.tsx:1)

현재 내부 섹션:

- 요약 카드
- 추이 차트
- 날짜별 기록 테이블
- CSV 업로드/다운로드
- 신규 기록 입력

권장 분해:

- `/injection/dashboard`
- `/injection/records`
- `/injection/new`
- `/injection/import`

### 가공 메인 `/assembly`

기준 파일:

- [frontend/src/pages/assembly/index.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/assembly/index.tsx:1)

현재 내부 섹션:

- 요약
- 기록 조회
- 신규 입력

권장 분해:

- `/assembly/dashboard`
- `/assembly/records`
- `/assembly/new`

### 품질 메인 `/quality`

기준 파일:

- [frontend/src/pages/quality/index.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/quality/index.tsx:1)

현재 내부 구조:

- 보고서 입력 탭
- 보고서 히스토리 탭

권장 분해:

- `/quality/reports/new`
- `/quality/reports`
- `/quality/daily-attention`

## 4. 우선순위 제안

### P1

- `/analysis`
- `/production`
- `/production/plan`
- `/injection`
- `/assembly`
- `/quality`
- `/sales/inventory`
- `/sales/daily-report`

이유:

- 사용 빈도가 높을 가능성이 크다.
- 도메인 구조 문제를 가장 잘 드러낸다.
- AI 연동 전 데이터/집계/표시 규칙 정리에 직접 연결된다.

### P2

- `/injection/setup`
- `/injection/monitoring`
- `/quality/daily-attention`
- `/models`
- `/eco2`
- `/admin/user-management`

### P3

- `/overview`
- `/sales`
- `/admin/user-approval`
- `/eco`

## 5. 화면별 재구축 원칙

### 대시보드 화면

- 읽기 전용으로 유지
- 집계 API만 사용
- 카드/차트/드릴다운 구조 일관화

### 목록/기록 화면

- 필터, 검색, 정렬 규칙 통일
- 테이블 상태와 쿼리 상태 분리
- export/import는 별도 액션 영역으로 분리

### 입력 화면

- 폼 유효성 검증 규칙 서버 기준으로 통일
- 임시 저장/제출/수정의 상태 전이를 문서화
- 공통 입력 컴포넌트 사용

## 6. 라우트 구조 재설계 초안

권장 차기 라우트 예시:

```text
/dashboard
/production/dashboard
/production/plans
/production/executions
/injection/dashboard
/injection/records
/injection/reports/new
/injection/setup
/injection/monitoring
/assembly/dashboard
/assembly/records
/assembly/reports/new
/quality/reports
/quality/reports/new
/quality/daily-attention
/inventory/current
/inventory/daily-reports
/eco
/parts
/admin/users
/field
```

핵심 원칙:

- dashboard와 작업 화면 분리
- `new`, `records`, `dashboard`, `setup` 같은 suffix 규칙 통일
- 모듈 이름은 URL에서 일관되게 유지

## 7. 정리 후보/레거시 후보

아래 파일들은 현재 직접 라우트 기준으로는 주 경로가 아니거나, 다른 화면 내부로 흡수된 성격이 강하다.

- `pages/eco/index.tsx`
- `pages/machining/index.tsx`
- `pages/quality/report.tsx`
- `pages/quality/stats.tsx`
- `pages/quality/QualityReportForm.tsx`
- `pages/quality/QualityReportHistory.tsx`
- `pages/injection/New.tsx`
- `pages/injection/Records.tsx`
- `pages/injection/Summary.tsx`
- `pages/assembly/New.tsx`
- `pages/assembly/Records.tsx`
- `pages/assembly/Summary.tsx`

주의:

위 파일들은 실제로는 상위 페이지에서 조합용으로 사용될 수 있으므로 즉시 삭제 대상은 아니다.
다만 "직접 라우트 화면"과 "내부 조합 컴포넌트"를 구분해서 역할을 다시 명확히 해야 한다.

## 8. 다음 작업 추천

이 문서 다음으로 가장 유용한 작업은 아래 두 가지다.

1. 각 화면별 사용 API를 매핑한 `screen-to-api-map.md`
2. 각 화면별 권한 요구사항을 정리한 `screen-permissions.md`
