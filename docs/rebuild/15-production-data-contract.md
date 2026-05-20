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

## 15. 가공 MES 우선 수기 보정 계약

가공 집계는 일반 `ProductionExecution` upsert와 다르게 다룬다. 가공의 기본 실적은 MES `报工`이고, 수기 입력은 MES 누락을 보정하는 별도 이벤트로 저장한다.

기준 문서:

- [docs/rebuild/21-machining-mes-first-manual-reconciliation.md](/Users/ssoe94/reporting_v2/wj_reporting/docs/rebuild/21-machining-mes-first-manual-reconciliation.md:1)

## 15.1 날짜 필드

가공 수기 보정에서는 아래 날짜를 반드시 분리한다.

| 필드 | 의미 |
| --- | --- |
| `business_date` | 실제 생산한 업무일 |
| `plan_date` | 원래 계획이 걸려 있던 날짜 |
| `credit_business_date` | 보정 후 실적을 귀속할 업무일 |
| `mes_business_date` | MES 보고가 들어온 업무일 |

원칙:

- 선진행 생산은 `business_date < plan_date`로 표현한다.
- 나중에 MES가 들어와도 실제 생산일 기준 분석은 `credit_business_date`를 사용한다.
- MES 장부 기준 분석은 `mes_business_date`를 별도 지표로 둔다.

## 15.2 권장 엔터티

### MachiningManualReport

의미:

- MES에 아직 잡히지 않은 가공 생산을 사람이 보정 입력한 이벤트

핵심 필드:

- `business_date`
- `plan_date`
- `plan_id`
- `plan_identity_hash`
- `machine_name`
- `equipment_key`
- `part_no`
- `model_name`
- `lot_no`
- `sequence`
- `planned_qty_at_report`
- `good_qty`
- `defect_qty`
- `total_reported_qty`
- `reason_code`
- `note`
- `status`
- `credit_business_date`
- `reported_by`
- `reported_at`

`total_reported_qty`는 기본적으로 `good_qty`와 같다. 불량 수량은 진행률 수량에 자동 합산하지 않고, 별도 품질/불량 지표로 집계한다. 특정 현장 기준에서 MES 보고 수량이 양품+불량 합산이라면 이 필드만 별도 입력해 운영 기준을 명확히 남긴다.

권장 상태:

- `open`
- `partial`
- `matched`
- `mismatch`
- `cancelled`

### MachiningManualReportDefect

의미:

- 수기 보정에 포함된 불량 유형별 수량

핵심 필드:

- `manual_report_id`
- `defect_category`
- `defect_type`
- `quantity`
- `note`

### MachiningManualReportMatch

의미:

- 수기 보정과 MES 보고의 대사 이력

핵심 필드:

- `manual_report_id`
- `mes_report_record_id`
- `matched_qty`
- `match_confidence`
- `match_reason`
- `matched_by`
- `matched_at`

## 15.3 중복 방지 집계

가공 진행률에 사용하는 최종 실적은 아래 기준으로 계산한다.

```text
effective_actual_qty
  = MES 보고 수량
  + max(0, 수기 보정 수량 - MES와 매칭된 수기 보정 수량)
```

원칙:

- MES와 매칭된 수기 보정은 다시 더하지 않는다.
- 부분 매칭이면 미대사 잔량만 수기 실적으로 남긴다.
- MES 수량이 수기 수량보다 크면 MES 수량을 우선하고, 차이는 mismatch 또는 overrun으로 표시한다.
- 화면은 MES 수량과 수기 보정 수량을 나눠 보여주되, 진행률은 `effective_actual_qty`를 사용한다.
- 수기 보정 수정 UI는 별도 화면보다 생산대시보드 가공 진행 카드 또는 상세 모달 안에 우선 배치한다.

## 15.4 API 계약

Provision 조회:

- `GET /api/production/machining/provision/?business_date=YYYY-MM-DD&days=3`

수기 보정 생성:

- `POST /api/production/machining/manual-reports/`

대사 큐 조회:

- `GET /api/production/machining/reconciliation/?business_date=YYYY-MM-DD&status=open,mismatch`

수동 매칭 확정:

- `POST /api/production/machining/reconciliation/{manual_report_id}/confirm/`

기존 생산 상태 API:

- `GET /api/production/status/?date=YYYY-MM-DD`
- 가공 숫자는 canonical context의 `effective_actual_qty` 기준을 사용한다.
- 새 백엔드는 `total_mes`, `total_manual_open`, `total_manual_matched`, `total_defect`와 part별 분해값을 추가로 내려준다.
- provision API가 아직 배포되지 않은 Render 백엔드를 볼 때 프론트는 기존 MES stats로 fallback하고 수기 보정 입력만 숨긴다.

