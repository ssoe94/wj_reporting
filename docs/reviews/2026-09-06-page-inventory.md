# 페이지·대시보드 정적 검토 — 2026-09-06

검토 기준: `wj_reporting-dashboard-review` 체크아웃. 브라우저 화면과 운영 데이터 수량 검증은 상위 검토 문서에 별도 기록한다. 이 문서는 라우트·API·계산·빈 상태 코드 검토이며, 운영 사용 빈도나 DB 공백을 입증하지 않는다. `frontend`, `backend`에서 page-view/일반 분석 SDK 계측을 찾지 못했으므로 어떤 기능도 “아무도 사용하지 않는다”고 분류하지 않았다. 오류, 수집 지연, 선택 기간 공백, 실제 0, 과거 UI 잔재를 구별해야 한다.

## 결론

첫 화면 `/analysis`는 MES 실시간 종합 현황이 아니라 과거 사출·가공 보고서 기반 분석이다. 반면 `/production`, `/boards/overview`, 품질 일일주의, 재고·전력 화면에는 이미 더 풍부한 원천과 연결이 구현되어 있다. 새로운 차트를 늘리기 전에 **홈의 역할 변경, API 실패와 0의 구분, 기간 집계의 완전성, 현재 데이터로 가능한 조치 목록**을 먼저 정리하는 편이 효과적이다.

“대시보드” 명칭도 역할과 맞지 않는 경우가 있다. `/injection/dashboard`는 작업 입력·기록·C/T 설정이고 `/assembly/dashboard`는 가공 실적 입력이다. 읽는 사람에게는 `사출 작업 관리`, `가공 작업 관리`처럼 구체적인 이름이 더 정확하다.

## 실제 라우트와 화면 인벤토리

