# 생산 데이터 계약

## 1. 목적

이 문서는 생산 운영 프로세스를 구현하기 위해 필요한 핵심 데이터 계약을 정리한다.

목표는 아래와 같다.

1. 생산 계획, 실행, 모니터링, 이슈의 기준 키를 고정한다.
2. 어떤 데이터가 입력값이고 어떤 데이터가 계산값인지 나눈다.
3. 새 프런트와 정리된 백엔드가 같은 필드 정의를 쓰게 한다.

기준 문서:

- [docs/rebuild/02-api-contract.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/02-api-contract.md:1)
- [docs/rebuild/14-production-operations-process.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/14-production-operations-process.md:1)
- [backend/production/models.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/production/models.py:1)
- [backend/injection/models.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/injection/models.py:1)

## 2. 최상위 원칙

1. 모든 실행 데이터는 생산 계획 키를 기준으로 연결한다.
2. 계획과 실적은 별도 테이블이지만 같은 기준 키를 공유한다.
3. 모니터링 데이터는 시계열 원천 데이터로 보관한다.
4. 이슈 데이터는 모니터링 감지 결과와 사람의 설명을 함께 저장한다.
5. 화면은 계산값을 저장하지 말고, 가능한 한 원천값과 결정값만 저장한다.

## 3. 공통 기준 키

생산 관련 데이터의 공통 기준 키는 아래로 정의한다.

| 필드 | 의미 | 비고 |
| --- | --- | --- |
| `plan_date` | 계획 기준 날짜 | 업무일 기준 날짜 |
| `plan_type` | 공정 구분 | `injection`, `machining` |
| `machine_name` | 설비/라인명 | 표시명과 내부 키 분리 가능 |
| `part_no` | 품목 번호 | 가능한 한 대문자 정규화 |
| `lot_no` | lot 식별자 | 없을 수 있음 |
| `sequence` | 계획 순번 | 업로드 순서 보존 |

원칙:

- 실적, 이슈, 추정 CT 모두 이 기준 키를 따라간다.
- 장기적으로는 surrogate id를 써도 되지만, 화면/분석/API에서는 위 키가 항상 보여야 한다.

## 4. 엔터티 구분

## 4.1 ProductionPlan

의미:

- 생산관리 담당자가 업로드한 기준 계획

핵심 필드:

- `plan_date`
- `plan_type`
- `machine_name`
- `part_no`
- `lot_no`
- `model_name`
- `part_spec`
- `planned_quantity`
- `sequence`

성격:

- 입력 데이터
- 기준 데이터

## 4.2 ProductionExecution

의미:

- 계획 기준으로 현장이 입력하는 실행 결과

핵심 필드:

- 공통 기준 키
- `actual_qty`
- `defect_qty`
- `idle_time`
- `personnel_count`
- `operating_ct`
- `start_datetime`
- `end_datetime`
- `status`
- `note`
- `updated_by`

성격:

- 현장 입력 데이터
- 당일 수정 가능 데이터

## 4.3 InjectionMonitoringRecord

의미:

- 사출기 모니터링 원천 시계열

핵심 필드:

- `machine_name`
- `device_code`
- `timestamp`
- `capacity`
- `oil_temperature`
- `power_kwh`

성격:

- 자동 수집 데이터
- 원천 데이터

## 4.4 CycleTimeSetup

의미:

- 사출 품목/설비의 기준 CT 및 인원 기준

핵심 필드:

- `machine_no`
- `part_no`
- `model_code`
- `target_cycle_time`
- `standard_cycle_time`
- `mean_cycle_time`
- `personnel_count`
- `status`

성격:

- 기준 데이터
- 운영 중 변경 가능

## 4.5 권장 신규 엔터티

### PlanAcknowledgement

의미:

- 담당자가 계획을 확인했는지 기록

필드 예시:

- 공통 기준 키
- `acknowledged_by`
- `acknowledged_at`
- `comment`

### InjectionMonitoringIssue

의미:

- 사출 모니터링 급감/정지/CT 악화 이슈 기록

필드 예시:

- 공통 기준 키
- `started_at`
- `ended_at`
- `slot_granularity`
- `trigger_type`
- `trigger_value`
- `baseline_value`
- `issue_type`
- `issue_detail`
- `action_taken`
- `status`
- `created_by`
- `resolved_by`

## 5. API 그룹

생산 데이터 계약은 아래 5개 API 그룹으로 나누는 것을 권장한다.

1. 계획
2. 실행
3. 모니터링
4. 이슈
5. 분석

## 6. 계획 API 계약

## 6.1 계획 업로드

권장 엔드포인트:

