# 사출 현장 모니터링 서버 설계

공통 장비 규격은 [프로토콜 v1](protocol-v1.md)에 정의한다. 이 문서는 Django 수신·조회와 WJ 서버 화면의 구현 기준이다.

## 모델과 수신 경계

`field_monitoring`의 첫 마이그레이션은 현장 PC, 장비 자격 이력, 수신 묶음, 이벤트, 현장 PC별 최신 heartbeat와 관리 변경 이력을 추가한다. 현장 PC는 서버 식별자에 표시명, 앱 목록, 위치, 호기/라인 메모, 사용 여부를 연결한다. 등록·수정·중지와 자격 발급·회수에는 수행자와 시각을 남긴다. 중지한 PC의 데이터도 과거 기록에서 조회할 수 있다.

장비 자격은 공개 키 ID와 비밀값 해시를 저장한다. 비교는 상수 시간으로 수행한다. 활성 자격은 PC당 하나이며 회수·재발급 이력을 보존한다. 발급 응답에서만 평문을 전달한다. 수신과 자격 변경은 같은 PC를 잠그는 트랜잭션 경계에서 PC 활성 여부와 자격을 확인한다.

`/api/field/v1/ingest/`와 `/heartbeat/`는 장비 전용 인증을 적용한다. 본문 바이트 상한을 파싱 전에 확인한다. 수신 묶음은 `(station, batch_id)` 고유키와 요청 SHA-256·최초 ACK를 저장한다. 이벤트는 `(station, database_id, seq)` 고유키와 원천 JSON, 업무일·시각·검색용 필드를 저장한다. 기존 이벤트와 충돌하면 묶음 전체를 보류한다. production 집계는 원본이 저장된 업무일로 조회하며 `clock_suspect` 이벤트를 제외한다. 경고에 해당하는 시계차만 있는 경우에는 해당 업무일 집계에 포함한다. 서버의 집계 보류 시계차는 `FIELD_MONITORING_CLOCK_HOLD_SECONDS`로 설정하며 기본값은 3,600초다.

검색은 station·업무일·앱·result와 바코드·시리얼·품번 정확 조건을 우선 사용한다. 실제 운영량을 측정해 인덱스와 보관 정책을 재검토한다. 원천 이벤트를 지우는 API는 제공하지 않는다. 기존 설비 모니터링 및 [현장 운영 집계](../../backend/analytics/field_operations.py)와 저장 경계를 분리한다. 기존 바코드 수신기에 대한 호환 경로는 단계 B 범위 밖이다.

## 사람용 API

사람용 API는 JWT를 사용한다. 활성 사용자는 실제 사출 조회 권한(`can_view_injection`) 또는 superuser 권한이 있을 때 조회할 수 있다. 현장 단말 계정은 운영 조회에서 제외한다. 활성 superuser만 현장 PC나 장비 자격을 관리할 수 있다. [기존 권한 경계](../../backend/injection/permissions.py)

| 경로 | 동작 |
| --- | --- |
| `GET /api/field/v1/overview/` | 업무일·station별 결과, 최신 접속·장치·송신 상태와 경고 |
| `GET /api/field/v1/exceptions/` | 업무일·station별 예외와 기록 검색에 적용할 필터 |
| `GET /api/field/v1/events/` | 업무일 기간 및 이벤트 상세 필터, 페이지당 최대 500건, 커서 페이지네이션 |
| `GET /api/field/v1/events.csv` | 같은 필터의 CSV, 최대 10,000행, UTF-8 BOM, 수식 주입 방지 |
| `GET/POST /api/field/v1/stations/` | 관리용 목록과 등록 |
| `PATCH /api/field/v1/stations/{station_id}/` | 앱·이름·위치·메모 변경과 사용 여부 |
| `POST /api/field/v1/stations/{station_id}/issue-token/` | 새 토큰 발급 또는 이전 자격 회수 후 재발급 |
| `POST /api/field/v1/stations/{station_id}/revoke-token/` | 현재 활성 자격 회수 |

현황과 예외는 `business_date`와 선택 `station`을 받는다. 기록은 업무일 양 끝을 포함하는 `from`·`to`와 `station`, `app`, `type`, `result`, `reason`, `mode`, `barcode`, `serial`, `part_no`, `job_id`, `cycle_id` 정확 필터를 받는다. 기록 목록을 이어 볼 때 같은 검색 조건과 받은 `next_cursor`를 사용한다. CSV의 한도를 넘으면 기간이나 장비 범위를 좁힌다.