| 화면/경로 | 연결된 데이터 또는 역할 | 권장 배치 |
|---|---|---|
| `/analysis` | `OEEDashboard` + `DowntimeAnalysis` + `AssemblyDashboard`. `/injection/reports/`, `/assembly/reports/` 사용. MES 대시보드와 다른 자료 | 경영 홈을 마련한 뒤 `기간 분석 > 생산 보고 분석`으로 이동. 기록을 삭제할 이유는 없음 |
| `/production` | 계획 요약·생산상태·사출 MES matrix·가공 MES 통계/임시보고·정지확인·무계획활동확인·결정적 AI 브리핑 | 실무진 `오늘의 운영` 중심 화면. 경영 요약의 결정적 원천 재사용 |
| `/production/plan` | 계획 조회/업로드/행 수정/이력/Part Cavity 관리 | 실무 `계획·실행` |
| `/production/stats` | 계획과 MES 보고 비교. `matched`, `plan_only`, `mes_only` 상태·수량 차이·최근 보고시간 | 실무 `실적 대사`로 명확하게 표시. 경영 홈에는 불일치 건수와 영향만 |
| `/injection/dashboard#console` | `ProductionConsole(planType=injection)`; 계획·실적·불량·C/T·메모 입력 | `사출 작업 관리` |
| `/injection/dashboard#records` | 사출 수기보고 요약·날짜별 목록·CSV·등록 | 사출 작업 관리 내부 탭 |
| `/injection/dashboard#cycle-time` | `/injection/setup/dashboard/` 기반 설비 C/T 설정/테스트/이력 | 사출 작업 관리 내부 탭 |
| `/mes/monitoring` | MES 생산 matrix·가동/전력 데이터·정지 전환 후보 | 실무 `설비 모니터링`의 상세 분석. 경영 홈에서 직접 긴 차트를 반복하지 않음 |
| `/assembly/dashboard` | `ProductionConsole(planType=machining)` | `가공 작업 관리` |
| `/assembly#top`, `#records`, `#new` | 가공 수기보고 요약/기록/입력 | 가공 작업 관리 탭으로 묶기. 4개의 나란한 가공 메뉴를 1개 진입점으로 축소 후보 |
| `/quality/daily-attention` | `/quality/daily-attention/`; 생산 연결 품질 주의와 근거·분류·비교 신뢰도 | 경영 `오늘의 품질 위험` 요약 + 실무 근거/처리 목록 |
| `/quality#report`, `#stats`, `#review` | 보고 등록·Excel 업로드·전체 보고 이력·AI 분류 검토. `#stats`는 실제로 이력 화면 | `품질 업무` 탭. 메뉴 `품질 통계` 명칭을 `품질 보고 이력`으로 수정 후보 |
| `/sales/daily-report` | `/inventory/daily-report/`, `/summary/`; 완제품/반제품 재고 스냅샷과 QC 상태 | `재고 일보`; 판매/수익 지표로 오인하지 않게 명명 |
| `/sales/inventory-status` | `/inventory/`; 창고/품목/LOT 재고, 새로고침 상태 | 실무 `재고·물류` |
| `/sales/raw-materials` | 원자재 overview/details/sync API | 실무 `재고·물류`. 경영에는 재고 위험만 상향 |
| `/eco2`, `/models` | ECO 관리와 품목 사양 | `기준정보·변경 관리` |
| `/development/field-materials` | 현장 자료 및 생산 일정·자료 준비도 | 실무 `현장 자료`. 금일 계획 중 자료 부족 작업을 운영 조치 목록에 연결 |
| `/boards` | 5개 큰 화면/현장 보드 런처 | 현황판 전용 진입점 유지; 일반 대시보드와 목적 구분 |
| `/boards/overview` | `/production/overview-board/`; 생산·품질·재고·금형·전력·source freshness 종합 응답 | 경영 홈의 읽기 전용 원천 후보. 3×3 벽면용 UI 그대로 데스크톱 홈으로 쓰기보다는 동일 API에서 중요 항목만 표시 |
| `/boards/injection` | 사출 계획·MES·C/T 전용 큰 화면 | 현장 보드 유지 |
| `/boards/moulds` | `/injection/moulds/board/` + 생산활동 연결·검증 규칙·금형 상세 | 설비/금형 상태 및 연결 이상 조치에 활용 |
| `/boards/energy` | MES production matrix 1시간 bucket 전력 + monitoring-dates freshness | `에너지` 상세 유지. 경영에는 전일 동시간 비교와 유효 관측 범위를 함께 표시 |
| `/field`, `/field/:stationId` | 현장 설비 선택·작업지도서/도면/품질Issue·실적 입력 | 현장 터미널 경험 유지 |
| `/admin/user-management` | 사용자 승인·권한 관리 | 관리 영역 유지 |

주요 근거: `frontend/src/App.tsx:104` 홈 경로, `:124` 메뉴, `:774` 라우트; `pages/analysis/index.tsx:72`; `pages/injection/Dashboard.tsx:34`; `pages/assembly/Dashboard.tsx:9`; `pages/quality/index.tsx:23`, `:149`; `domains/boards/pages/BoardHubPage.tsx:97`.

## 중요 코드 발견

### P0 — 생산 원천 API 실패 후 0과 완료된 브리핑을 보여줄 수 있음

`ProductionDashboardPage.tsx:3002`는 계획 요약/MES/가공통계 세 개가 있어야 core ready로 본다. 그러나 `:3964`의 초기 로딩 조건은 요청 중인 동안만 참이다. 초기 요청이 최종 실패하면 로딩이 끝나고 `:5276` 이하 카드가 렌더링된다. `:2416`, `:2436`, `:2465`의 빈 원천 기본값 때문에 `0 / 0`, `0샷 / 0대` 등으로 보일 수 있다. 같은 영역의 브리핑은 `:5378`에서 “결정적 답변 준비” 상태를 고정 표시한다. core query의 실패를 설명하는 분기는 없다.

