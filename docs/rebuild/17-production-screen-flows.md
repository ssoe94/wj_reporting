# 생산 화면 흐름

## 1. 목적

이 문서는 생산 운영 프로세스와 데이터 계약을 실제 화면 흐름으로 연결한다.

목표는 아래와 같다.

1. 생산관리, 사출, 가공, 관리자 입장에서 어떤 화면을 어떤 순서로 쓰는지 정한다.
2. 각 화면의 핵심 섹션과 액션을 정리한다.
3. 새 프런트에서 어떤 화면부터 구현할지 우선순위를 분명히 한다.

기준 문서:

- [docs/rebuild/14-production-operations-process.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/14-production-operations-process.md:1)
- [docs/rebuild/15-production-data-contract.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/15-production-data-contract.md:1)
- [docs/rebuild/16-injection-issue-requirements.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/16-injection-issue-requirements.md:1)
- [frontend/src/pages/production/Plan.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/production/Plan.tsx:1)
- [frontend/src/components/production/ProductionConsole.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/components/production/ProductionConsole.tsx:1)
- [frontend/src/pages/injection/MonitoringPage.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/injection/MonitoringPage.tsx:1)

## 2. 최상위 흐름

생산 관련 화면의 전체 흐름은 아래와 같이 본다.

1. 생산관리 담당자: 계획 업로드
2. 생산관리/현장: 날짜별 계획 확인
3. 사출/가공 담당자: 자기 설비 또는 라인 계획 확인
4. 담당자: 생산 중 상태 갱신
5. 담당자: 생산 결과 입력
6. 사출 담당자: 모니터링 이상 구간 확인
7. 사출 담당자: 이슈 등록
8. 관리자/분석 사용자: 계획 대비 결과와 이슈 분석

## 3. 권장 라우트 구조

생산 관련 화면은 아래 구조를 권장한다.

```text
/production/dashboard
/production/plans
/production/plans/:date
/production/executions
/production/executions/:planType
/injection/monitoring
/injection/issues
/injection/issues/:id
```

초기에는 기존 라우트를 유지하더라도, 새 프런트에서는 위와 같은 역할 분리가 드러나는 구조가 좋다.

## 4. 사용자별 대표 시나리오

## 4.1 생산관리 담당자 시나리오

1. `/production/plans` 진입
2. 엑셀 업로드
3. 업로드 결과 확인
4. 오늘 또는 선택 날짜 계획 열람
5. 잘못된 row 수정
6. 계획 요약 확인
7. 각 부문에 전달

## 4.2 사출 담당자 시나리오

1. `/production/executions/injection` 또는 사출 전용 진입 화면 진입
2. 오늘 내 설비 계획 확인
3. 작업 시작 시 상태를 `running`으로 변경
4. 생산 중 실적 또는 비고 보정
5. `/injection/monitoring`에서 생산 추이 확인
6. 이상 구간 발생 시 이슈 등록
7. 작업 완료 후 실적 확정

## 4.3 가공 담당자 시나리오

1. `/production/executions/machining` 진입
2. 내 라인 계획 확인
3. 작업 시작/완료 상태 갱신
4. 실제수량, 불량수량, 비가동시간 입력
5. 비고 또는 이슈 기록

## 4.4 관리자 시나리오

1. `/production/dashboard` 진입
2. 계획 대비 달성률 확인
3. 지연 설비 확인
4. `/injection/monitoring` 또는 `/injection/issues`로 drill-down
5. 특정 이슈의 빈도와 영향 분석

## 5. 화면별 정의

## 5.1 생산 계획 업로드 화면

권장 화면:

- `/production/plans`

현재 참고:

- [frontend/src/pages/production/Plan.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/production/Plan.tsx:1)

주요 사용자:

- 생산관리 담당자

핵심 목적:

- 생산 계획 파일 업로드
- 날짜별 계획 조회
- 계획 수정

필수 섹션:

1. 날짜 선택
2. 공정 선택
3. 파일 업로드 카드
4. 업로드 결과 메시지
5. 설비별 계획 그래프
6. 계획 상세 리스트/테이블

핵심 액션:

- 파일 업로드
- 날짜 전환
- 설비/모델 기준 보기 전환
- row 수정
- cavity 수정
- 신규 row 추가
- row 삭제

상태:

