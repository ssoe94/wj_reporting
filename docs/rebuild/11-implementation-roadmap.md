# 구현 로드맵

## 1. 목적

이 문서는 `wj_reporting` 재구축을 실제 실행 순서로 끊어 정리한다.

목표는 아래와 같다.

1. 지금 무엇부터 시작할지 분명하게 한다.
2. 프런트 재구축, 백엔드/API 정리, DB 정리를 서로 충돌 없이 진행한다.
3. "한 번에 깔끔하게"를 목표로 하되, 운영 리스크는 낮춘다.

기준 문서:

- [docs/rebuild/01-rebuild-strategy.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/01-rebuild-strategy.md:1)
- [docs/rebuild/02-api-contract.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/02-api-contract.md:1)
- [docs/rebuild/04-screen-inventory.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/04-screen-inventory.md:1)
- [docs/rebuild/05-api-endpoint-matrix.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/05-api-endpoint-matrix.md:1)
- [docs/rebuild/10-frontend-module-boundaries.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/10-frontend-module-boundaries.md:1)

## 2. 결론 먼저

프런트엔드 재구축은 지금 시작할 수 있다.

다만 시작 방식은 아래여야 한다.

- 기존 사이트 운영은 유지
- 새 프런트는 별도 작업공간에서 시작
- 초반에는 앱 골격, 공통 컴포넌트, API 계층, read-heavy 화면부터 진행
- 혼합 입력 화면과 DB 정합성이 민감한 영역은 2차로 넘김

즉 "프런트를 언제 시작할 수 있나?"에 대한 답은 아래와 같다.

- 지금 바로 시작 가능
- 단, `P1 범위가 분명한 기초 작업`부터 시작해야 함

## 3. 단계별 로드맵

## Phase 0. 기준 확정

목적:

- 구현 전에 흔들리면 안 되는 기준을 고정한다.

작업:

1. 화면 우선순위 확정
2. 용어집 보강
3. 권한 최소 규칙 확정
4. P1 API 계약 확정
5. 새 프런트 라우트 구조 확정

산출물:

- 현재 `docs/rebuild/*` 문서 세트
- P1 화면 목록
- P1 API 목록

완료 기준:

- "무엇을 먼저 만들지"에 대해 팀 안에서 같은 그림을 본다.

현재 상태 판단:

- 대부분 충족
- 추가 보강만 하면 된다

## Phase 1. 프런트 기초 공사

목적:

- 새 프런트의 골격을 만든다.

작업:

1. 새 앱 셸
2. 새 라우터 구조
3. 인증/권한 가드
4. 공통 레이아웃
5. 공통 테이블/필터/폼 패턴
6. API client와 domain api 구조

권장 범위:

- 로그인
- 기본 레이아웃
- 사이드바/헤더
- 에러 처리
- 로딩 패턴
- query/react-query 규칙

완료 기준:

- 화면 내용이 비어 있어도 앱의 뼈대가 돈다.
- 새 프런트에서 API를 일관된 방식으로 호출할 수 있다.
- 권한 없는 메뉴는 기본적으로 감출 수 있다.

프런트 시작 여부:

- 바로 시작 가능

## Phase 2. 읽기 중심 화면 우선 이관

목적:

- 운영 리스크가 낮은 화면부터 새 프런트로 옮긴다.

대상 권장:

1. `/analysis`
2. `/production`
3. `/production/stats`
4. `/sales/inventory`
5. `/sales/daily-report`

이유:

- 읽기 비중이 높다.
- API 계약이 비교적 명확하다.
- 새 공통 패턴 검증에 좋다.

작업:

1. 페이지 템플릿 적용
2. 필터/테이블/차트 패턴 통일
3. 직접 `fetch('/api/...')` 호출 제거
4. 날짜/권한/에러 표준 적용

완료 기준:

- 새 프런트에서 P1 조회 화면이 안정적으로 동작한다.
- 운영자가 새 UI 구조에 익숙해질 수 있다.

## Phase 3. 혼합 화면 분해 후 이관