작은 수정 후보 1: 핵심 원천 중 초기 실패가 있으면 영향 원천과 재시도 버튼을 표시하고 수치/결론 영역을 가린다. 이전 성공 데이터가 있는 재조회 실패는 값과 마지막 성공 시각을 유지하되 오래된 데이터임을 표시한다. AI 설명 API만 실패한 경우에는 기존 결정적 화면 브리핑 fallback을 유지한다. 원천 실패와 AI 설명 실패를 같은 상태로 처리하면 안 된다.

### P1 — 기본 홈과 실제 수집 데이터 사이 단절

`App.tsx:106`은 일반 사용자의 홈을 `/analysis`로 보낸다. `OEEDashboard.tsx:44`, `DowntimeAnalysis.tsx:76`는 `/injection/reports/`만 조회한다. `useReports.ts:78`은 모든 페이지를 가져온 뒤 클라이언트에서 기간을 필터링하므로 자료가 늘수록 홈 진입 비용도 커진다. 두 컴포넌트 모두 query error를 읽지 않아 실패가 빈 상태로 섞인다(`OEEDashboard.tsx:312`).

`DowntimeAnalysis.tsx:125`는 보고서의 자유문장 note에서 `분/min/分钟` 정규식만 읽는다. 이미 존재하는 MES 정지 후보와 구조화된 정지 확인 API(`ProductionDashboardPage.tsx:2969`)를 활용하지 않는다. 현장 메모 방식이 바뀌면 비가동이 있어도 빈 차트가 된다. 이 차트의 0은 “확인된 정지가 없다”라는 증거가 아니다.

작은 수정 후보 2: `/analysis` 상단에 원천/관측기간을 명시하고 `오늘의 생산`, `품질 주의`, `재고`, `종합 현황판` 연결을 제공한다. 빈 분석 영역에는 “이 기간의 생산 보고서 없음”과 최신 보고일·기록 입력/실시간 화면 이동을 제공한다. 다음 단계에서 `/analysis`를 목적별 홈으로 교체하고 기존 분석은 보존한다.

### P1 — 가공 분석의 전체/기간 수치가 1페이지로 제한되고 기간 선택을 덮어씀

`components/AssemblyDashboard.tsx:130`은 `useAssemblyReports()`를 호출한 뒤 `:149`에서 `results`만 집계한다. `hooks/useAssemblyReports.ts:48`은 첫 페이지만 조회하며 다음 페이지를 따라가지 않는다. `backend/config/settings.py:177`의 기본 pagination은 100건이고 `backend/assembly/views.py:24`의 ViewSet에는 이를 끄는 설정이 없다. 100건을 넘는 환경에서 “전체 데이터” 집계가 전체가 아니다. 현재 실제 건수는 이 정적 검토만으로 알 수 없다.

또한 `AssemblyDashboard.tsx:160`에서 마지막 기록일 기준 최근 30일을 계산하고 `:170` effect가 사용자의 PeriodSelector 날짜를 다시 덮어쓴다. 필터 역시 사용자가 선택한 start/end가 아니라 강제 계산값을 사용한다(`:176`). 재구성 전 집계 API에서 기간과 관측 건수를 확정하고 사용자 날짜를 지켜야 한다. 기존 `/assembly/reports/trend-data/`는 현재 시각 기준 최근 30일 전용이므로 과거 임의 기간의 대체재가 아니다(`backend/assembly/views.py:33`).

### P1 — OEE 명칭과 실제 수식의 판단 기준을 재확정해야 함

`OEEDashboard.tsx:118`은 일별 분모를 설비 17대 × 24시간으로 고정한다. `:137`의 성능 값은 `(실적+불량)/계획수량`이며 표준 C/T를 참조하지 않는다. 미입력 시간과 휴무도 같은 분모에 들어갈 수 있고 계획이 낮으면 성능 값이 100%를 넘을 수 있다. 이 계산을 경영진의 핵심 효율 지표로 승격하기 전, 현장 예정가동시간·표준 C/T·양품/총생산 단위 및 수기 입력 커버리지를 정하고 계산 근거를 공개해야 한다. 현재 값을 일단 유지할 경우에도 실제 수식을 라벨/도움말에 명시해야 한다.