## 15.5 검증 기준

필수 테스트:

- 수기 100, MES 없음이면 최종 실적 100
- 수기 100, MES 100 후등록이면 최종 실적 100
- 수기 100, MES 60이면 최종 실적 100, 미대사 수기 잔량 40
- 수기 100, MES 120이면 최종 실적 120, mismatch 또는 overrun 표시
- `business_date < plan_date`이면 선진행 예외 생성

## 16. 사출 MES 입고와 형합수 비교

MES 모니터링의 사출 화면에서는 `ProductionMesReportRecord(plan_type=injection, process_code=ZS)`를 별도 원장으로 보고, 실시간 형합수 기반 추정 생산량과 같은 설비·품번 키로 비교한다.

비교 키와 매칭 순서:

- 설비: 사출기 번호 기준으로 정규화한다. 예: `850T-1`, `1호기`, `1`은 모두 `1`로 매칭한다.
- 1차 매칭: `설비 + 작업지시 Part No.`가 직접 일치하면 해당 작업지시에 MES 입고를 배정한다.
- 2차 매칭: ZS의 `part_no`가 반제품 번호라 직접 일치하지 않으면, ZS `material_name/model_name` 문자열 안에서 작업지시 Part No. 또는 모델명을 찾는다.
- 2차 매칭에서는 `ABJ76763501/02/06/10` 같은 축약 표기를 `ABJ76763501`, `ABJ76763502`, `ABJ76763506`, `ABJ76763510` 후보로 확장해 비교한다.
- 3차 설비 보정: MES 입고가 잘못된 설비로 들어와도 같은 날짜 안에서 후보 Part No./모델이 하나의 다른 설비 작업지시에만 유일하게 매칭되면 그 작업지시에 배정한다. 이 경우 화면에는 `설비 보정`과 원본 `MES 설비`를 함께 표시한다.
- 비교 후보는 공백을 제거하고 대문자로 정규화하며, 4자 미만의 짧은 토큰은 우연 매칭 위험이 크므로 후보에서 제외한다. 단, `설비 + Part No.` 직접 일치는 별도로 처리한다.
- 같은 설비 안에서 하나의 후보가 여러 작업지시를 가리키면 자동 배정하지 않고 `형합수 없음` 후보로 남겨 사람이 확인한다.
- 날짜: 생산 기준일 08:00 ~ 익일 08:00 기준이며, 프런트는 현재 모니터링의 `planDate`로 `/api/production/mes-report-stats/?plan_type=injection`을 조회한다.

비교 수량:

- `형합수 추정`: 사출 모니터링 형합수와 계획 cavity를 이용해 산출한 품번별 추정 생산량이다. 금형/코어 교체 신호가 확인되면 해당 전환 시점의 누적 생산량을 기준으로 배분하고, 전환 신호가 없지만 같은 모델·동일 cavity의 연속 코어 작업지시로 판단되면 앞 작업지시 계획량까지 채운 뒤 나머지를 다음 작업지시로 넘긴다.
- `MES 입고`: MES `ZS` 생산보고의 `report_qty` 합계다.
- `차이`: `MES 입고 - 형합수 추정`으로 계산한다.
- 화면의 대표 Part No.는 작업지시 Part No.를 우선 표시하고, MES에서 들어온 반제품 Part No.는 보조 텍스트로 남긴다.
- 설비 표기는 MES report의 임의 문자열보다 사출 모니터링 설비 마스터를 우선 사용해 `1400T-5 / 5호기` 형태로 표시한다.
- 화면에는 `직접 Part No.`, `모델/품번 후보`, `설비 보정`, `미매칭` 중 어떤 기준으로 붙었는지 표시한다.
- 백엔드 stats 응답은 같은 MES 그룹 안의 `material_name` 후보를 `mes_material_names` 배열로 보존해, 프런트가 첫 번째 material 이름만 보고 매칭을 놓치지 않게 한다.

상태:

- `수량 일치`: 형합수 추정 생산량과 MES 입고량이 같다.
- `MES 입고 부족`: 형합수 추정 생산량이 있는데 MES 입고가 적다.
- `MES 입고 초과`: MES 입고가 형합수 추정 생산량보다 많다.
- `MES 미입고`: 형합수 추정 생산량은 있으나 MES 입고가 없다.
- `형합수 없음`: MES 입고는 있으나 해당 설비·품번의 형합수 추정 실적이 없다.

이 비교는 생산실적을 대체하지 않는다. 목적은 사출과/생산 담당자가 “이미 형합수로 생산이 보이는데 MES 입고가 늦거나 누락된 건”과 “입고는 있는데 모니터링상 생산 근거가 약한 건”을 빠르게 찾는 것이다.

