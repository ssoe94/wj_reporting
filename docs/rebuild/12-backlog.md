# 실행 백로그

## 1. 목적

이 문서는 재구축 로드맵을 실제 작업 단위로 쪼개서 관리하기 위한 백로그다.

목표는 아래와 같다.

1. 지금 당장 착수할 수 있는 작업을 분명히 한다.
2. 우선순위와 선행 조건을 한눈에 본다.
3. 프런트, API, DB, 권한, AI 준비 작업이 서로 섞이지 않게 한다.

기준 문서:

- [docs/rebuild/10-frontend-module-boundaries.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/10-frontend-module-boundaries.md:1)
- [docs/rebuild/11-implementation-roadmap.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/11-implementation-roadmap.md:1)
- [docs/rebuild/07-screen-to-api-map.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/07-screen-to-api-map.md:1)
- [docs/rebuild/08-permissions-matrix.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/08-permissions-matrix.md:1)

## 2. 상태 값

권장 상태 값:

- `todo`
- `ready`
- `in_progress`
- `blocked`
- `done`

## 3. 우선순위 기준

- `P0`
  - 시작하지 않으면 전체 작업이 흔들리는 기준 작업
- `P1`
  - 지금 스프린트에 바로 착수 가능한 핵심 작업
- `P2`
  - 기초가 갖춰진 뒤 이어서 붙일 작업
- `P3`
  - 후속 정리 또는 확장 작업

## 4. 에픽 목록

| 에픽 ID | 이름 | 설명 |
| --- | --- | --- |
| `EPIC-01` | 프런트 기초 공사 | 앱 셸, auth, 공통 UI, API 계층 |
| `EPIC-02` | 읽기 중심 화면 이관 | analysis, production, inventory |
| `EPIC-03` | 혼합 화면 분해 | injection, assembly, quality |
| `EPIC-04` | API 계약 정리 | mismatch API, 공통 응답, 직접 fetch 제거 |
| `EPIC-05` | 권한 정리 | 메뉴 가드와 서버 권한 정합성 확보 |
| `EPIC-06` | 마스터/DB 정리 | 품목 기준, 날짜 기준, 파생 데이터 기준 |
| `EPIC-07` | AI 준비 | AI read layer, 문서/RAG 기초 준비 |

## 5. 즉시 착수 백로그

## 5.1 `EPIC-01` 프런트 기초 공사

| ID | 우선순위 | 작업 | 선행 조건 | 상태 |
| --- | --- | --- | --- | --- |
| `FE-001` | P0 | 새 프런트 작업 위치 결정 | 없음 | ready |
| `FE-002` | P0 | `app/domains/shared` 기준 폴더 구조 생성 | `FE-001` | ready |
| `FE-003` | P0 | 라우터 뼈대 작성 | `FE-002` | ready |
| `FE-004` | P0 | auth provider와 route guard 구조 작성 | `FE-002` | ready |
| `FE-005` | P1 | 공통 API client 구조 작성 | `FE-002` | ready |
| `FE-006` | P1 | 공통 레이아웃, 사이드바, 헤더 설계 | `FE-003`, `FE-004` | ready |
| `FE-007` | P1 | 공통 페이지 템플릿 작성 | `FE-006` | ready |
| `FE-008` | P1 | 공통 테이블/필터 패턴 정리 | `FE-005`, `FE-007` | ready |
| `FE-009` | P1 | 에러/로딩 상태 표준화 | `FE-005`, `FE-007` | ready |

## 5.2 `EPIC-02` 읽기 중심 화면 이관

| ID | 우선순위 | 작업 | 선행 조건 | 상태 |
| --- | --- | --- | --- | --- |
| `FE-101` | P1 | `/analysis` 새 화면 골격 작성 | `FE-003`, `FE-005`, `FE-007` | ready |
| `FE-102` | P1 | `/production` 대시보드 이관 | `FE-003`, `FE-005`, `FE-007` | ready |
| `FE-103` | P1 | `/production/stats` 이관 | `FE-102` | ready |
| `FE-104` | P1 | `/sales/inventory` 이관 | `FE-003`, `FE-005`, `FE-008` | ready |
| `FE-105` | P1 | `/sales/daily-report` 이관 | `FE-104` | ready |
| `FE-106` | P2 | `/production/plan` 이관 | `FE-102`, `API-001` | todo |

## 5.3 `EPIC-03` 혼합 화면 분해