### P2 — 통계와 작업 입력의 이름/목적 혼재

`pages/injection/Dashboard.tsx:34`와 `pages/assembly/Dashboard.tsx:9`의 중심은 입력 console이다. `/quality#stats`는 `QualityReportHistory`를 표시한다(`pages/quality/index.tsx:149`). 화면의 실제 역할에 맞춘 메뉴명은 전체 레이아웃 변경 없이 혼란을 줄일 수 있다.

### P2 — 통계 페이지도 요청 전/실패 시 일부 0 KPI 표시

`pages/production/Stats.tsx:54`의 formatNumber는 undefined를 0으로 바꾸며 상단 카드 `:185`는 data/error 상태와 관계없이 렌더링된다. 아래 오류 메시지가 있어도 상단만 본 사용자는 생산 0으로 받아들일 수 있다. 성공한 0만 0으로, 미관측은 `—`로 표기하는 공통 표시 규약이 필요하다.

## 비어 보이는 원인으로 단정하면 안 되는 파일

- `pages/quality/stats.tsx`, `pages/summary/QualitySummary.tsx`, `pages/sales/Inventory.tsx`에 준비 중 placeholder가 있지만 현재 주요 라우트는 이 컴포넌트들을 사용하지 않는다. `/quality#stats`는 보고 이력, `/sales/inventory`는 재고현황 redirect다. 파일 존재만으로 “배포 화면 미완성”이라 분류하지 않는다.
- 금형 예시 데이터는 `MouldManagementPage.tsx:1540`의 개발 환경 조건에서만 활성화된다. 운영 fetch 오류를 예시 수치로 대체하는 경로가 아니다.
- 종합 보드 예시도 `domains/boards/overview/api.ts:902`에서 DEV에만 허용되고 운영에서는 오류를 throw한다. 개발 서버 화면을 운영 데이터로 오인하지 않는다.
- `/next/*`, `/overview`, `/production/plans` 등은 이전 링크 호환 redirect다. 메뉴에서 사라진 URL을 바로 제거하면 현장 북마크가 끊길 수 있다.

## 현재 자료로 바로 만들 수 있는 정보

| 질문 | 이미 연결된 원천 | 사용자에게 보여줄 결과 |
|---|---|---|
| 지금 무엇부터 확인해야 하나? | 생산 계획/MES, 무계획활동 확인, 정지 후보/확인, 가공 임시보고 | 계획 지연·미확인 무계획 가동·미확인 정지·미대사 수기실적을 설비/품번/근거시간과 함께 정렬한 조치 목록 |
| 생산 숫자를 믿어도 되나? | source freshness, 계획/MES 매칭 상태, cavity, manual_open_qty/matched_manual_qty | 정상/지연/누락/추정/미대사 구분과 영향 설비 수. 장애를 성과 저하로 해석하지 않게 함 |
| 품질 문제를 오늘 생산과 연결할 수 있나? | daily-attention, 생산계획, 품질 report history | 해당 품번의 최근 이슈·재발·근거 링크. 검사 분모가 없으면 불량률로 표시하지 않음 |
| 내일 생산 준비가 됐나? | 익일/익익일 생산계획, field-materials 준비도, 금형 장착/보관 연결 | 계획 작업별 자료/금형 정보 부족 목록. 재고와 연결하려면 확정 품번·단위·소요량 매핑 필요 |
| 전력이 늘어난 이유가 생산량인가 공회전인가? | energy matrix + shot matrix + 설비 가동시간 | 동일 관측시간의 kWh/shot과 무생산 시간 전력. 품목/금형 mix를 통제하지 않은 설비 간 효율 순위는 피함 |