## 17. 사출 형합수 작업지시 배분 보정

사출 모니터링의 형합수는 설비 단위 누적값이므로, 한 설비에 여러 작업지시가 걸려 있으면 작업지시별 배분 규칙이 필요하다.

이 규칙은 특정 설비나 특정 품번에 대한 예외 처리가 아니라 모든 사출 설비와 모든 기준일에 동일하게 적용하는 공통 배분 규칙이다. 코드에는 설비번호, Lot, Part No.를 하드코딩하지 않고 작업지시의 모델, cavity, 제품군, Part No. 관계와 전환 이벤트 유무만 사용한다.

기본 원칙:

- 금형 교체 또는 코어 교체 전환 신호가 있으면 전환 이벤트를 우선한다.
- 전환 신호가 있는 경우에는 앞 작업지시 계획량으로 cap을 걸지 않는다. 예를 들어 A 작업지시 계획이 100개인데 120샷 이후 금형 교체 신호가 확인되면 A에 120을 배정한다. 금형/코어 교체는 순간적으로 일어나지 않기 때문에 전환 전 생산량은 앞 작업지시의 초과 생산으로 보는 것이 맞다.
- 전환 신호가 없고 연속 작업지시가 같은 모델·동일 cavity·동일 제품군이며 Part No.가 같거나 Part No. 11자리 중 마지막 2자리만 다른 코어 파생 품번이면, 앞 작업지시를 계획량까지 채운 뒤 남은 형합수를 다음 작업지시로 자동 이월한다.
- 위 조건을 만족하지 않으면 임의 이월하지 않고 현재 작업지시의 초과 생산 또는 확인 필요 케이스로 남긴다.

예외 적용 예시:

- 2026-05-19 16호기 계획: `ACQ30854203 / 27G523 / 37개`, `ACQ30854211 / 27G523 / 1,475개`
- MES 형합수는 하루 동안 거의 연속적으로 발생했고 10분 이상 정지 또는 C/T 급변이 없어 코어 변경 신호가 약하다.
- 따라서 `ACQ30854203`은 계획량 37개까지만 배정하고, 나머지 형합수는 `ACQ30854211`로 넘긴다.

이 보정은 “신호가 없는 연속 코어 작업”을 위한 편의 규칙이다. 실제 금형/코어 전환 신호가 감지된 경우에는 항상 전환 이벤트가 우선한다.

## 18. MES 모니터링 저장, 과거 조회, 백업

사출 MES 모니터링은 `InjectionMonitoringRecord`를 hot storage로 사용한다. 수집 작업은 설비별 누적 형합수, 오일온도, 전력 누적값을 timestamp 단위로 저장하고, 화면은 필요한 기준일의 08:00 ~ 익일 08:00 구간만 `/api/injection/production-matrix/?date=YYYY-MM-DD`로 조회한다.

운영 원칙:

- 현재 기준일은 live 모드로 조회하고 60초 단위 자동 갱신을 유지한다.
- 과거 기준일은 저장된 스냅샷 조회 모드로 조회하며 자동 갱신을 끈다. 서버는 선택된 하루 구간만 읽는다.
- 조회 가능한 기준일 목록은 `/api/injection/monitoring-dates/`에서 distinct business date만 내려준다. 이 목록은 원천 row 전체를 프런트로 보내지 않는다.
- `InjectionMonitoringRecord(machine_name, timestamp)` 복합 인덱스를 사용해 설비별 기간 조회 비용을 줄인다.
- 오래된 2분 단위 원천 스냅샷은 `compact_monitoring_records`로 시간 단위 대표 스냅샷만 남기고 압축한다. 상세 분석이 필요한 최근 구간은 촘촘하게, 오래된 구간은 추세/집계 중심으로 본다.

백업 권장:

- 매일 새벽 Render cron 또는 별도 worker에서 전일 business date의 `InjectionMonitoringRecord`를 CSV 또는 Parquet gzip으로 export한다.
- 저장 위치는 Render DB 바깥의 object storage를 권장한다. 예: S3, Cloudflare R2, Google Cloud Storage.
- 파일 경로는 `mes/injection/business_date=YYYY-MM-DD/part-000.parquet.gz`처럼 기준일 파티션으로 둔다.
- 백업 후에는 row count, min/max timestamp, 설비 수, checksum을 함께 저장한다.
- DB에는 최근 30~90일 hot/warm 데이터만 두고, 장기 분석은 백업 파일을 다시 적재하거나 별도 warehouse에서 조회한다.
- 월 1회 복구 리허설을 해 특정 기준일을 임시 테이블로 restore할 수 있는지 확인한다.