- 빈 상태
- 업로드 중
- 업로드 성공
- 업로드 경고 있음
- 업로드 실패
- 조회 결과 없음

권장 보조 정보:

- 업로드한 사용자
- 업로드 시각
- 생성/수정된 row 수
- 경고 row 수

## 5.2 생산 계획 상세 화면

권장 화면:

- `/production/plans/:date`

목적:

- 특정 날짜의 계획을 전체 공정 기준으로 상세 확인

필수 섹션:

1. 상단 요약 카드
2. 사출 계획 요약
3. 가공 계획 요약
4. 설비별 작업 순서
5. 모델별 계획 합계

권장 액션:

- 날짜 이동
- 공정 탭 전환
- 설비별 필터
- 인쇄 또는 내보내기

이 화면은 read-heavy라서 새 프런트에서 비교적 먼저 구현하기 좋다.

## 5.3 생산 실행 콘솔

권장 화면:

- `/production/executions/:planType`

현재 참고:

- [frontend/src/components/production/ProductionConsole.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/components/production/ProductionConsole.tsx:1)

주요 사용자:

- 사출 담당자
- 가공 담당자
- 관리자

핵심 목적:

- 계획 기준으로 실행 상태와 실적을 입력/관리

필수 섹션:

1. 날짜 선택
2. 공정 선택
3. 상단 상태 요약 카드
4. 설비/라인별 작업 테이블
5. 선택 작업 상세 편집 패널

권장 컬럼:

- 설비
- 순번
- Part No
- 모델
- 계획수량
- 실제수량
- 불량수량
- 비가동시간
- 상태
- CT

권장 상세 편집 항목:

- 실제수량
- 불량수량
- 비가동시간
- 인원수
- 실제 CT
- 시작/종료 시각
- 비고
- 상태

핵심 액션:

- 상태 전환
- 실적 저장
- 다음 작업으로 이동
- 설비별 필터

중요한 UX 원칙:

- 실행 콘솔은 "계획 없는 입력"을 허용하지 않는다.
- 한 row는 곧 한 계획 작업이어야 한다.

## 5.4 생산 대시보드

권장 화면:

- `/production/dashboard`

주요 사용자:

- 생산관리
- 관리자

핵심 목적:

- 오늘 계획 대비 현재 진행 상태를 한눈에 보여줌

필수 섹션:

1. 전체 계획 대비 실적 카드
2. 사출/가공 공정별 진행 요약
3. 지연 설비 리스트
4. 누락/미입력 작업 리스트
5. 이슈 발생 설비 요약

권장 드릴다운:

- 지연 설비 클릭 -> 실행 콘솔
- 이슈 설비 클릭 -> 모니터링 또는 이슈 목록

이 화면은 read-heavy이고, 새 프런트에서 우선 구현하기 좋은 대상이다.

## 5.5 사출 모니터링 화면

권장 화면:

- `/injection/monitoring`

현재 참고:

- [frontend/src/pages/injection/MonitoringPage.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/injection/MonitoringPage.tsx:1)

주요 사용자:

- 사출 담당자
- 관리자

핵심 목적:

- 설비별 시간대 생산 추이와 이상 구간 확인

필수 섹션:

1. 기간/interval 전환
2. 최신 스냅샷 갱신 상태
3. 설비별 생산 매트릭스
4. 시간대별 요약 차트
5. 선택 slot 상세 정보
6. 경고/이슈 후보 영역

필수 지표:

- slot별 생산량(delta)
- 누적 생산량
- 추정 CT
- 목표 CT
- 기준 CT
- 온도
- 전력

강조 규칙:

- 목표 대비 양호
- 주의
- 급감
- 정지

핵심 액션:

- slot 클릭
- 설비 drill-down
- 최신 데이터 갱신
- 이슈 등록

중요한 UX 원칙:

- 모니터링 화면은 계산 근거를 숨기지 않는다.
- 경고는 색만 바꾸는 게 아니라 이유를 보여줘야 한다.

예:

- `목표 대비 62%`
- `20분 무생산`
- `추정 CT 58초, 목표 CT 38초`

## 5.6 사출 이슈 등록 모달

권장 진입:

- `/injection/monitoring`에서 slot 클릭 후 모달 오픈

핵심 목적:

- 이상 구간에 대해 담당자가 사유와 조치를 기록

자동 채움 항목:

