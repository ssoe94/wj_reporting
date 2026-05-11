# API 엔드포인트 매트릭스

## 1. 목적

이 문서는 현재 백엔드 엔드포인트를 도메인별로 정리하고, 각 엔드포인트의 성격과 차기 상태를 분류한다.

기준 파일:

- [backend/config/urls.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/config/urls.py:15)
- 각 앱의 `urls.py`

주의:

- DRF `ModelViewSet`/`Router`는 일반적으로 목록/상세 CRUD를 제공한다.
- 아래 표의 메서드 표기는 현재 코드 구조를 기준으로 한 운영 관점 요약이다.
- 실제 상세 메서드 제한은 viewset/permission 구현과 함께 최종 검증이 필요하다.

## 2. 전역/공통 API

| Path | Methods | 도메인 | 유형 | 인증 | 현재 역할 | 차기 상태 |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/health` | `GET` | 공통 | health | 불필요 | 헬스체크 | 유지 |
| `/api/token/` | `POST` | 인증 | auth | 불필요 | JWT 로그인 | 유지, `/auth/login` 별칭 검토 |
| `/api/token/refresh/` | `POST` | 인증 | auth | 불필요 | 토큰 갱신 | 유지, `/auth/refresh` 별칭 검토 |
| `/api/signup-request/` | `POST` | 가입 | transaction | 불필요 | 가입 요청 생성 | 유지 |
| `/api/user/change-password/` | `POST` | 사용자 | action | 인증 필요 | 비밀번호 변경 | `users/me/password` 계열로 정리 검토 |

## 3. Injection API

기준 파일:

- [backend/injection/urls.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/injection/urls.py:15)

### 3.1 Master / Transaction

| Path | Methods | 유형 | 인증 | 현재 역할 | 차기 상태 |
| --- | --- | --- | --- | --- | --- |
| `/api/injection/reports/` | `GET, POST` | transaction | 인증 필요 | 사출 보고서 목록/생성 | 유지 |
| `/api/injection/reports/{id}/` | `GET, PUT, PATCH, DELETE` | transaction | 인증 필요 | 사출 보고서 상세/수정/삭제 | 유지 |
| `/api/injection/reports/dates/` | `GET` | analytics helper | 인증 필요 | 보고 날짜 목록 | 유지, 목록 메타로 흡수 가능 |
| `/api/injection/reports/summary/` | `GET` | analytics | 인증 필요 | 사출 요약 통계 | 유지, analytics로 분리 검토 |
| `/api/injection/reports/export/` | `GET` | export | 인증 필요 | CSV 내보내기 | 유지 |
| `/api/injection/reports/bulk-import/` | `POST` | import | 인증 필요 | CSV 일괄 업로드 | 유지, 액션 API로 명시화 |
| `/api/injection/products/` | `GET, POST` | master | 인증 필요 | 제품 마스터 목록/생성 | 유지 |
| `/api/injection/products/{id}/` | `GET, PUT, PATCH, DELETE` | master | 인증 필요 | 제품 마스터 상세 | 유지 |
| `/api/injection/parts/` | `GET, POST` | master | 인증 필요 | Part spec 목록/생성 | 장기적으로 공통 parts로 정리 |
| `/api/injection/parts/{id}/` | `GET, PUT, PATCH, DELETE` | master | 인증 필요 | Part spec 상세 | 장기적으로 공통 parts로 정리 |
| `/api/injection/eco-parts/` | `GET, POST` | master | 인증 필요 | ECO 전용 품목 | ECO 도메인으로 분리 검토 |
| `/api/injection/eco-parts/{id}/` | `GET, PUT, PATCH, DELETE` | master | 인증 필요 | ECO 전용 품목 상세 | ECO 도메인으로 분리 검토 |
| `/api/injection/ecos/` | `GET, POST` | transaction | 인증 필요 | ECO 목록/생성 | `/api/eco/...`로 장기 정리 |
| `/api/injection/ecos/{id}/` | `GET, PUT, PATCH, DELETE` | transaction | 인증 필요 | ECO 상세 | `/api/eco/...`로 장기 정리 |
| `/api/ecos/` | router include | transaction | 인증 필요 | 별도 공개 ECO 라우트 | 중복 구조 정리 필요 |
| `/api/eco-parts/` | router include | master | 인증 필요 | 별도 공개 ECO part 라우트 | 중복 구조 정리 필요 |

### 3.2 User / Permission

| Path | Methods | 유형 | 인증 | 현재 역할 | 차기 상태 |
| --- | --- | --- | --- | --- | --- |
| `/api/injection/signup-requests/` | `GET, POST, ...` | transaction/admin | 인증/권한 필요 | 가입 요청 관리 | auth/admin 도메인으로 재정리 |
| `/api/injection/user-profiles/` | `GET, POST, ...` | master/admin | 인증/권한 필요 | 사용자 프로필/권한 관리 | auth/admin 도메인으로 재정리 |
| `/api/injection/user/me/` | `GET` | auth | 인증 필요 | 현재 로그인 사용자 정보 | 유지, `/users/me`로 승격 권장 |
| `/api/injection/user/change-password/` | `POST` | action | 인증 필요 | 비밀번호 변경 | 공통 user API로 정리 |
| `/api/injection/user/reset-password/` | `POST` | action/admin | 인증 필요 | 비밀번호 초기화 | 공통 user API로 정리 |

### 3.3 Setup / Monitoring / MES

| Path | Methods | 유형 | 인증 | 현재 역할 | 차기 상태 |
| --- | --- | --- | --- | --- | --- |
| `/api/injection/setup/` | `GET, POST` | master/transaction | 인증 필요 | 사이클타임 셋업 목록/생성 | 유지 |
| `/api/injection/setup/{id}/` | `GET, PUT, PATCH, DELETE` | master/transaction | 인증 필요 | 셋업 상세 | 유지 |
| `/api/injection/test-records/` | `GET, POST` | transaction | 인증 필요 | 테스트 기록 | 유지 |
| `/api/injection/test-records/{id}/` | `GET, PUT, PATCH, DELETE` | transaction | 인증 필요 | 테스트 기록 상세 | 유지 |
| `/api/injection/monitoring-data/` | `GET` | analytics/list | 인증 필요 | 모니터링 레코드 조회 | 유지 |
| `/api/injection/production-matrix/` | `GET` | analytics | 인증 필요 | 생산 매트릭스 | analytics 경계 명확화 |
| `/api/injection/machines/` | `GET` | master | 인증 필요 | 설비 목록 | 공통 equipment master 검토 |
| `/api/injection/resource/open/v1/resource_monitor/_page_list/` | `GET/POST 성격 확인 필요` | integration | 인증 필요 | BLACKLAKE 스타일 모니터링 API | 내부 integration으로 숨김 검토 |
| `/api/injection/injection/monitoring/single-device/` | `GET` | integration/debug | 인증 필요 | 단일 설비 모니터링 | 내부용 분리 검토 |
| `/api/injection/update-recent-snapshots/` | `POST` | action/integration | 현재 AllowAny | 최근 스냅샷 갱신 작업 시작 | 보안 강화 필요 |
| `/api/injection/update-recent-snapshots/status/` | `GET` | job status | 현재 AllowAny | 백그라운드 작업 상태 확인 | 보안 강화 필요 |
| `/api/injection/production/plan/upload/` | `POST` | import | 인증/권한 필요 | 생산 계획 업로드 | production 도메인으로 일원화 |

## 4. Assembly API

기준 파일:

- [backend/assembly/urls.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/assembly/urls.py:8)

| Path | Methods | 유형 | 인증 | 현재 역할 | 차기 상태 |
| --- | --- | --- | --- | --- | --- |
| `/api/assembly/reports/` | `GET, POST` | transaction | 인증 필요 | 가공 보고서 목록/생성 | 유지 |
| `/api/assembly/reports/{id}/` | `GET, PUT, PATCH, DELETE` | transaction | 인증 필요 | 가공 보고서 상세 | 유지 |
| `/api/assembly/products/` | `GET, POST` | master | 인증 필요 | 제품 목록/생성 | 공통 products로 정리 검토 |
| `/api/assembly/products/{id}/` | `GET, PUT, PATCH, DELETE` | master | 인증 필요 | 제품 상세 | 공통 products로 정리 검토 |
| `/api/assembly/partspecs/` | `GET, POST` | master | 인증 필요 | EcoPartSpec 재사용 | 도메인 명확화 필요 |
| `/api/assembly/partspecs/{id}/` | `GET, PUT, PATCH, DELETE` | master | 인증 필요 | EcoPartSpec 상세 | 도메인 명확화 필요 |

비고:

- `assembly`가 실제로는 가공/조립 의미를 같이 갖고 있으므로 용어집에서 먼저 고정할 필요가 있다.

## 5. Quality API

기준 파일:

- [backend/quality/urls.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/quality/urls.py:6)

| Path | Methods | 유형 | 인증 | 현재 역할 | 차기 상태 |
| --- | --- | --- | --- | --- | --- |
| `/api/quality/reports/` | `GET, POST` | transaction | 인증 필요 | 품질 보고서 목록/생성 | 유지 |
| `/api/quality/reports/{id}/` | `GET, PUT, PATCH, DELETE` | transaction | 인증 필요 | 품질 보고서 상세 | 유지 |
| `/api/quality/suppliers/` | `GET, POST` | master | 인증 필요 | 공급자 목록/생성 | 유지 |
| `/api/quality/suppliers/{id}/` | `GET, PUT, PATCH, DELETE` | master | 인증 필요 | 공급자 상세 | 유지 |
| `/api/quality/suppliers/get_or_create/` | `POST` | action | 인증 필요 | 이름 기반 공급자 생성 | 유지, 명시적 액션 API로 표기 |
| `/api/quality/cloudinary-signature/` | `GET/POST 성격 확인 필요` | upload helper | 인증 정책 확인 필요 | Cloudinary 업로드 서명 | 유지 |
| `/api/quality/daily-attention/` | `GET` | analytics | 인증 필요 | 생산계획 기반 품질 주의 목록 | 유지, analytics로 분리 후보 |

## 6. Inventory API

기준 파일:

- [backend/inventory/urls.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/inventory/urls.py:9)

### 6.1 Inventory / Snapshot

| Path | Methods | 유형 | 인증 | 현재 역할 | 차기 상태 |
| --- | --- | --- | --- | --- | --- |
| `/api/inventory/` | `GET` | list | 인증 필요 | 현재고 목록 | 유지 |
| `/api/inventory/refresh/` | `POST, GET` | action/job status | 인증 필요 | 재고 갱신 시작/진행 조회 | 유지, action API 명시화 |
| `/api/inventory/last-update/` | `GET` | helper | 인증 필요 | 최근 업데이트 시간 | 유지 |
| `/api/inventory/status/` | `GET` | analytics | 인증 필요 | 재고 상태 | 유지 |
| `/api/inventory/export/` | `GET` | export | 인증 필요 | 현재고 내보내기 | 유지 |
| `/api/inventory/manual-snapshot/` | `POST` | action/debug | 현재 무인증 | 수동 스냅샷 테스트 | 운영 노출 재검토 |
| `/api/inventory/snapshot/create/` | `POST` | action | 인증 필요 | 스냅샷 생성 | 유지 |

### 6.2 Daily Report

| Path | Methods | 유형 | 인증 | 현재 역할 | 차기 상태 |
| --- | --- | --- | --- | --- | --- |
| `/api/inventory/daily-report/` | `GET` | snapshot/list | 인증 필요 | 일일 보고 상세 | 유지 |
| `/api/inventory/daily-report/summary/` | `GET` | analytics | 인증 필요 | 일일 보고 요약 | 유지 |
| `/api/inventory/daily-report/calendar/` | `GET` | helper | 인증 필요 | 날짜 캘린더 | 유지 |
| `/api/inventory/daily-report/available-dates/` | `GET` | helper | 인증 필요 | 사용 가능 날짜 | 유지 |
| `/api/inventory/daily-report/compare/` | `GET` | analytics | 인증 필요 | 날짜 비교 | 유지 |
| `/api/inventory/daily-report/export-csv/` | `GET` | export | 인증 필요 | CSV 다운로드 | 유지 |
| `/api/inventory/email/schedule/` | `POST` | action | 인증 필요 | 이메일 예약 | 유지 |
| `/api/inventory/email/status/` | `GET` | job status | 인증 필요 | 이메일 상태 | 유지 |

### 6.3 Warehouse / Finished Goods / Unified Parts

| Path | Methods | 유형 | 인증 | 현재 역할 | 차기 상태 |
| --- | --- | --- | --- | --- | --- |
| `/api/inventory/warehouses/` | `GET` | master/helper | 인증 필요 | 창고 목록 | 유지 |
| `/api/inventory/finished-goods/transactions/` | `GET` | snapshot/analytics | 인증 정책 확인 필요 | 완성품 창고 입출고 집계 | 유지 |
| `/api/inventory/unified-parts/` | `GET, POST` | master | 인증 정책 확인 필요 | 통합 품목 목록/생성 | 장기 공통 parts API 핵심 후보 |
| `/api/inventory/unified-parts/{part_no}/` | `GET, PUT, PATCH, DELETE` | master | 인증 정책 확인 필요 | 통합 품목 상세 | 장기 공통 parts API 핵심 후보 |
| `/api/inventory/unified-parts/search/` | `GET` | search/helper | 인증 정책 확인 필요 | 통합 품목 검색 | 유지 |
| `/api/inventory/unified-parts/models/` | `GET` | helper | 인증 정책 확인 필요 | 모델 목록 | 유지 |
| `/api/inventory/unified-parts/migrate/` | `POST/GET 성격 확인 필요` | migration action | 인증 정책 확인 필요 | 레거시 데이터 이행 | 내부용 분리 권장 |
| `/api/inventory/mes-test/` | `GET` | debug/integration | 무인증 | MES 토큰/연결 테스트 | 운영 노출 재검토 |

## 7. Production API

기준 파일:

- [backend/production/urls.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/production/urls.py:17)

| Path | Methods | 유형 | 인증 | 현재 역할 | 차기 상태 |
| --- | --- | --- | --- | --- | --- |
| `/api/production/console/` | `GET` | analytics/detail | 인증 정책 확인 필요 | 생산 콘솔 데이터 | 유지 |
| `/api/production/dashboard/` | `GET` | analytics | 인증 정책 확인 필요 | 생산 대시보드 | 유지 |
| `/api/production/executions/upsert/` | `POST` | action/transaction | 인증 필요 | 생산 실행 입력/수정 | 유지, REST화 검토 |
| `/api/production/mes-report-stats/` | `GET` | analytics | 인증 정책 확인 필요 | MES 실적 통계 | 유지 |
| `/api/production/plan-dates/` | `GET` | helper | 공개 상태 | 계획 존재 날짜 | 인증 정책 재검토 |
| `/api/production/plan-summary/` | `GET` | analytics | 공개 상태 | 계획 요약 | 인증 정책 재검토 |
| `/api/production/plans/` | `GET, POST` | transaction | 인증 필요 | 생산 계획 목록/생성 | 유지 |
| `/api/production/plans/{id}/` | `GET, PUT, PATCH, DELETE` | transaction | 인증 필요 | 생산 계획 상세 | 유지 |
| `/api/production/plan-parts/` | `GET` | search/helper | 인증 필요 | 계획 파트 검색 | 유지 |
| `/api/production/part-cavity/` | `GET/POST 성격 확인 필요` | master/helper | 인증 정책 확인 필요 | cavity 관리 | 공통 parts로 흡수 검토 |
| `/api/production/status/` | `GET` | analytics | 인증 정책 확인 필요 | 설비/라인 진행 상태 | 유지 |
| `/api/production/debug-plan/` | `GET` | debug | 인증 정책 확인 필요 | 디버그용 계획 확인 | 내부용 분리 권장 |
| `/api/production/plan/upload/` | `POST` | import | 인증/권한 필요 | 계획 업로드 | 유지, production 도메인 단일화 |

## 8. Overview / Sales API

기준 파일:

- [backend/overview/urls.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/overview/urls.py:6)
- [backend/sales/urls.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/sales/urls.py:6)

| Path | Methods | 유형 | 인증 | 현재 역할 | 차기 상태 |
| --- | --- | --- | --- | --- | --- |
| `/api/overview/` | 확인 필요 | placeholder | 확인 필요 | 베타/미완성 가능성 | 범위 재정의 필요 |
| `/api/sales/` | 확인 필요 | placeholder | 확인 필요 | 실질 기능은 inventory 쪽에 분산 | sales 도메인 존재 이유 재정의 필요 |

## 9. 현재 구조에서 먼저 정리할 API 이슈

### 9.1 중복/혼재 경로

- ECO 관련 경로가 `injection` 내부와 최상위 `/api/ecos`, `/api/eco-parts`에 중복 노출
- 생산 계획 업로드가 `config`와 `injection` 경로 양쪽에 존재
- `sales`라는 도메인 이름과 실제 재고 API 위치가 다소 어긋남

### 9.2 공개/보안 재검토 대상

- `/api/inventory/mes-test/`
- `/api/inventory/manual-snapshot/`
- `/api/injection/update-recent-snapshots/`
- `/api/injection/update-recent-snapshots/status/`
- 공개 permission으로 내려간 production 일부 조회 API

### 9.3 action endpoint 정리 대상

- `bulk-import`
- `upload`
- `upsert`
- `refresh`
- `create`
- `schedule`

이 액션성 엔드포인트들은 유지해도 되지만, 문서에서는 REST 자원과 분리해서 관리해야 한다.

## 10. 차기 상태 분류 기준

이 문서에서 사용하는 차기 상태 의미는 아래와 같다.

- `유지`: 그대로 가져가도 무방
- `정리`: 이름/응답/권한 기준만 다듬으면 됨
- `분리`: analytics, debug, integration 같은 하위 책임으로 분리 필요
- `통합`: 중복되는 엔드포인트를 하나의 기준 API로 수렴
- `제거 검토`: 운영 노출 가치가 낮거나 내부용 성격이 강함

## 11. 다음 작업 추천

이 문서 다음으로 가장 유용한 작업은 아래다.

1. `api-status-map.md`
   - 각 엔드포인트를 `active`, `legacy`, `deprecated`, `planned`로 분류

2. `screen-to-api-map.md`
   - 화면별 실제 호출 API 연결

3. `domain-glossary.md`
   - `part_no`, `material_code`, `model_name`, `business_date` 정의 고정