목적:

- 가장 복잡한 운영 입력 화면을 분리 재설계한다.

대상:

1. `/injection`
2. `/assembly`
3. `/quality`

선행 조건:

1. 라우트 분해안 확정
2. 입력/목록/대시보드 분리 기준 확정
3. mismatch API 처리 방안 확정

작업:

1. `/injection`을 `dashboard`, `records`, `new`, `setup`, `monitoring`으로 분해
2. `/assembly`를 `dashboard`, `records`, `new`로 분해
3. `/quality`를 `reports`, `reports/new`, `daily-attention`으로 분해
4. 입력 폼 유효성 검증과 서버 에러 처리 표준화

완료 기준:

- 혼합 화면이 더 이상 한 페이지에 모든 책임을 갖지 않는다.
- 신규 입력/조회/집계의 책임이 구분된다.

## Phase 4. API 계약 정리

목적:

- 새 프런트가 기대하는 계약과 기존 백엔드를 맞춘다.

작업:

1. mismatch API 수정 또는 adapter 도입
2. read/write 엔드포인트 명명 정리
3. 배치성 action API 권한 재검토
4. 사용자/권한/공통 마스터 API 정리

우선 검토 대상:

1. 품질 화면이 기대하는 part 검색/생성 API
2. ECO 관련 중복 경로
3. 재고 영역의 직접 fetch 호출
4. 공개 또는 과도하게 넓은 접근 경로

완료 기준:

- 프런트에서 우회 로직 없이 계약을 소비할 수 있다.
- 403/404/형태 불일치가 줄어든다.

## Phase 5. DB와 마스터 데이터 정리

목적:

- 백엔드 내부 구조를 정리해서 장기 유지보수성을 확보한다.

작업:

1. 공통 품목 마스터 기준 정리
2. 중복 코드/명칭 정리
3. business date와 timezone 기준 확정
4. 파생 데이터와 원천 데이터 구분
5. 필요한 migration 설계

완료 기준:

- 프런트와 AI가 같은 기준 데이터 용어를 사용한다.
- 신규 화면이 레거시 테이블 예외처리에 덜 묶인다.

주의:

이 단계는 프런트 완료 후만 가능한 것이 아니다.
Phase 2~4와 병행하되, 운영 데이터 migration은 별도 검증 후 진행해야 한다.

## Phase 6. AI 읽기 계층 준비

목적:

- Mac Studio 기반 AI 서비스를 붙일 수 있는 안전한 데이터 계약을 만든다.

작업:

1. AI 전용 read API 설계
2. 문서/SOP/ECO/품질 보고 데이터 수집 경로 정리
3. 권한 태깅
4. 요약/검색용 view 또는 snapshot 정의

완료 기준:

- AI가 운영 DB를 직접 흔들지 않고 읽기만 할 수 있다.
- 사람 화면과 AI 화면이 같은 business date와 마스터 기준을 공유한다.

## Phase 7. 분석 저장 계층과 예외 화면

목적:

- 화면별 계산을 줄이고, 운영 대시보드/AI/분석 화면이 같은 mart를 읽게 한다.

작업:

1. canonical production analytics service 정의
2. `raw -> fact -> mart` 분석 계층 추가
3. 생산 진행, 설비 신호, 재고, 품질, 예외 mart 생성
4. `/analysis`를 Overview, Exceptions, Production, Inventory Risk, Quality, AI Evidence 탭으로 확장
5. mart freshness, source trace, DQ warning을 API와 화면에 노출

선행 기준:

- [docs/rebuild/20-analytics-storage-visualization-design.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/20-analytics-storage-visualization-design.md:1)

완료 기준:

- `/production`, `/analysis`, AI 브리핑이 같은 기준 지표를 사용한다.
- 지연, plan-only, MES-only, 재고 급변, 품질 NG 같은 예외가 통합 목록으로 조회된다.
- 분석용 history가 운영 cleanup 정책 때문에 사라지지 않는다.

## Phase 8. 가공 MES 우선 수기 보정과 대사