- `POST /api/v1/production-plans:upload`

초기 호환:

- `POST /production/plan/upload/`

입력:

- `file`
- `plan_type`
- `date`

응답 최소 필드:

```json
{
  "data": {
    "plan_date": "2026-05-09",
    "plan_type": "injection",
    "uploaded_count": 120,
    "updated_count": 84,
    "created_count": 36,
    "warnings": []
  }
}
```

## 6.2 계획 목록 조회

권장 엔드포인트:

- `GET /api/v1/production-plans?plan_date=2026-05-09&plan_type=injection`

초기 호환:

- `GET /production/plans/?date=...&plan_type=...`

응답 최소 필드:

- 공통 기준 키
- `model_name`
- `planned_quantity`
- `plan_status`

`plan_status` 권장 예시:

- `uploaded`
- `acknowledged`
- `running`
- `paused`
- `completed`

주의:

현재 이 값은 별도 계산 또는 별도 모델 조합으로 만들어야 할 수 있다.

## 6.3 계획 요약 조회

권장 엔드포인트:

- `GET /api/v1/production-plan-summaries?plan_date=2026-05-09`

초기 호환:

- `GET /production/plan-summary/`

응답 용도:

- 날짜별 총 계획 수량
- 설비별 계획 합계
- 모델별 계획 합계

## 7. 실행 API 계약

## 7.1 실행 목록 조회

권장 엔드포인트:

- `GET /api/v1/production-executions?plan_date=2026-05-09&plan_type=injection`

응답 최소 필드:

- 공통 기준 키
- `actual_qty`
- `defect_qty`
- `idle_time`
- `personnel_count`
- `operating_ct`
- `status`
- `start_datetime`
- `end_datetime`
- `note`

## 7.2 실행 upsert

권장 엔드포인트:

- `POST /api/v1/production-executions:upsert`

초기 호환:

- 기존 `executions/upsert` 성격의 엔드포인트 사용 가능

입력 예시:

```json
{
  "plan_date": "2026-05-09",
  "plan_type": "injection",
  "machine_name": "3호기",
  "part_no": "ABC123",
  "lot_no": "LOT-01",
  "sequence": 2,
  "actual_qty": 520,
  "defect_qty": 12,
  "idle_time": 35,
  "personnel_count": 1.5,
  "operating_ct": 41.2,
  "start_datetime": "2026-05-09T08:10:00+09:00",
  "end_datetime": "2026-05-09T17:40:00+09:00",
  "status": "completed",
  "note": "금형 청소 1회"
}
```

원칙:

- upsert는 반드시 공통 기준 키를 포함해야 한다.
- 실적 레코드는 계획 키를 잃으면 안 된다.

## 7.3 실행 상태 전환

권장 엔드포인트:

- `POST /api/v1/production-executions:change-status`

입력 최소 필드:

- 공통 기준 키
- `status`
- `changed_at`
- `reason`

초기에는 upsert 안에서 같이 처리해도 되지만, 장기적으로는 상태 전환 이력을 남기는 편이 좋다.

## 8. 모니터링 API 계약

## 8.1 생산 매트릭스 조회

권장 엔드포인트:

- `GET /api/v1/injection-monitoring/matrix?interval=10min&columns=144`

초기 호환:

- `GET /injection/production-matrix/`

응답은 아래 3층이 필요하다.

1. 시간 슬롯 정보
2. 설비 목록
3. 설비별 시계열 매트릭스

추가로 내려주면 좋은 값:

- `setup_data_map`
- `target_cycle_time`
- `baseline_ct`
- `personnel_count`

## 8.2 최신 스냅샷 갱신

권장 엔드포인트:

- `POST /api/v1/injection-monitoring:refresh`

초기 호환:

- `POST /injection/update-recent-snapshots/`

주의:

- 장기적으로는 공개 권한이 아니라 제한된 실행 권한으로 바꾸는 것이 좋다.

## 8.3 시간 슬롯 요약

권장 신규 엔드포인트:

- `GET /api/v1/injection-monitoring/slots?machine_name=3호기&plan_date=2026-05-09&interval=10min`

응답 예시:

```json
{
  "data": {
    "plan_date": "2026-05-09",
    "machine_name": "3호기",
    "interval": "10min",
    "slots": [
      {
        "slot_started_at": "2026-05-09T08:00:00+09:00",
        "slot_ended_at": "2026-05-09T08:10:00+09:00",
        "delta_qty": 80,
        "cumulative_qty": 640,
        "estimated_ct_sec": 45.0,
        "target_ct_sec": 38,
        "baseline_ct_sec": 40,
        "actual_vs_target_ratio": 0.84,
        "oil_temperature": 37.2,
        "power_kwh": 4.8,
        "is_alert_candidate": true
      }
    ]
  }
}
```