## 추가 수집 우선순위

1. **source 상태와 데이터 완전성**: source별 last-success/source-latest timestamp, expected/received 설비·시간 bucket 수, 실패 유형, 계획·Part No·Cavity 누락 수. 모든 KPI에 동일 관측범위·부분수집 표시를 먼저 적용한다.
2. **현장 확인과 조치 추적**: 기존 정지/무계획활동 확인에 담당·처리기한·상태·원인·조치·확인 시각을 연결. “주의가 많음”을 “누가 무엇을 해결했고 재발했는가”로 바꾼다. 지금 API에 있는 필드와 추가가 필요한 필드는 백엔드 검토 후 구분한다.
3. **실제 작업 이력·예정가동시간**: 설비/작업지시/품번/금형·Cavity 유효기간, 실제 시작/종료, 교대·휴무·계획정지, 표준 C/T 버전. 현재 MES shots×Cavity 추정과 계획 순서 배분의 확정 여부를 비교할 수 있어야 한다.
4. **양품/검사/재작업의 분모**: 작업지시·LOT별 총생산·양품·검사수량·폐기·재작업, 불량유형과 책임공정, 검출공정, 발생/등록 시각. 품질 이슈 보고 “건수”와 생산 “수량”을 직접 나누지 않는다.
5. **납기와 비용**: 고객 주문/납기/수량, 출고 실적·부분출고, 품목별 원자재 소요량·단위 환산, 표준원가/폐기비/가공단가. 확보되면 지연 설비 순위가 납기 위험과 손실금액 우선순위가 된다.
6. **최소 사용 계측**: route, 역할 그룹, 필터 기간, 조회 성공/실패/빈 상태, 상세 열기·내보내기·조치 완료 이벤트. 개인 입력문/LOT 등 업무 본문을 수집할 필요는 없다. 2~4주 관측 후 메뉴 폐지·병합을 판단한다.

## 단계별 정보 구조 제안

- 경영진 기본 화면: `금일 운영 요약`(관측 기준/갱신 상태 → 생산 진도·품질 주의·재고/에너지 예외 → 영향 큰 조치 5건 → 7/30일 추세). 원천이 없는 납기·원가 카드는 빈 그래프로 배치하지 말고 지표 도입 백로그로 관리한다.
- 실무진 기본 화면: `오늘의 운영`(생산 대시보드) → `계획·실행`(사출/가공 입력과 실적 대사) → `품질` → `재고·물류` → `설비·금형` → `기준정보`. 기존 주소와 권한은 유지하고 메뉴 진입점만 먼저 정리한다.
- 현장: `현장 칸반`과 `대형 현황판`은 별도 목적을 유지한다. 관리용 화면 기능을 공개 보드에 무조건 추가하지 않는다.

## 이번 검토의 변경과 검증

- 변경: 이 검토 문서만 추가. 앱 코드·배포·DB·자격증명 변경 없음.
- 명령: `rg --files`, `rg -n`, `nl -ba ... | sed -n ...`, `git status --short`; `AGENTS.md`와 라우트/컴포넌트/훅/관련 백엔드 pagination 코드를 읽음.
- 완료: 활성 화면 인벤토리, 빈 화면과 지표 오해의 코드 원인, 메뉴 구조/수집/소규모 수정 제안.
- 남은 위험: 실제 운영 수량·권한별 화면·API 지연/공백은 정적 검토로 확인 불가. 배포 SHA 확인 결과는 별도 인계 문서에 기록했다. 사용량 계측은 발견하지 못했으나 별도 외부 계측 존재 여부는 미확인.
- 추천 다음 작업: 원천 실패 표시 수정 → 홈에 데이터 상태/업무 연결 제공 → 가공 집계 범위·기간 선택 보정 → 수집된 자료를 기준으로 경영 홈의 조치/추세 구성.
