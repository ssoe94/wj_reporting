# 프런트엔드 모듈 경계

## 1. 목적

이 문서는 새 프런트엔드를 재구축할 때 어떤 단위로 모듈을 나눌지 정의한다.

목표는 아래와 같다.

1. 화면, 컴포넌트, 훅, API 호출 코드가 다시 뒤섞이지 않게 한다.
2. 도메인 책임과 공통 책임을 분리한다.
3. 기존 코드에서 무엇을 재사용하고 무엇을 분리할지 기준을 만든다.

기준 파일:

- [frontend/src/App.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/App.tsx:1)
- [frontend/src/contexts/AuthContext.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/contexts/AuthContext.tsx:1)
- [frontend/src/lib/api.ts](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/lib/api.ts:1)
- [docs/rebuild/04-screen-inventory.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/04-screen-inventory.md:1)
- [docs/rebuild/07-screen-to-api-map.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/07-screen-to-api-map.md:1)
- [docs/rebuild/08-permissions-matrix.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/08-permissions-matrix.md:1)

## 2. 현재 구조에서 보이는 문제

현재 프런트는 동작은 하지만 아래 특징이 섞여 있다.

- 라우트 정의, 네비게이션, 레이아웃, 권한 판단이 `App.tsx`에 크게 모여 있다.
- `pages/*` 아래에서 화면 조합과 도메인 로직이 함께 섞여 있다.
- 일부 화면은 `api.ts`를 통하지 않고 직접 `fetch('/api/...')`를 사용한다.
- `summary`, `assembly`, `quality` 같은 혼합 화면이 하나의 페이지 안에서 조회/입력/집계를 모두 담당한다.
- 재사용 컴포넌트와 도메인 전용 컴포넌트의 경계가 아직 뚜렷하지 않다.

재구축에서는 이 문제를 "파일 정리"가 아니라 "책임 정리"로 풀어야 한다.

## 3. 권장 최상위 모듈

권장 최상위 모듈은 아래와 같다.

| 모듈 | 책임 | 포함 대상 | 제외 대상 |
| --- | --- | --- | --- |
| `app` | 앱 부트스트랩, 라우팅, 전역 providers | router, app shell, error boundary | 도메인별 API 세부 구현 |
| `auth` | 로그인, 세션, 사용자 정보, 권한 해석 | login page, auth hooks, session state | 도메인 비즈니스 로직 |
| `shared` | UI, 유틸, 공통 테이블/폼/필터, 공통 API 클라이언트 | buttons, dialogs, date utils, query helpers | 특정 도메인 전용 규칙 |
| `analysis` | 종합 분석 대시보드 | `/analysis` 관련 집계 화면 | 운영 입력 폼 |
| `production` | 생산 대시보드, 계획, 실적 | `/production*` 화면 | 품질/재고 전용 로직 |
| `injection` | 사출 기록, 셋업, 모니터링 | `/injection*` 화면 | 타 도메인 공용 마스터 |
| `assembly` | 가공/조립 기록과 조회 | `/assembly*` 화면 | 품질 입력 보조 로직의 직접 소유 |
| `quality` | 품질 보고, 품질 히스토리, 일일 주의 | `/quality*` 화면 | 생산 계획 자체 관리 |
| `inventory` | 재고 조회, 일일 보고, 상태/스냅샷 | `/sales/*` 중 재고 관련 화면 | 생산/품질 도메인 규칙 |
| `eco` | ECO 관리와 개발성 데이터 관리 | `/eco2`, `/models` 관련 | 운영 집계 대시보드 |
| `admin` | 사용자 승인, 권한 관리 | `/admin/*` | 일반 운영 화면 |
| `field` | 현장 단말 전용 UX | `/field*` | 일반 데스크톱 내비게이션 |

## 4. 권장 디렉터리 구조 초안

```text
frontend/src/
  app/
    router/
    providers/
    layout/
  domains/
    auth/
    analysis/
    production/
    injection/
    assembly/
    quality/
    inventory/
    eco/
    admin/
    field/
  shared/
    api/
    ui/
    table/
    form/
    filters/
    hooks/
    utils/
    types/
    constants/
```

핵심 원칙:

- `domains/*`는 업무 도메인 책임을 가진다.
- `shared/*`는 어떤 도메인에서도 재사용 가능한 것만 둔다.
- `app/*`는 앱 전체 조립과 진입 규칙만 담당한다.

## 5. 모듈별 세부 경계

