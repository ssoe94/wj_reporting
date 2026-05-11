# MES Minute Monitoring Rollout

## 목표

운영 중인 Render 백엔드는 1분 단위 MES 스냅샷을 저장하고, `frontend-next`는 최근 24시간을 1분 단위로 조회한다. 배포 리스크를 줄이기 위해 백엔드 지원, 스케줄 전환, 프런트 전환을 분리한다.

## 단계

1. `feature/mes-minute-monitoring` 브랜치에서 백엔드 1분 슬롯 지원과 Mac collector를 검증한다.
2. 백엔드만 먼저 배포한다.
3. 운영 API에서 아래 요청이 `interval_minutes: 1`을 반환하는지 확인한다.

```text
https://wj-reporting.onrender.com/api/injection/production-matrix/?interval=1min&columns=60
```

4. Render cron `injection-snapshot-10min`의 schedule을 `* * * * *`로 변경한다.
5. 1~2일 동안 Render 로그, DB row 증가량, MES 호출량을 관찰한다.
6. 안정 확인 후 `frontend-next`를 실제 Render static site로 전환할지 결정한다.

## 체크 포인트

- MES quota: `资源参数监控列表接口` 호출량이 1분 주기에서도 여유가 있는지 확인한다.
- Render cron: 중복 실행이 발생하지 않는지 확인한다.
- DB: `InjectionMonitoringRecord` row 증가량과 응답 속도를 확인한다.
- Compaction: 최근 24시간 초과 데이터는 시간 단위 snapshot만 남는지 확인한다.
- Frontend fallback: 배포 전 기존 서버에서는 `frontend-next`가 10분 API로 fallback한다.

## 운영 예상

- 1분 원본: 17대 x 1,440분 = 하루 약 24,480 rows.
- Render 24시간 보관량: 약 2.5만 rows + 시간 단위 과거 rows.
- Mac 60일 보관량: 약 146만 rows.

## 롤백

1. Render cron schedule을 `*/10 * * * *`로 되돌린다.
2. 프런트는 자동으로 `interval=10min&columns=144` fallback이 가능하다.
3. 필요 시 `compact_monitoring_records`를 수동 실행해 DB row를 정리한다.