발급 응답은 `{station_id, token}`을 전달하고 캐시를 막는다. 현장 연결용 JSON에는 `server`, `station_id`, `token`을 사용한다.

## 관측과 예외

접속 상태는 최신 heartbeat 경과시간 기준 `online`(3분 이내), `stale`(15분 이내), `offline`, `never`다. 이벤트는 자체 발생 증거로 집계한다. 장치 상태에는 실제 마지막 입력 시각을 표시한다. 미송신 기록이 있고 가장 오래된 건이 30분을 넘거나 outbox가 `blocked` 또는 `storage_pressure`이면 송신 적체를 표시한다.

업무 예외는 생산 모드의 유효한 바코드 NG, 계량 허용 범위 초과, 인쇄 불확실·확정 미송신, 비전 가림 미확정·작업 중단·장애, 촬영 쌍 미완료, UV 실패를 표시한다. 인쇄 제출 30분이 지나도 같은 작업에서 이어진 정상 재리딩이 없으면 출력 후 재리딩 미확인으로 표시한다. 외부 라벨 판독은 작업을 완료시키지 않는다. 동일 세션의 백커버 제품에 확정과 미완료 기록이 함께 있으면 원본을 검색에 보존하고 집계는 판정 충돌 예외로 표시한다.

운영 예외에는 생산 중 test/demo/manual 이벤트, 장치 단절·오류, 송신 적체, PC 시계차, 중복 송신기, 최신 접속 끊김을 표시한다. 연결 신호가 생산 가동을 증명하지 않는다. 시도 수 보기는 실물 불량률이나 검사 정확성으로 표시하지 않는다.

## 화면과 검증

[사출 현장 모니터링](../../frontend/src/pages/injection/FieldMonitoringPage.tsx)에 현황, 예외, 기록 검색, 관리자용 현장 PC 관리를 제공한다. 화면은 서버에서 계산한 상태와 경고를 표시한다. 관리자가 토큰을 발급한 경우 한 번 표시하고 토큰과 로컬 에이전트용 연결 JSON을 복사할 수 있다.

[합성 station 송신 도구](../../scripts/field-monitoring-synthetic-station.py)는 loopback 서버에서만 실행한다. 격리 서버의 superuser로 예제 앱을 모두 사용하는 합성 PC를 등록하고 자격을 발급한다. 아래 명령의 연결 JSON에는 `server`, `station_id`, `token`이 필요하다. JSON이 있는 임시 파일을 인자로 넘기거나 `--connection -`로 표준입력에서 읽을 수 있다.

```sh
python3 scripts/field-monitoring-synthetic-station.py --server http://127.0.0.1:8000 --connection -
```

도구는 인쇄까지 진행된 정상 라벨과 재리딩 미확인 작업, 비전·UV 및 비생산 이벤트를 저장하고 업무일 경계 전후를 구분한다. 첫 묶음 ACK 유실을 가정해 같은 바이트의 요청을 다시 보내고, 다른 묶음 ID에 같은 이벤트를 넣어 중복 카운트를 확인한다.


## 라벨 발급 등록부

`0002_issuer_registry`는 기존 이벤트에 검증 가능한 라벨 네임스페이스·발급 날짜 인덱스 정보를 추가하고 발급 배정 이력을 보존한다. PostgreSQL에서는 네임스페이스·품번별 트랜잭션 잠금과 해제 전 행의 부분 고유 제약을 함께 사용한다. 배정·중지·해제·PC별 정책 내보내기는 superuser의 현장 PC 관리 기능이다. 배정 중지 단계는 해당 PC 파일의 허용 목록에서 품번을 빼고, 서버는 최신 정책 일치 및 수신 완료를 확인한 뒤 해제한다.

두 PC의 예약 검토는 선택 업무일과 인접 업무일에서 네임스페이스·품번·인쇄 날짜가 일치하는 확정 예약을 찾는다. 기존 배정과 새 배정의 구간과 시리얼 증가가 함께 확인되면 순차 이전으로 본다. 중량 시험 모드도 같은 라벨 번호를 예약할 수 있으므로 이 검사에 포함한다. 정상 스캔·재리딩 의심은 선택 업무일의 같은 바코드 증거를 사용하며 양쪽 PC 기록을 조회할 수 있다. 시계 보류 기록은 날짜 기준 경보에서 제외하며 원본 조회로 검토한다.