## 5.1 `app`

포함:

- 라우터 선언
- 전역 레이아웃
- 사이드바/헤더/브레드크럼 구조
- 전역 provider 조립
- 전역 에러/토스트/로딩 경계

포함하지 말 것:

- 도메인별 API 함수
- 화면별 비즈니스 계산
- 권한 세부 규칙의 원본 정의

설명:

현재 `App.tsx`에 있는 내비게이션, 라우트, 레이아웃, 로딩 상태, 인증 후 redirect 일부는 이 모듈로 이동하는 것이 맞다.

## 5.2 `auth`

포함:

- 로그인 페이지
- 세션 유지
- 사용자 프로필 조회
- capability/role 해석
- `RequireAuth`, `RequireCapability` 같은 가드

포함하지 말 것:

- 도메인 메뉴 구성
- 생산/품질/재고 개별 화면 규칙

설명:

현재 `AuthContext.tsx`는 인증과 권한 판단이 함께 있다.
재구축에서는 "세션 정보 보관"과 "권한 해석"은 `auth` 안에 두되, 도메인별 메뉴 노출은 `app`이 이를 소비하는 구조가 좋다.

## 5.3 `shared`

포함:

- `ApiClient`
- query key 규칙
- 공통 테이블
- 공통 폼 컨트롤
- 날짜 선택기
- 공통 confirm/dialog
- 숫자/시간/퍼센트 포맷터
- 공통 에러 변환기

포함하지 말 것:

- `quality` 전용 defect editor
- `injection` 전용 cycle-time 계산기
- `production` 전용 plan grid

설명:

공통화 기준은 "두 개 이상의 도메인에서 의미가 유지되는가"이다.
재사용 가능해 보여도 업무 용어가 강하게 박혀 있으면 도메인 쪽에 남겨야 한다.

## 5.4 `analysis`

포함:

- 종합 대시보드 화면
- 카드/차트 조합
- 드릴다운 필터 상태
- 여러 도메인 집계의 읽기 조합

포함하지 말 것:

- 원천 데이터 수정 폼
- 배치 실행 버튼 같은 운영 액션

설명:

`analysis`는 데이터를 "입력"하는 모듈이 아니라 "해석"하는 모듈이어야 한다.

## 5.5 `production`

포함:

- 생산 대시보드
- 생산 계획 조회/업로드/편집
- 생산 통계
- 생산 계획 관련 검색 보조

포함하지 말 것:

- 사출 현장 단말
- 품질 보고 입력

설명:

생산 계획은 재고/품질/사출과 연결되지만, 화면 소유권은 `production`에 두는 것이 깔끔하다.

## 5.6 `injection`

포함:

- 사출 대시보드
- 사출 기록 목록
- 사출 입력 폼
- 셋업 관리
- 모니터링

포함하지 말 것:

- 공통 품목 마스터의 원본 정의
- 품질 보고 보조 생성 API의 우회 호출

설명:

현재 `/injection`은 혼합 화면이다.
재구축에서는 `dashboard`, `records`, `new`, `setup`, `monitoring` 책임을 나눠야 한다.

## 5.7 `assembly`

포함:

- 가공/조립 대시보드
- 가공 기록 목록
- 가공 신규 입력
- 가공 불량 히스토리 조회

포함하지 말 것:

- 품질 화면에서만 쓰는 part 보조 생성 책임

설명:

현재 품질 화면이 `assembly` 경로 하위 API를 일부 기대하고 있어 경계가 흐리다.
재구축에서는 "가공 데이터"와 "품목/부품 보조"를 분리하는 쪽이 안전하다.

## 5.8 `quality`

포함:

- 품질 보고 입력
- 품질 보고 히스토리
- 공급자 관리 보조
- 일일 주의 화면

포함하지 말 것:

- 품목 생성 우회 기능
- 생산 계획 원본 관리

설명:

품질 화면은 현재 입력과 히스토리가 한 페이지에 묶여 있다.
새 프런트에서는 `reports`, `reports/new`, `daily-attention`으로 나누는 편이 좋다.

## 5.9 `inventory`

포함:

- 현재고
- 일일 재고 보고
- 재고 상태/갱신
- 창고/통합 품목 검색

포함하지 말 것:

- 이메일 예약 정책의 직접 구현
- 다른 도메인에서 쓰는 통합 품목 관리 전반

설명:

재고 화면은 read-heavy 화면이 많아서 새 프런트의 초반 안정화 대상으로 적합하다.