- 설비
- 날짜
- 작업 정보
- slot 시작 시각
- delta 생산량
- baseline
- 추정 CT
- 감지 유형

수동 입력 항목:

- 이슈 유형
- 상세 사유
- 조치 내용
- 종료 시각
- 상태

핵심 액션:

- 저장
- 임시 보류
- 경고 무시 또는 dismissed 처리

모달 저장 후 기대 동작:

- 해당 slot에 이슈 연결 표시
- 이슈 목록에 신규 row 반영

## 5.7 사출 이슈 목록 화면

권장 화면:

- `/injection/issues`

주요 사용자:

- 사출 담당자
- 관리자

핵심 목적:

- 이슈 히스토리 조회와 후속 추적

필수 섹션:

1. 날짜 필터
2. 설비 필터
3. 이슈 유형 필터
4. 상태 필터
5. 목록 테이블
6. 상세 패널

권장 컬럼:

- 발생 시각
- 종료 시각
- 설비
- Part No
- 유형
- 감지값
- 상태
- 등록자

핵심 액션:

- 이슈 열람
- 상태 변경
- 상세 수정

## 6. 화면 간 연결 규칙

## 6.1 계획 -> 실행

- 계획 화면에서 특정 설비/작업을 클릭하면 실행 콘솔로 이동 가능해야 한다.
- 이동 시 날짜와 공정이 자동으로 맞춰져야 한다.

## 6.2 실행 -> 모니터링

- 사출 실행 콘솔 row에서 모니터링 화면으로 점프 가능해야 한다.
- 설비와 날짜가 자동 전달되어야 한다.

## 6.3 모니터링 -> 이슈

- 경고 slot 클릭 시 이슈 등록 모달 또는 상세로 이동

## 6.4 이슈 -> 실행/계획

- 이슈 상세에서 원래 계획 작업과 실행 row를 다시 열 수 있어야 한다.

## 7. 권장 화면 상태 전이

## 7.1 계획 화면

- `empty`
- `uploading`
- `uploaded`
- `warning`
- `error`

## 7.2 실행 콘솔

- `pending`
- `running`
- `paused`
- `completed`

장기 확장:

- `acknowledged`
- `closed`

## 7.3 이슈 상태

- `open`
- `investigating`
- `resolved`
- `closed`
- `dismissed`

## 8. 모바일/현장 고려사항

현장 화면은 데스크톱과 다르게 봐야 한다.

원칙:

1. 테이블보다 카드/리스트 우선
2. 숫자 입력은 큰 필드로
3. 상태 전환 버튼은 즉시 누를 수 있게
4. 모니터링 경고는 큰 색 대비와 짧은 문장으로

특히 사출 이슈 입력은 모바일/태블릿에서도 30초 안에 기록 가능해야 한다.

## 9. 우선 구현 순서

1. 생산 대시보드
2. 생산 계획 화면
3. 생산 실행 콘솔
4. 사출 모니터링 화면 개선
5. 사출 이슈 등록 모달
6. 사출 이슈 목록 화면

이 순서가 좋은 이유:

- 계획/실행의 기준 흐름을 먼저 고정할 수 있다.
- 사출 이슈 기능이 뒤늦게 붙어도 앞 단계와 잘 연결된다.

## 10. 백로그 연결

이 문서는 아래 작업과 직접 연결된다.

- `FE-102`
  - 생산 대시보드 이관
- `FE-106`
  - 생산 계획 화면 이관
- `FE-201`
  - 사출 화면 분해안
- `API-001`
  - 생산 계획 API 계약 재확인
- `API-003`
  - 사출 read/write 계약 점검

추가로 아래 작업을 신규 백로그로 만들어도 좋다.

- `FE-107`
  - 생산 실행 콘솔 새 구조 이관
- `FE-207`
  - 사출 이슈 등록 모달 구현
- `API-008`
  - 사출 slot 요약 API 정의
- `API-009`
  - 사출 이슈 CRUD API 정의

## 11. 이 문서의 핵심 결론

1. 생산 화면은 계획 -> 실행 -> 모니터링 -> 이슈의 흐름으로 이어져야 한다.
2. 사출 모니터링은 단순 차트가 아니라 이슈 등록의 진입점이 되어야 한다.
3. 실행 콘솔은 계획 작업을 기준으로 상태와 실적을 관리하는 화면이어야 한다.