| ID | 우선순위 | 작업 | 선행 조건 | 상태 |
| --- | --- | --- | --- | --- |
| `FE-201` | P1 | `/injection` 분해안 확정 | 없음 | ready |
| `FE-202` | P1 | `/assembly` 분해안 확정 | 없음 | ready |
| `FE-203` | P1 | `/quality` 분해안 확정 | 없음 | ready |
| `FE-204` | P2 | `/injection/dashboard`, `records`, `new` 구현 | `FE-201`, `API-003` | todo |
| `FE-205` | P2 | `/assembly/dashboard`, `records`, `new` 구현 | `FE-202`, `API-004` | todo |
| `FE-206` | P2 | `/quality/reports`, `reports/new` 구현 | `FE-203`, `API-005` | todo |

## 5.4 `EPIC-04` API 계약 정리

| ID | 우선순위 | 작업 | 선행 조건 | 상태 |
| --- | --- | --- | --- | --- |
| `API-001` | P1 | 생산 계획 API 계약 재확인 | 없음 | ready |
| `API-002` | P1 | 직접 `fetch('/api/...')` 사용 지점 목록화 | 없음 | ready |
| `API-003` | P1 | 사출 관련 read/write 계약 점검 | 없음 | ready |
| `API-004` | P1 | 가공 관련 read/write 계약 점검 | 없음 | ready |
| `API-005` | P0 | 품질 화면 mismatch API 정리안 작성 | 없음 | ready |
| `API-006` | P2 | 공통 `/users/me` 계약 정의 | `AUTH-001` | todo |
| `API-007` | P2 | 배치성 action API 권한 분리안 작성 | `AUTH-002` | todo |

## 5.5 `EPIC-05` 권한 정리

| ID | 우선순위 | 작업 | 선행 조건 | 상태 |
| --- | --- | --- | --- | --- |
| `AUTH-001` | P1 | 최소 capability 목록 정의 | 없음 | ready |
| `AUTH-002` | P1 | 메뉴 노출과 API 권한의 차이 표기 | 없음 | ready |
| `AUTH-003` | P2 | field terminal role 명시화 | `AUTH-001` | todo |
| `AUTH-004` | P2 | admin/staff 차이 명문화 | `AUTH-001` | todo |

## 5.6 `EPIC-06` 마스터/DB 정리

| ID | 우선순위 | 작업 | 선행 조건 | 상태 |
| --- | --- | --- | --- | --- |
| `DATA-001` | P1 | business date 기준 정의 | 없음 | ready |
| `DATA-002` | P1 | timezone 기준 정의 | 없음 | ready |
| `DATA-003` | P1 | part/model/material 기준 테이블 작성 | 없음 | ready |
| `DATA-004` | P2 | UnifiedPartSpec 장기 방향 정리 | `DATA-003` | todo |
| `DATA-005` | P2 | 원천 데이터와 스냅샷 데이터 경계 재확인 | `DATA-001`, `DATA-002` | todo |

## 5.7 `EPIC-07` AI 준비

| ID | 우선순위 | 작업 | 선행 조건 | 상태 |
| --- | --- | --- | --- | --- |
| `AI-001` | P2 | AI가 읽을 데이터 목록 초안 작성 | `DATA-005` | todo |
| `AI-002` | P2 | AI 전용 read API 후보 정리 | `API-001`, `API-003`, `API-004`, `API-005` | todo |
| `AI-003` | P3 | 문서/RAG 대상 자산 목록화 | `AI-001` | todo |

## 6. 이번 주 추천 범위

이번 주에는 아래까지만 하는 것이 가장 좋다.

1. `FE-001` ~ `FE-009`
2. `FE-101`, `FE-102`, `FE-104`
3. `API-002`, `API-005`
4. `AUTH-001`, `AUTH-002`
5. `DATA-001`, `DATA-002`, `DATA-003`

이 범위면:

- 새 프런트 골격을 만들 수 있고
- 조회 중심 화면 2~3개를 먼저 올릴 수 있고
- 이후 막힐 가능성이 큰 권한/API/기준 데이터 이슈를 초반에 드러낼 수 있다

## 7. 아직 하지 않는 것이 좋은 것

아래는 지금 당장 손대지 않는 편이 좋다.

1. 운영 DB 대규모 migration
2. `/injection`, `/assembly`, `/quality` 상세 폼 완성
3. AI 모델 서빙 구현
4. 기존 사이트 전면 교체

## 8. 완료 판정 기준

이 백로그의 1차 완료는 아래 기준으로 본다.

1. 새 프런트 골격이 실행된다.
2. 최소 3개 조회 화면이 새 구조에서 동작한다.
3. 품질 mismatch API 정리안이 문서로 나온다.
4. capability 최소 목록이 합의된다.
5. business date/timezone 기준이 고정된다.