이 엔드포인트는 프런트에서 복잡한 계산을 줄이는 데 큰 도움이 된다.

## 9. 이슈 API 계약

## 9.1 이슈 목록 조회

권장 신규 엔드포인트:

- `GET /api/v1/injection-monitoring-issues?plan_date=2026-05-09&machine_name=3호기`

응답 최소 필드:

- 공통 기준 키
- `started_at`
- `ended_at`
- `trigger_type`
- `issue_type`
- `status`
- `issue_detail`
- `action_taken`

## 9.2 이슈 생성

권장 신규 엔드포인트:

- `POST /api/v1/injection-monitoring-issues`

입력 예시:

```json
{
  "plan_date": "2026-05-09",
  "plan_type": "injection",
  "machine_name": "3호기",
  "part_no": "ABC123",
  "lot_no": "LOT-01",
  "sequence": 2,
  "started_at": "2026-05-09T10:10:00+09:00",
  "ended_at": "2026-05-09T10:30:00+09:00",
  "slot_granularity": "10min",
  "trigger_type": "delta_drop",
  "trigger_value": 22,
  "baseline_value": 80,
  "issue_type": "equipment",
  "issue_detail": "형체부 알람 발생으로 정지",
  "action_taken": "설비 점검 후 재가동",
  "status": "resolved"
}
```

## 9.3 이슈 상태 전이

권장 상태:

- `open`
- `investigating`
- `resolved`
- `closed`

원칙:

- 감지 즉시 자동 생성까지 할지
- 아니면 사람 입력 시작 시 생성할지

이 두 가지는 운영 방식에 따라 선택할 수 있다.

초기에는 "후보 알림 -> 사람이 등록" 방식이 더 안전하다.

## 10. 분석 API 계약

## 10.1 생산 상태 요약

권장 엔드포인트:

- `GET /api/v1/production-status?plan_date=2026-05-09`

초기 호환:

- `GET /production/status/`

응답 최소 필드:

- 공정별 진행 상태
- 설비별 진행 상태
- 계획 대비 실적
- 누락 여부

## 10.2 계획 대비 차이

권장 신규 엔드포인트:

- `GET /api/v1/production-variance?plan_date=2026-05-09&plan_type=injection`

응답 최소 필드:

- 공통 기준 키
- `planned_quantity`
- `actual_qty`
- `variance_qty`
- `variance_rate`
- `defect_qty`
- `defect_rate`
- `idle_time`
- `status`

## 11. 필드별 책임 구분

## 11.1 사람이 입력하는 값

- `planned_quantity`
- `actual_qty`
- `defect_qty`
- `idle_time`
- `personnel_count`
- `note`
- `issue_detail`
- `action_taken`

## 11.2 시스템이 계산하는 값

- `achievement_rate`
- `defect_rate`
- `delta_qty`
- `estimated_ct_sec`
- `actual_vs_target_ratio`
- `is_alert_candidate`
- `variance_qty`
- `variance_rate`

원칙:

- 계산값은 조회 응답으로 내리고
- 저장값은 원천 또는 결정값 중심으로 유지한다

## 12. 날짜/시간 계약

생산 데이터에서는 아래를 구분해야 한다.

| 필드 | 의미 |
| --- | --- |
| `plan_date` | 계획 기준 날짜 |
| `business_date` | 생산 업무일 기준 날짜 |
| `timestamp` | 모니터링 원시 시각 |
| `slot_started_at` | 집계 슬롯 시작 시각 |
| `slot_ended_at` | 집계 슬롯 종료 시각 |
| `start_datetime` | 작업 시작 시각 |
| `end_datetime` | 작업 종료 시각 |

원칙:

- `plan_date`와 `business_date`는 혼용하지 않는다.
- 모니터링 집계는 `slot_started_at`과 `slot_ended_at`을 항상 함께 준다.

## 13. 우선 구현 순서

1. 계획/실행 계약 정리
2. 모니터링 slot 요약 계약 추가
3. 이슈 입력 계약 추가
4. 계획 대비 차이 분석 계약 추가

## 14. 이 문서의 핵심 결론

1. 생산 계획은 모든 실행 데이터의 앵커다.
2. 실적 입력은 계획 키 기준 upsert로 간다.
3. 사출 모니터링은 slot 요약 API가 있어야 프런트가 단순해진다.
4. 이슈 데이터는 모니터링 수치와 사람 설명을 함께 저장해야 한다.
