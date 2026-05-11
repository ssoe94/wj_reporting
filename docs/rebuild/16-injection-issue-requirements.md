# 사출 이슈 요구사항

## 1. 목적

이 문서는 사출 모니터링에서 생산량 급감, 정지, CT 악화가 발생했을 때
담당자가 원인을 기록하고 추적할 수 있도록 하기 위한 요구사항을 정리한다.

목표는 아래와 같다.

1. 어떤 상황을 이슈 후보로 볼지 정한다.
2. 시스템이 자동 감지하는 것과 사람이 입력하는 것을 나눈다.
3. 사출 담당자가 입력해야 하는 최소 항목을 고정한다.
4. 이후 모델/API/화면 설계의 기준 문서로 쓴다.

기준 문서:

- [docs/rebuild/14-production-operations-process.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/14-production-operations-process.md:1)
- [docs/rebuild/15-production-data-contract.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/15-production-data-contract.md:1)
- [frontend/src/pages/injection/MonitoringPage.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/pages/injection/MonitoringPage.tsx:1)
- [backend/injection/models.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/injection/models.py:1)

## 2. 문제 정의

사출 생산에서는 아래 상황이 반복적으로 중요하다.

1. 시간당 생산량이 갑자기 줄어든다.
2. 생산이 멈춘다.
3. 실제 CT가 기준 CT보다 나빠진다.
4. 왜 그런 일이 일어났는지 모니터링 데이터만으로는 설명되지 않는다.

즉, 수치 데이터만 있어서는 부족하고
"누가, 언제, 왜, 어떻게 조치했는지"를 함께 기록해야 한다.

## 3. 핵심 원칙

1. 생산량 급감/정지는 시스템이 먼저 감지한다.
2. 감지된 후보에 대해 담당자가 사유를 입력한다.
3. 이슈는 계획 작업과 연결되어야 한다.
4. 이슈는 나중에 분석 가능한 코드 체계를 가져야 한다.
5. 자유 텍스트만 두지 말고 유형 분류도 함께 저장한다.

## 4. 이슈 후보 감지 규칙

초기에는 너무 복잡한 이상탐지보다 명확한 규칙 기반으로 시작하는 것이 좋다.

## 4.1 생산량 급감

정의 예시:

- 직전 기준 생산량 대비 현재 slot 생산량이 크게 감소

권장 규칙 예시:

- `actual_vs_target_ratio < 0.7`
- 또는 `delta_qty < baseline_delta_qty * 0.7`

설명:

- baseline은 목표 CT 기준 기대 생산량 또는 직전 이동 평균으로 둘 수 있다.
- 초기에는 목표 CT 기준이 더 단순하다.

## 4.2 생산 정지

정의 예시:

- 연속 slot 동안 생산량이 0

권장 규칙 예시:

- `delta_qty = 0` 이 연속 2개 slot 이상

설명:

- 10분 단위라면 20분 이상 무생산 상태를 뜻한다.

## 4.3 CT 악화

정의 예시:

- 추정 CT가 목표 CT 또는 기준 CT보다 악화

권장 규칙 예시:

- `estimated_ct_sec > target_ct_sec * 1.2`

## 4.4 온도/전력 이상

초기에는 참고 신호로만 사용하고, 1차 감지 트리거로는 보조적으로 두는 것이 좋다.

이유:

- 생산량 급감보다 현장 설명력이 낮을 수 있다.
- 설비별 정상 범위가 다를 가능성이 높다.

## 5. 이슈 후보와 실제 이슈의 차이

이 둘을 분리해서 보는 것이 중요하다.

## 5.1 이슈 후보

시스템이 자동으로 판단한 경고 구간

예:

- `10:10 ~ 10:30`
- `3호기`
- `delta_qty 22`
- `baseline 80`
- `estimated_ct 58.2s`

## 5.2 실제 이슈

담당자가 확인하고 등록한 운영 기록

예:

- 금형 문제
- 금형 청소 및 재정렬
- 20분 정지

원칙:

- 모든 후보가 실제 이슈가 되는 것은 아니다.
- 후보는 노이즈가 있을 수 있으므로 사람 확인 절차가 필요하다.

## 6. 필수 입력 항목

담당자가 이슈를 등록할 때 필요한 최소 항목은 아래와 같다.

| 필드 | 설명 | 입력 주체 |
| --- | --- | --- |
| `plan_date` | 계획 기준 날짜 | 자동 |
| `machine_name` | 설비명 | 자동 |
| `part_no` | 품목 | 자동 |
| `lot_no` | lot | 자동 |
| `sequence` | 계획 순번 | 자동 |
| `started_at` | 이슈 시작 시각 | 자동 또는 수정 가능 |
| `ended_at` | 이슈 종료 시각 | 수동 |
| `trigger_type` | 감지 유형 | 자동 |
| `trigger_value` | 감지 수치 | 자동 |
| `baseline_value` | 비교 기준 | 자동 |
| `issue_type` | 이슈 유형 | 수동 |
| `issue_detail` | 상세 사유 | 수동 |
| `action_taken` | 조치 내용 | 수동 |
| `status` | 처리 상태 | 수동 |
| `created_by` | 등록자 | 자동 |

