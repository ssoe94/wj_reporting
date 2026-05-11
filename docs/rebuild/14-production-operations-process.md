# 생산 운영 프로세스

## 1. 목적

이 문서는 생산 관련 데이터를 중심으로 `wj_reporting`의 목표 업무 흐름을 정리한다.

이번 문서의 초점은 아래와 같다.

1. 생산 계획이 어떻게 입력되고 배포되는지
2. 사출/가공 담당자가 계획을 어떻게 확인하고 실행하는지
3. 생산 후 어떤 결과를 어떤 기준으로 기록해야 하는지
4. 사출 모니터링 데이터를 어떻게 실적 추적과 이슈 입력으로 연결할지

이 문서는 현재 구현 상태와 사용자가 원하는 운영 흐름을 합쳐 만든 "차기 기준 프로세스" 문서다.

기준 파일:

- [backend/production/models.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/production/models.py:1)
- [backend/production/views.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/production/views.py:1)
- [backend/injection/models.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/injection/models.py:1)
- [backend/injection/views.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/injection/views.py:1)
- [frontend/src/pages/injection/MonitoringPage.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/injection/MonitoringPage.tsx:1)
- [docs/rebuild/09-data-lineage-map.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/09-data-lineage-map.md:1)
- [docs/rebuild/11-implementation-roadmap.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/11-implementation-roadmap.md:1)

## 2. 핵심 방향

가장 중요한 데이터 흐름은 아래 한 줄로 요약할 수 있다.

`생산 계획을 기준 데이터로 삼고, 각 부문은 그 계획에 대한 실행 결과와 이슈를 같은 기준 키로 기록한다.`

즉 시스템의 중심은 아래 구조가 되어야 한다.

1. 계획 입력
2. 계획 배포
3. 현장 확인
4. 생산 실행
5. 실적 자동/수동 수집
6. 이슈 기록
7. 계획 대비 분석

## 3. 현재 시스템에서 이미 있는 기반

현재 코드 기준으로는 아래 기반이 이미 있다.

### 3.1 생산 계획

- `ProductionPlan`
  - 날짜별
  - 공정별(`injection`, `machining`)
  - 설비별
  - part별
  - 계획수량 기록

### 3.2 생산 실행 기록

- `ProductionExecution`
  - `actual_qty`
  - `defect_qty`
  - `idle_time`
  - `personnel_count`
  - `operating_ct`
  - `start_datetime`
  - `end_datetime`
  - `status`
  - `note`

### 3.3 사출 실적/모니터링 데이터

- `InjectionReport`
  - 일자 기준 생산 보고
- `InjectionMonitoringRecord`
  - 시계열 `capacity`
  - 오일온도
  - 전력값
- `CycleTimeSetup`
  - 목표 CT
  - 표준 CT
  - 평균 CT
  - 인원수

즉 완전히 새로 시작하는 상태는 아니고, 현재 있는 데이터 구조 위에 "운영 프로세스와 화면 흐름"을 더 명확히 얹는 단계라고 보는 것이 맞다.

## 4. 목표 업무 흐름

## 4.1 전체 흐름

### Step 1. 생산 계획 업로드

생산관리 담당자가 엑셀로 생산 계획을 업로드한다.

입력 결과:

- 생산일자
- 공정 구분
- 설비
- 순번
- 모델
- Part No
- Lot No
- 계획수량

시스템 결과:

- `ProductionPlan` 갱신
- 날짜별/공정별 계획 목록 생성
- Part-Model 매핑 보조 정보 갱신

### Step 2. 계획 배포

업로드된 계획은 날짜별로 사출과 가공에 전달된다.

전달 대상:

- 사출 담당자
- 가공 담당자
- 생산관리/관리자

화면에서 보여줘야 할 것:

- 오늘 계획
- 설비별 작업 순서
- Part No / Model / Lot No
- 목표 수량
- 계획 순번

### Step 3. 담당자 확인