목적:

- 가공 실적은 MES를 기본 원장으로 두되, 작업지시 또는 물류 미등록으로 MES `报工`가 누락된 선진행 생산을 수기로 보정한다.
- 나중에 MES 보고가 들어오면 수기 보정과 대사해서 이중 계상하지 않는다.

작업:

1. 가공 수기 보정 모델과 불량 상세 모델 추가
2. 수기 보정과 MES 보고 매칭 모델 및 대사 command 추가
3. `T~T+2` 계획 provision API 추가
4. `MES 수량 + 미대사 수기 잔량` 기준의 canonical machining actual service 정의
5. 생산대시보드 안에 가공 provision/수기 보정/대사 큐 UI 추가
6. `/production`, `/analysis`, AI 브리핑이 같은 보정 후 실적을 읽게 정리

선행 기준:

- [docs/rebuild/21-machining-mes-first-manual-reconciliation.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/21-machining-mes-first-manual-reconciliation.md:1)

완료 기준:

- 수기 100 입력 후 MES 100이 후등록되어도 최종 실적은 100으로 유지된다.
- 수기와 MES가 부분 매칭되면 미대사 잔량만 수기 실적으로 남는다.
- 선진행 생산은 생산대시보드에서 실제 생산 업무일과 원래 계획일 양쪽 기준으로 조회된다.
- 수기 보정 불량 유형/수량이 분석 화면에서 집계된다.

## 4. 프런트 시작 가능 시점 판단

프런트는 아래 둘로 나눠서 보면 된다.

### 지금 바로 시작 가능한 것

1. 새 앱 셸
2. 라우팅 구조
3. 권한 가드 뼈대
4. 공통 UI/테이블/필터
5. API client 정리
6. `analysis`, `production`, `inventory` 계열 조회 화면

### 잠깐 더 정하고 들어가는 것이 좋은 것

1. 혼합 입력 화면의 최종 분해 구조
2. capability 기반 메뉴/권한 상세 규칙
3. 품목/모델/업무일 기준 필드 정의
4. mismatch API에 묶인 품질/가공 보조 기능

즉 프런트는 "지금 바로 시작 가능"하지만, "모든 화면을 동시에 만들기 시작하는 것"은 아직 이르다.

## 5. 추천 착수 순서

가장 현실적인 순서는 아래와 같다.

1. 새 프런트 리포지토리 또는 새 앱 디렉터리 준비
2. 앱 셸, 라우터, auth, shared API 계층 구축
3. `/analysis`, `/production`, `/sales/inventory` 먼저 이관
4. `/sales/daily-report`, `/production/plan` 이관
5. `/injection`, `/assembly`, `/quality` 분해 설계 후 구현
6. API mismatch 정리
7. DB 정리와 AI read layer 준비
8. 분석 저장 계층과 예외 중심 `/analysis` 확장
9. 생산대시보드에 가공 MES 우선 수기 보정과 대사 UI 확장

## 6. 6주 예시 일정

예시일 뿐이며, 실제 일정은 인력과 운영 상황에 따라 조정해야 한다.

### 1주차

- 문서 보강
- 새 프런트 구조 생성
- auth/shared/app 골격 구축

### 2주차

- 공통 레이아웃
- 공통 테이블/필터
- API 계층 정리

### 3주차

- `analysis`
- `production`

### 4주차

- `sales/inventory`
- `sales/daily-report`

### 5주차

- `production/plan`
- 권한 노출 규칙 보정

### 6주차

- `injection`, `assembly`, `quality` 분해 설계
- 다음 구현 스프린트 준비

## 7. 지금 당장 시작할 첫 작업

지금 바로 한 가지를 고른다면 아래가 가장 좋다.

1. 새 프런트 폴더 구조 생성
2. `app`, `auth`, `shared/api` 뼈대 작성
3. `/analysis` 또는 `/production` 한 화면을 새 구조로 먼저 옮겨보기

이렇게 시작하면 구조 검증과 팀 학습이 동시에 된다.