## 5.10 `eco`

포함:

- ECO 관리
- 모델/품목 관리

포함하지 말 것:

- 공통 품목 마스터의 최종 canonical schema 결정

설명:

현재 `eco2`와 `models`는 개발성 관리 화면에 가깝다.
장기적으로는 `parts` 또는 `master-data` 모듈로 분화할 수도 있다.

## 5.11 `admin`

포함:

- 사용자 승인
- 권한 관리
- 비밀번호 초기화

포함하지 말 것:

- 일반 운영 모듈의 비즈니스 규칙

## 5.12 `field`

포함:

- 현장 단말 런처
- 스테이션 화면
- 전용 최소 UI

포함하지 말 것:

- 데스크톱 전용 글로벌 내비게이션

설명:

현장 단말은 같은 앱이어도 UX와 권한이 전혀 다르므로 분리된 entry flow로 유지하는 편이 좋다.

## 6. 화면/컴포넌트 배치 규칙

권장 규칙:

1. `domains/<name>/pages`
   - 라우트 진입 페이지

2. `domains/<name>/components`
   - 해당 도메인에서만 쓰는 화면 조합 컴포넌트

3. `domains/<name>/api`
   - API 함수, DTO, adapter

4. `domains/<name>/hooks`
   - query/mutation 훅

5. `domains/<name>/types`
   - 도메인 타입

6. `shared/*`
   - 진짜 공통일 때만 이동

## 7. API 계층 경계

새 프런트에서는 API 호출을 아래 3단계로 나누는 것을 권장한다.

### 7.1 transport

- axios/fetch wrapper
- token refresh
- 공통 헤더

### 7.2 domain api

- `productionApi.getPlanSummary()`
- `qualityApi.listReports()`
- `inventoryApi.getDailyReport()`

### 7.3 adapter

- 백엔드 응답을 프런트 view model로 변환
- 날짜/숫자/null 처리 정리

원칙:

- 화면에서 직접 URL 문자열을 만들지 않는다.
- `fetch('/api/...')` 직접 호출은 금지한다.
- mismatch가 있는 API는 adapter 층에서 한 번 더 감싸서 전환 비용을 낮춘다.

## 8. 지금 바로 시작 가능한 프런트 작업

아래 작업은 백엔드/DB 정리가 끝나기 전에도 바로 시작 가능하다.

1. 앱 셸과 내비게이션 구조 설계
2. 공통 레이아웃과 페이지 템플릿
3. 권한 가드 뼈대
4. 공통 테이블/필터/폼 패턴
5. API 클라이언트 계층 정리
6. `analysis`, `production`, `inventory` 같은 read-heavy 화면의 새 구조 초안

## 9. 잠깐 묶어두는 편이 좋은 프런트 작업

아래 작업은 선행 정의가 조금 더 필요하다.

1. `/injection`, `/assembly`, `/quality`의 최종 URL 구조 확정 전 상세 폼 구현
2. capability 기준이 정해지기 전 메뉴 노출 완성
3. `part_no`, `model_code`, `business_date` 기준이 고정되기 전 입력 검증 로직 완성
4. mismatch 상태 API에 강하게 결합되는 화면 상세 구현

## 10. 기존 코드에서 재사용 후보

다음은 재사용 검토 가치가 있다.

- `contexts/AuthContext.tsx`
  - 세션 처리 로직 일부
- `lib/api.ts`
  - transport 일부
- `components/ui/*`
  - 범용 UI
- `pages/production/*`
  - read-heavy 화면 구조 참고
- `hooks/useInventoryStatus.ts`
  - query 패턴 참고

단, 그대로 복사해 누적시키기보다 새 구조에 맞춰 "옮겨 담는" 방식이 좋다.

## 11. 프런트 시작 기준

새 프런트는 아래 조건이면 착수 가능하다.

1. P1 화면 범위가 정해져 있다.
2. 권장 라우트 구조 초안이 있다.
3. API 계약 문서가 있다.
4. 핵심 용어집이 있다.
5. 메뉴/권한의 최소 규칙이 있다.

현재 문서 묶음 기준으로 보면 위 조건은 대부분 충족되었다.
즉 프런트는 "지금 바로 시작 가능"한 상태로 보는 것이 맞다.

단, 시작 범위는 `기초 골격 + read-heavy 화면 + API 계층 정리`로 제한하는 것이 가장 안전하다.