각 부문 담당자가 자기 공정의 계획을 확인한다.

이 단계에서 필요한 동작:

- 계획 확인 완료 표시
- 설비/라인별 작업 준비 상태 확인
- 계획상 누락/이상 발견 시 코멘트

권장 추가 상태:

- `uploaded`
- `acknowledged`
- `running`
- `paused`
- `completed`
- `closed`

현재 `ProductionExecution.status`는 `pending`, `running`, `completed`, `paused`가 있으므로,
"담당자 확인"은 실행 상태와 별도로 두거나 `pending` 안에 하위 의미로 둘지 결정이 필요하다.

### Step 4. 생산 실행

실제 생산이 시작되면 각 작업은 생산 계획을 기준으로 실행된다.

핵심 원칙:

- 실적은 "계획 없이 따로 생성"하는 것이 아니라
- 반드시 해당 계획 행 또는 계획 키에 연결되어야 한다

권장 기준 키:

- `plan_date`
- `plan_type`
- `machine_name`
- `part_no`
- `lot_no`
- `sequence`

이 키는 현재 `ProductionExecution`도 이미 사용하고 있다.

### Step 5. 생산 결과 기록

생산 후 또는 생산 중에 담당자가 아래 결과를 기록한다.

공통 기록 항목:

- 실제 생산수량
- 불량수량
- 비가동시간
- 투입인원
- 실제 가동 CT
- 시작/종료 시각
- 비고

가공과 사출 모두 기본 골격은 같되, 사출은 모니터링 데이터와 자동 연계가 더 강해야 한다.

### Step 6. 계획 대비 분석

생산관리나 관리자 입장에서는 아래를 바로 비교할 수 있어야 한다.

- 계획수량 대비 실제수량
- 불량률
- 설비별 진행 상태
- 중단 시간
- CT 편차
- 계획 누락 / 실적 누락

## 5. 역할별 프로세스

## 5.1 생산관리 담당자

주요 역할:

- 생산 계획 엑셀 업로드
- 계획 배포
- 계획 수정
- 당일/전일 계획 대비 실적 확인

필요 화면:

- 계획 업로드
- 계획 편집
- 계획 요약
- 계획 대비 진행 현황

## 5.2 사출 담당자

주요 역할:

- 오늘 자기 설비의 계획 확인
- 생산 중 상태 확인
- 생산 완료 후 실적 입력
- 이상 발생 시 사유 입력

필요 화면:

- 사출 계획 목록
- 사출 모니터링
- 사출 실적 입력
- 사출 이슈 입력

## 5.3 가공 담당자

주요 역할:

- 오늘 자기 라인의 계획 확인
- 생산 완료 후 실적 입력
- 불량 및 이슈 기록

필요 화면:

- 가공 계획 목록
- 가공 실적 입력
- 가공 이슈 입력

## 5.4 관리자 / 분석 사용자

주요 역할:

- 계획 대비 달성률 확인
- 설비별 병목 확인
- 중단/이슈 추적
- CT 추이 분석

필요 화면:

- 대시보드
- 생산 콘솔
- 사출 추이
- 이슈 히스토리

## 6. 사출 전용 프로세스

사출은 다른 공정보다 자동 데이터와 수동 입력을 같이 써야 한다.

핵심 원칙:

- 생산량 추이는 시스템이 자동 수집
- 왜 줄었는지, 왜 멈췄는지는 담당자가 기록

## 6.1 자동 수집 데이터

사출 모니터링에서 자동으로 수집되는 데이터:

- 시각별 생산량(`capacity`)
- 오일온도
- 전력 사용량

이 데이터는 `InjectionMonitoringRecord`에 저장된다.

## 6.2 추이 계산 방식

사출 모니터링에서 보고 싶은 것은 단순 누적치가 아니라 아래다.

1. 시간대별 실제 생산량
2. 시간대별 추정 사이클 타임
3. 목표 CT 대비 차이
4. 급감/정지 구간