## 7. 이슈 유형 체계

초기에는 너무 세분화하지 말고 아래 정도로 시작하는 것이 좋다.

| 코드 | 의미 |
| --- | --- |
| `mold` | 금형 문제 |
| `material` | 자재 문제 |
| `equipment` | 설비 이상 |
| `quality` | 품질 문제 |
| `setup_change` | 셋업/교체 |
| `operator` | 작업자/인원 문제 |
| `plan_change` | 계획 변경 |
| `external` | 외부 요인 |
| `other` | 기타 |

권장:

- 저장은 코드값
- 화면은 한글 라벨

## 8. 상태 체계

권장 상태:

- `open`
- `investigating`
- `resolved`
- `closed`
- `dismissed`

설명:

- `dismissed`는 후보였지만 실제 이슈로 보지 않는 경우

## 9. 입력 화면 요구사항

## 9.1 진입 방식

아래 두 가지 방식이 필요하다.

1. 모니터링 화면에서 특정 slot 경고를 눌러 진입
2. 계획 행 또는 설비 기준으로 수동 등록

## 9.2 자동 채움 항목

모니터링 화면에서 진입하면 아래는 자동 채워야 한다.

- 설비
- 날짜
- 계획 작업
- slot 시작 시각
- 감지 유형
- 감지 수치
- baseline
- 추정 CT

## 9.3 수동 입력 항목

- 이슈 유형
- 상세 설명
- 조치 내용
- 종료 시각
- 결과 상태

## 9.4 화면 동작

권장 동작:

1. 경고 slot 클릭
2. 이슈 등록 모달 열림
3. 자동 수치 표시
4. 담당자 사유 입력
5. 저장 후 모니터링 구간과 연결 표시

## 10. 목록/히스토리 화면 요구사항

사출 이슈는 단건 입력만 있으면 안 되고, 나중에 다시 볼 수 있어야 한다.

필요 조회 기준:

- 날짜
- 설비
- 품목
- 이슈 유형
- 상태
- 등록자

필요 컬럼:

- 시작/종료 시각
- 정지 또는 급감 시간
- 유형
- 상세 사유
- 조치
- 상태

## 11. 분석 요구사항

이슈가 쌓이면 아래 분석이 가능해야 한다.

1. 설비별 가장 많은 이슈 유형
2. 품목별 CT 악화 빈도
3. 자주 멈추는 시간대
4. 평균 복구 시간
5. 계획 미달성과 이슈의 상관관계

초기에는 화면에 바로 다 만들지 않아도 되지만, 데이터 구조는 이 분석을 염두에 두고 잡는 것이 좋다.

## 12. 권한 요구사항

권장 권한:

- `injection.read`
  - 모니터링과 이슈 목록 조회
- `injection.write`
  - 이슈 등록/수정
- `injection.issue.close`
  - 이슈 종료/닫기
- `analysis.read`
  - 관리자/분석 조회

초기에는 `injection.write` 하나에 묶어도 되지만, 장기적으로는 닫기 권한을 분리하는 것도 고려할 수 있다.

## 13. 비기능 요구사항

1. 이슈 등록은 빠르게 끝나야 한다.
2. 현장 사용자가 긴 설명을 쓰지 않아도 되도록 유형 선택이 먼저 와야 한다.
3. 모바일 또는 태블릿에서도 입력 가능해야 한다.
4. 자동 감지는 너무 잦은 오탐으로 현장을 방해하면 안 된다.

## 14. 초기 MVP 권장 범위

처음부터 너무 크게 만들지 말고 아래 정도로 시작하는 것이 좋다.

1. 생산량 급감/정지 후보 표시
2. 모니터링 화면에서 이슈 등록
3. 유형/상세/조치 입력
4. 날짜별/설비별 이슈 목록 조회

나중에 추가할 것:

1. 자동 후보 생성 저장
2. CT 악화 규칙 고도화
3. 온도/전력 패턴 연계
4. 복구시간 자동 계산

## 15. 권장 모델 초안

권장 신규 모델:

- `InjectionMonitoringIssue`

권장 필드:

```text
id
plan_date
plan_type
machine_name
part_no
lot_no
sequence
started_at
ended_at
slot_granularity
trigger_type
trigger_value
baseline_value
estimated_ct_sec
target_ct_sec
issue_type
issue_detail
action_taken
status
created_by
resolved_by
created_at
updated_at
```

## 16. 구현 순서

1. slot 요약 API 제공
2. 이슈 등록 API 추가
3. 모니터링 화면에서 이슈 등록 모달 연결
4. 이슈 목록/히스토리 화면 추가
5. 분석 화면 연결

## 17. 이 문서의 핵심 결론

1. 사출 이슈는 "모니터링 수치 + 사람 설명"의 결합 데이터다.
2. 시스템은 후보를 감지하고, 사람은 원인과 조치를 입력한다.
3. 이슈는 반드시 계획 작업과 연결되어야 나중에 분석 가치가 생긴다.