권장 계산 흐름:

1. 누적 생산량 또는 시계열 생산량에서 slot별 delta 생산량 계산
2. 해당 slot의 생산수량과 cavity를 이용해 shot 수 추정
3. slot 시간 길이를 이용해 실제 CT 추정
4. 목표 CT / 표준 CT / 평균 CT와 비교

권장 추정 공식:

`estimated_ct_sec = slot_duration_sec * cavity / produced_qty`

전제:

- `produced_qty`는 해당 시간 슬롯에서 증가한 생산수량
- `cavity`는 품목별 cavity
- 생산수량이 0이면 CT는 계산하지 않고 "정지 또는 무생산"으로 본다

주의:

현재 MES/모니터링의 `capacity` 값이 누적치인지 구간값인지, 설비별로 완전히 동일한지 최종 검증은 필요하다.
따라서 실제 구현 전에는 계산 로직을 문서화하고 샘플 데이터로 검증해야 한다.

## 6.3 사출 이슈 입력 흐름

예를 들어 형합수가 시간당 80씩 나오다가 갑자기 줄거나 멈추면,
사출 담당자가 그 이유를 기록하게 하고 싶다는 요구는 아래 흐름으로 정리할 수 있다.

### 자동 감지 조건 예시

아래 중 하나라도 만족하면 이슈 입력 후보로 본다.

1. 직전 평균 대비 생산량이 급감
2. 목표 대비 생산량이 일정 비율 이하
3. 연속 N개 slot에서 생산량 0
4. 추정 CT가 기준 CT보다 크게 악화

권장 초기 규칙 예시:

- `delta_qty = 0` 이 2개 slot 연속 발생
- `actual_vs_target_ratio < 0.7`
- `estimated_ct_sec > target_ct_sec * 1.2`

### 담당자 입력 항목

자동 감지 후 담당자가 적어야 할 항목:

- 발생 시각
- 설비
- 계획 작업
- 이슈 유형
- 상세 사유
- 조치 내용
- 조치 시작/종료 시각
- 결과 상태

권장 이슈 유형:

- 금형 문제
- 자재 문제
- 설비 이상
- 품질 문제
- 작업자 대기
- 계획 변경
- 셋업/교체
- 기타

### 결과

이슈 입력이 되면 아래 분석이 가능해진다.

- 어떤 설비가 자주 멈추는지
- CT 악화가 어떤 사유에서 많이 생기는지
- 계획 지연의 주원인이 무엇인지

## 7. 사람이 입력하는 데이터와 시스템이 계산하는 데이터

이 구분을 먼저 해두는 것이 중요하다.

## 7.1 사람이 입력해야 하는 데이터

- 계획 업로드 파일
- 계획 수정 사항
- 실생산 결과 확정값
- 불량수량
- 비가동 사유
- 이슈 상세 설명
- 조치 내용
- 작업 시작/종료 보정

## 7.2 시스템이 계산해야 하는 데이터

- 계획 대비 달성률
- 불량률
- 설비별 진행 상태
- 시간 슬롯별 생산 delta
- 추정 CT
- 급감/정지 감지
- 이슈 후보 알림

원칙:

- 원천 사실은 사람이 적고
- 반복 계산은 시스템이 한다

## 8. 권장 화면 구조

## 8.1 생산 계획 화면

필요 기능:

- 엑셀 업로드
- 날짜별 계획 조회
- 설비별 정렬
- 수정/삭제
- 공정별 보기

## 8.2 생산 실행 콘솔

필요 기능:

- 계획 행 기준 상태 표시
- 실제수량 / 불량수량 입력
- 진행중 / 비가동 / 완료 전환
- 시작/종료 시각 입력
- 비고 입력

## 8.3 사출 모니터링 화면

필요 기능:

- 시간대별 생산 추이
- 누적 생산량
- 추정 CT
- 목표 CT 대비 차이
- 급감/중단 구간 강조
- 해당 구간 이슈 입력 버튼

## 8.4 사출 이슈 입력 화면 또는 모달

필요 기능:

- 감지된 구간 자동 채움
- 설비/시간/작업 정보 자동 연결
- 이슈 유형 선택
- 상세 사유 입력
- 조치 및 종료 입력

## 9. 데이터 모델 관점에서 필요한 추가 정의

현재 구조만으로도 시작은 가능하지만, 아래는 추가 정의가 필요하다.

## 9.1 계획 확인 이력

현재는 "계획을 담당자가 확인했는지"를 별도로 남기는 모델이 없다.

선택지:

1. `ProductionExecution`에 확인 시각/확인자 추가
2. 별도 `PlanAcknowledgement` 모델 생성

권장:

- 별도 모델로 분리하는 편이 깔끔하다

## 9.2 사출 모니터링 이슈 기록

현재는 모니터링 추이와 사람이 적는 이슈를 연결하는 전용 모델이 없다.

권장 신규 모델 예시:

- `InjectionMonitoringIssue`

권장 필드:

- `plan_date`
- `machine_name`
- `part_no`
- `lot_no`
- `sequence`
- `started_at`
- `ended_at`
- `slot_granularity`
- `delta_qty`
- `estimated_ct_sec`
- `baseline_ct_sec`
- `issue_type`
- `issue_detail`
- `action_taken`
- `created_by`

## 9.3 기준 CT의 우선순위

사출에서는 CT 기준이 여러 개일 수 있다.

예:

- PartSpec 기준 CT
- Setup 기준 목표 CT
- 최근 평균 CT

권장 우선순위:

1. 승인된 Setup CT
2. 평균 CT
3. PartSpec CT

이 우선순위는 화면과 계산 API에서 동일하게 써야 한다.

## 10. 추천 상태 전이

생산 작업 상태는 아래 흐름이 가장 자연스럽다.

1. `uploaded`
2. `acknowledged`
3. `running`
4. `paused`
5. `completed`
6. `closed`

현재 시스템과 연결 시 해석:

- `pending` = `uploaded` 또는 `acknowledged` 이전 단계
- `running` = 생산중
- `paused` = 비가동 또는 일시중단
- `completed` = 작업 종료

장기적으로는 `pending` 하나에 너무 많은 의미를 담지 않는 편이 좋다.

## 11. 구현 우선순위

이 프로세스를 한 번에 다 만들 필요는 없다.

권장 순서는 아래와 같다.

### 1차

- 생산 계획 업로드/조회 안정화
- 계획 기준 생산 실행 콘솔 정리
- 사출/가공 담당자별 계획 확인 흐름 정리

### 2차

- 사출 모니터링 화면에 시간대별 delta 생산량 표시
- cavity 기준 추정 CT 계산
- 목표 CT 대비 편차 표시

### 3차

- 급감/정지 자동 감지
- 사출 이슈 입력 기능
- 이슈 히스토리와 분석 연결

### 4차

- 관리자용 계획 대비 원인 분석
- AI 요약용 read layer 연결

## 12. 이 문서로 바로 결정할 수 있는 것

현재 바로 합의해두면 좋은 기준은 아래다.

1. 생산 계획이 모든 실행 데이터의 기준 키가 된다.
2. 실적은 계획 행 기준으로 입력한다.
3. 사출 모니터링은 자동 수집, 이슈 사유는 수동 입력으로 나눈다.
4. 생산량 급감/정지는 "이슈 입력 후보"로 다룬다.
5. 추정 CT는 cavity와 slot 생산량을 이용해 계산한다.

## 13. 다음 추천 문서

이 문서 다음으로 바로 만들기 좋은 것은 아래다.

1. `15-production-data-contract.md`
   - 계획, 실행, 모니터링, 이슈 입력 API 계약 정리

2. `16-injection-issue-requirements.md`
   - 사출 급감/정지 감지 규칙과 이슈 입력 항목 상세화
