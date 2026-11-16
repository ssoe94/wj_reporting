# WJ 현장 앱 프로토콜 v1

2026-11-16 · 단계 A에서 확정한 구현 기준. 모든 새 현장 앱은 이 규약에 따라 관측 기록을 전송한다. 배포·현장 수락은 단계 H에서 별도로 확인한다. 예시의 장비, 값, 계정은 합성 데이터다.

## 적용 범위

현장 앱은 인터넷 단절 중에도 장치를 제어하고 기존 조건으로 판정·출력하며 로컬에 기록한다. 기존 양면 촬영 셀은 오프라인에서 명시적 수동 품번 모드를 제공한다. 검증된 중앙 배정이 필요한 새 작업의 시작과 이미 시작한 쌍의 완료에는 현행 배정 유효 조건을 유지한다. 장치 SDK/COM/RAW 인쇄는 현장 프로세스가 소유한다. 브라우저는 같은 PC의 `127.0.0.1`에서 정적 화면을 열고 상태는 SSE 등 가벼운 연결 하나로 받는다. 기존 비전 런타임은 유지하고 저장 경계에서 어댑터를 붙인다. 현장에서 오프라인으로 설치할 수 있도록 정적 자산과 런타임을 버전 폴더에 함께 배포하고, 해시를 확인한 뒤 작업 중단 시간에 교체한다. 복귀 시 기존 원장과 신규 스키마의 호환성을 확인한다.

현장 에이전트는 loopback에만 수신하고 Host 및 상태 변경 요청의 Origin을 확인한다. 서버로 나가는 HTTPS 송신기는 다른 실행 흐름에서 동작한다. 중앙 모니터링은 읽기·등록·기록 검색을 제공한다. 카메라·프린터·저울의 구동 판단에는 중앙 응답을 사용하지 않는다.

## 봉투, 식별 및 입력 제한

- `contract`는 `wj.field.v1`. `station_id`는 서버가 등록한 설치 식별자이고 `database_id`는 해당 PC 이벤트 원장 세대의 UUID다. 복구 이력이 분기되어 같은 키에 다른 이벤트가 생길 수 있으면 새 세대를 발급하고 서버에서 연속성 단절을 표시한다. 새 PC에 원장만 복제해 같은 station/database로 동시에 송신할 수 없다.
- 이벤트 키는 `(station_id, database_id, seq)`. `seq`는 세대 안에서 DB가 배정한 양의 단조 증가 정수(최대 `9007199254740991`)다. 전송 배치 안에서는 오름차순이며 유일하다. 롤백 등으로 생긴 간극을 손실 건수로 해석하지 않는다. 서로 다른 배치의 도착 순서는 바뀔 수 있다. 바코드, 실물 번호, 공정 참조는 검색·상관용이다.
- `batch_id`는 송신기가 생성하고 원장에 보존한 UUID. 배치 생성 시 UTF-8 JSON 바이트를 확정하고, 재시도 때 같은 바이트를 전송한다. 서버는 해당 station과 batch ID에 묶인 요청 SHA-256과 최초 ACK를 저장한다. 같은 ID와 같은 바이트는 최초 ACK를 반환한다. 다른 바이트면 `batch_conflict`로 묶음 전체를 거절한다.
- 새로운 batch 안에 기존 이벤트 키가 있으면 검증된 이벤트 객체의 의미를 비교한다. 객체 키 순서만 다른 경우는 같으며 문자열, 값, 형식 및 보존된 확장 필드가 다른 경우 `event_conflict`다. 비교용 파싱은 중복 객체 키, 비표준 수(`NaN`, `Infinity`), 부동소수 JSON 수를 거절한다. 측정 소수는 문자열로 기록한다. 이벤트 키 충돌은 원장 복구 또는 이중 송신 여부를 확인한다.
- UTF-8 `application/json`, 압축 없는 본문 최대 512 KiB(524,288 bytes), ingest는 1–200건, heartbeat도 같은 바이트 제한. 빈 배열, 중복 키, 잘못된 타입, 200건 초과는 받지 않는다. 장비 식별자는 ASCII 1–64자, 버전·코드 최대 64자, 원천 상태/품번/시리얼/참조 값 최대 128자, 바코드 최대 UTF-8 256 bytes. 초과 원천값은 로컬에 보관하고 원격에는 허용 범위의 오류 코드와 `source_value_omitted`를 남긴다. 업무 식별값을 조용히 자르지 않는다.
- `detail`은 UTF-8 JSON 객체 최대 2 KiB(2,048 bytes), 중첩 깊이 최대 4, 텍스트는 명시한 항목만 포함. `products`와 `evidence`는 아래 스키마의 별도 제한을 받는다. 익명화·저장 정책은 운영 활성화 전에 승인한다. 로그에는 토큰, 바코드 원문, 본문, 로컬 절대경로, 함부로 복사된 장비 설정을 남기지 않는다.

## 이벤트 필드

| 필드 | 의미 |
| --- | --- |
| `seq`, `type`, `occurred_at` | 필수. 이벤트 순번, 아래 이벤트 유형, 오프셋이 있는 ISO 8601 발생 시각(최대 ms). 표준 송신 표현은 `+08:00`. `received_at`은 서버 기록. |
| `app` | 필수. `barcode`, `weigh_label`, `vision_backcover`, `vision_capture`, `vision_uv`. 새 앱은 서버와 합의한 코드를 등록한다. |
| `app_version`, `agent_version`, `config_version` | 앱 버전, 송신 에이전트 버전, 판정에 쓴 설정의 버전/해시. 새 앱의 판정 이벤트는 모두 필수. 기존 기록에서 알 수 없는 값에는 null과 수집 출처를 명시한다. |
| `mode`, `result`, `reason`, `status_raw` | 모드, `ok/ng/error/info`, 아래 안정 코드, 원천 상태값. 상태가 기록된 경우 raw 보존. `ok`의 의미는 이벤트 유형으로 한정된다. |
| `part_no`, `barcode`, `serial`, `device` | 해당 시 기입. `device`는 물리 입력(`A/B/W/KEYBOARD/scale/printer/camera` 등)이다. 과거 호환 A/B 슬롯은 `detail.legacy_slot`에 보존하고 물리 입력을 모르면 null. 활성이 증명되지 않은 품번·장치·코드를 추정해서 채우지 않는다. |
| `ref` | 해당 시 `cycle_id`, `job_id`, `batch_id`, `pair_id`, `attempt_id`, `parent_attempt_id`, `source_key` 등을 사용. 최대 8개 키. 라벨은 작업 ID와 `detail.label_index`, 재인쇄·재검사는 새 attempt와 부모 참조. `source_key`는 원천 종류·세대·원천 ID를 연결하는 안정 키다. |
| `measure` | 값·단위 및 있으면 `expected`, `tolerance`; 숫자는 최대 32자의 유한 십진 문자열, 중량 단위 `g`, UV 면적 `%`. 저울의 raw status는 `detail.scale_status`로 보존. |
| `evidence` | 최대 4건의 `{ "kind", "id", "sha256" }` 목록. 해시가 아직 없으면 생략. 파일은 로컬 원본에 남기고 이미지 bytes, 경로, 프리뷰는 송신하지 않는다. |
| `detail`, `products` | 유형별 근거의 제한된 객체. `products`는 UV에서만 사용하며 위치별 판정이다. |

`mode`는 `production/test/demo/preview/manual`이다. 기존 자료에서 증거가 모자라면 어댑터만 `unknown`으로 보낸다. 운영 조건·설정이 확인된 로컬 실작업만 `production`이다. 화면 버튼, 수기 입력, 검증된 실운영이라는 개념은 별개다. 수동 입력·외부 배정 우회는 `manual`로 기록하고 카메라 영상 replay는 `test` 또는 `demo`다. UV의 수동 시운전도 파일럿 인수 전 `manual`이다. 물리 스캐너가 `KEYBOARD`로 들어왔다는 이유로 모드를 추정하지 않는다. 동일 앱에서 모드가 바뀌면 `mode.changed`를 남긴다.

서버는 Asia/Shanghai 기준으로 발생 시각의 08:00부터 다음 날 08:00 직전까지를 업무일로 계산한다. 예를 들어 `2026-01-02T07:59:59+08:00`는 1월 1일, `08:00:00`는 1월 2일이다. 레거시 naive 시간은 현장 시차 설정이 확인된 경우에만 오프셋을 붙이고 `detail.time_basis=legacy_local`을 남긴다. 시차 근거가 없으면 adapter에 보류한다. 문법상 유효하나 수신 시각보다 5분 넘게 미래이거나 최근의 최신 heartbeat에서 수신 시각과 PC 시각의 차이가 절댓값 5분을 초과한 상태가 확인되면 `clock_suspect`를 서버 메타로 저장한다. 지연된 이벤트에는 새 발생 시각을 붙이지 않는다. 의심 시각의 이벤트는 검토 대상으로 표시하고 자동 일 집계에서 보류한다. 의심 해제는 데이터 정정 기록 또는 근거에 바탕을 둔 별도 정책으로 처리한다.

## 이벤트 발행 경계와 reason 매핑

한 업무 결정은 해당 원장 또는 파일에서 확정된 뒤 1회 이벤트로 만든다. 같은 타입·같은 근거의 재전송은 새 이벤트를 만들지 않는다. 처음 본 상태만 있는 legacy 수집에 현재 설정이나 누락된 이전 상태를 재구성하지 않는다.

| type | 발행 경계와 필드 |
| --- | --- |
| `app.started`, `app.stopped` | 앱 세션 시작·정상 중지 시 `ref.cycle_id` 대신 `detail.session_id`. 강제 종료 시 임의의 정상 중지 이벤트를 만들지 않는다. |
| `device.state` | 연결/해제/오류의 변화 시 `device`, `detail.device_state`, `detail.last_input_at`(있을 때). 연결과 입력 검증을 각각 기록. |
| `mode.changed`, `config.applied` | 실제 적용 때 `detail.previous_mode`/`detail.previous_config_version`, 현재 값. 설정 파일 사본은 제외. |
| `operator.action` | 실제 반영된 초기화·복구·취소·재인쇄 승인·수동 작업·우회, `detail.action`, 필요한 `ref`, 기록된 원인. 기존 판정을 덮어쓰지 않는다. 재판정은 원 이벤트 키를 참조한 새 이벤트. |
| `backup.completed`, `backup.failed` | 검증을 마친 로컬 백업 또는 실패. `detail.backup_id`와 검사 상태. 백업 경로와 기밀 데이터 제외. |
| `scan.recorded` | A/B/ANY 바코드 판정 INSERT commit. 바코드, device, 있음이 확인된 제품군/기대 장치 및 `ref.source_key`. 단순 입력 오류는 신규 앱 `device.state` 또는 실제로 커밋된 오류 시도로 구분. |
| `weigh.result` | 한 안정 적재의 PASS/NG 결정 및 지속 기록. `ref.cycle_id`, g의 실제/기준/허용폭, `detail.quantity`, `detail.rule`. 기존 DB는 예약 성공에 딸린 PASS만 복원 가능. 빈 저울·불안정·latched는 시도에서 제외. |
| `label.reserved` | 시리얼·작업·고정 payload 예약 commit 후 작업당 1건. `ref.job_id`, `ref.cycle_id`(있을 때), `detail.quantity`, `detail.payload_sha256`. 개별 시리얼은 로컬 작업과 연결. |
| `label.dispatched` | 실제 전송 시도 결과의 commit 후 1건. `ref.attempt_id`, 작업 ID 또는 물리 인쇄 행 ID(`detail.row_id`), 최대 3개 `detail.job_ids`, `detail.quantity`, `detail.delivery_status`. 같은 물리 행의 시도를 회원 작업에 각각 더하지 않는다. |
| `label.reread` | 재리딩과 중복/라벨 확인 트랜잭션 commit. 바코드, `ref.job_id`(현장 발급 시), `detail.label_index`, `detail.label_origin=local/external/unknown`, 입력 출처, 기대 장치. 외부 라벨 `ok`는 해당 PC 출력 건의 닫힘으로 집계하지 않는다. |
| `queue.partial_flush` | 운영자가 잔량 인쇄를 선택한 뒤 물리 행의 `flush_note`와 멤버가 저장된 시점. 행 ID, 실제 라벨 수, 열 수, 허용한 조작 코드. 배치 대기·버튼 눌림 자체는 발행 경계가 아니다. |
| `vision.cycle` | 백커버 반출 확정 OK/NG 또는 진행 중단 INCOMPLETE가 History에 commit된 때. `ref.cycle_id`(세션 포함 연결), camera/video 출처, 프로필 버전/해시, 증거 ID. 반출 전 `WORK_RECORDED`는 최종 제품 수에서 제외한다. 기존 백커버의 History commit 후 safety checkpoint 교체 전에 중단되면 같은 제품의 확정과 재시작 INCOMPLETE가 모두 남을 수 있다. 원장행 키로 각각 보존하고 제품 단위 충돌을 예외로 표시하여 확정 집계를 보류한다. |
| `capture.pair` | 앞·뒤 두 sidecar가 모두 보존된 쌍의 `complete`, 또는 재시작 등으로 쌍 누락이 확정된 `incomplete`. `ref.pair_id`, 앞/뒤 evidence, `detail.assignment_source`와 당시 배정 품번(있을 때). |
| `capture.single` | 단독 촬영 sidecar의 최종 publish. `detail.capture_id`, evidence 및 당시 배정 출처. 쌍 완료 대수에서 제외. |
| `vision.batch` | UV 임시 폴더에서 최종 폴더 rename 완료 후 한 배치 1건. `ref.batch_id`, recipe 버전, `products`는 현재 1–10 범위 위치가 유일한 **10개** 객체. 각 `{position, barcode, result, reasons, point_1_percent, point_2_percent}`로 `reasons` 최대 5개, 측정값은 0–100 십진 문자열. 품목·배치·제품 수를 분리. 키 충돌 없이 같은 배치 재검사는 새 attempt만 만든다. |

원천 상태는 아래를 기본 매핑으로 쓴다. 안정 reason은 번역하거나 상세 메시지에서 만들지 않는다. 새 코드가 필요하면 같은 유형에서 확장하고 다음 버전의 매핑에 기록한다. 레거시의 알 수 없는 상태는 `info/source_status_unknown`으로 분리한다.

| 앱·원천 상태 | `result/reason` |
| --- | --- |
| 바코드 `ok` / `정상` | `ok/scan_match` |
| 바코드 `duplicate` / `중복` | `ng/scan_duplicate` |
| 바코드 `invalid` / 기존 유효하지 않음 문구 | `ng/scan_invalid` |
| 바코드 `over21` / 길이 초과 별칭 | `ng/scan_overlength` |
| 바코드 `wrong_product_group` / 생산군 불일치 별칭 | `ng/scan_wrong_product_group` |
| 바코드 `wrong_scanner_A/B` / 기존 스캐너 오류 문구 | `ng/scan_wrong_device` + 기대 스캐너 |
| 바코드 기록된 구버전 `scan_error`, `오류`, `에러` | `error/scan_input_error` |
| 계량 `accepted/rejected` | 각각 `ok/weight_within_limit`, `ng/weight_outside_limit`. 저장 오류는 `error/local_record_error` 별도. 0점 이하 등 중량 부재로 명시된 거절은 `ng/weight_at_or_below_zero`. 기존 수량 선택과 빈저울 재무장, 허용폭 미만 판정을 유지. |
| 라벨 `prepared/waiting` 예약 성공 | `info/label_reserved`. `dispatching`은 전송 진행 상태. 재시작으로 결과 미확정 시 복구 경로의 `uncertain`. |
| 라벨 `submitted` / 안전한 `not_sent`·명시 거절 / `uncertain` | 각각 `info/print_submitted`, `error/print_rejected_unsent`, `error/print_uncertain`. `submitted`는 transport 수락. 실제 인쇄·부착은 실물 확인 필요. 불확실한 건 자동 인쇄 재시도 금지. |
| 라벨 `cancelled`, 조정·잔량 승인 | `info/label_cancelled`, `info/operator_reconciled`, `info/partial_flush_approved`. 취소로 시리얼을 재사용하지 않는다. |
| 재리딩 `ok` | `ok/reread_match`. 현장 발급 건과 외부 라벨은 origin으로 분리. |
| 재리딩 `duplicate/invalid/invalid_label_code/unknown_barcode` | 각각 `ng/scan_duplicate`, `ng/scan_invalid`, `ng/label_invalid_code`, `ng/label_unknown`. |
| 재리딩 `wrong_part/wrong_scanner_A/B/unprinted` | 각각 `ng/reread_wrong_part`, `ng/scan_wrong_device`, `ng/label_not_submitted`. |
| 재리딩 `uncertain/review_required/ledger_error` | 각각 `error/print_uncertain`, `info/label_review_required`, `error/local_record_error`. |
| 재리딩 `manual_entry/test_scan` | `info/manual_input`, `info/test_input`. 모드는 raw 이전에 실제 출처로 판별. |
| 백커버 `OK/NG` | `ok/occlusion_confirmed`, `ng/operation_not_confirmed`. 중앙 사각 홈 가림 검출이며 깊이/삽입 정도는 실물 검증의 대상이다. |
| 백커버 `INCOMPLETE` | `error/vision_incomplete`; `detail.cause`에 확인된 `application_restarted`, `inspection_stopped`, `frame_time_discontinuity`, `exit_confirmation_timeout`, `lighting_lost_product_boundary`, `product_boundary_unconfirmed`, `device_fault` 등. 보존 코드는 알려진 접두로 매핑하고 그 밖은 `unknown`. |
| 백커버 runtime `FAULT` | `device.state`의 `error/vision_device_fault`(장치 문제) 또는 `error/vision_runtime_fault`(논리/품질 등). active cycle에 남겨진 INCOMPLETE와 같은 제품 판정으로 두 번 합산하지 않는다. `WAIT_*`, `IDLE`, `COVERING`, `WORK_RECORDED`, `EXIT_PENDING`, `LIGHTING_HOLD`, 런타임 `NG`는 상태 표시 자료. |
| 백커버 `RECOVERY/RESET/CAMERA_SETTING/BENCH_EXPOSURE_SETUP` | `info/vision_recovery`, `info/operator_reset`, `info/config_applied`, `info/bench_setup`의 조작/설정 이벤트. 활성 프로필의 실제 변경만 `config.applied`. |
| 촬영 쌍 `complete/incomplete`, 단독 저장 | `info/capture_pair_saved`, `error/capture_pair_incomplete`, `info/capture_single_saved`. 쌍 완성은 두 장의 파일 commit 관측이다. |
| UV `passed=true/false`, 저장 실패 | 배치 `ok/uv_batch_pass`, `ng/uv_batch_fail`. 제품 `ok/ng`의 reasons는 `point_1/point_2/unreadable/multiple/duplicate` 중 관측된 원천 코드. 실패로 최종 폴더가 없으면 배치 결과를 합성하지 않고 장치/저장 오류를 별도로 기록. |
| 공통 시작·종료·변경·백업 | `info/app_started`, `info/app_stopped`, `info/device_state_changed` 또는 `error/device_fault`, `info/mode_changed`, `info/config_applied`, `info/operator_action_recorded`, `info/backup_verified`, `error/backup_failed`. |

## API와 인증

운영은 HTTPS. 테스트용 HTTP는 격리된 loopback fixture에만 사용한다. 장비는 `Authorization: WJField <token>` 전용 헤더를 사용하며, JWT 사용자 인증과 분리한다. 등록 시 서버가 충분히 무작위인 토큰(예: 32바이트)을 한 번만 반환한다. 공개 키 ID로 토큰 레코드를 찾고 서버에는 비밀값의 해시만 저장해 시간 일정 비교를 수행한다. 토큰은 한 station에 묶고 요청 station과 일치해야 한다. 폐기·재발급 이력을 남기고 폐기한 토큰은 데이터나 heartbeat를 변경할 수 없다. 일반 사용자 요청에 토큰과 해시가 노출되지 않게 한다. 송신기는 redirect를 따르지 않는다.

`POST /api/field/v1/ingest/` 요청 예시.

```json
{
  "contract": "wj.field.v1",
  "batch_id": "11111111-1111-4111-8111-111111111111",
  "station_id": "SYNTH-STATION-01",
  "database_id": "22222222-2222-4222-8222-222222222222",
  "events": [
    {
      "seq": 12, "type": "weigh.result", "occurred_at": "2026-01-02T08:10:00+08:00",
      "app": "weigh_label", "app_version": "1.0.0", "agent_version": "1.0.0", "config_version": "synthetic-r1",
      "mode": "test", "result": "ok", "reason": "weight_within_limit", "status_raw": "accepted",
      "part_no": "SYNTH-PART", "device": "scale", "ref": {"cycle_id": "SYNTH-CYCLE-12"},
      "measure": {"value": "101.2", "unit": "g", "expected": "100.0", "tolerance": "5.0"},
      "detail": {"quantity": 1, "rule": "unit_5pct_sqrt_quantity_v1"}
    }
  ]
}
```

성공 응답 `200 OK`. 모든 이벤트를 검증하고 기존 이벤트와의 충돌을 검사한 뒤 새 이벤트, 중복 건수, ACK를 한 트랜잭션에 저장한다. 부분 수락은 제공하지 않는다. 동시 요청은 고유 제약 및 트랜잭션으로 직렬화하거나 충돌을 다시 판정한다.

```json
{
  "contract": "wj.field.v1",
  "batch_id": "11111111-1111-4111-8111-111111111111",
  "station_id": "SYNTH-STATION-01",
  "database_id": "22222222-2222-4222-8222-222222222222",
  "accepted": 1,
  "duplicates": 0,
  "max_seq": 12
}
```

송신기는 HTTP 200 + JSON, `contract/batch_id/station_id/database_id`, 정수 타입과 `accepted >= 0`, `duplicates >= 0`, `accepted + duplicates == events.length`, `max_seq == 이 묶음의 마지막 seq`를 모두 확인한다. `max_seq`는 서버의 전역 커서가 아니다. 일치하면 로컬에서 해당 묶음만 ACK 처리한다. 같은 ID의 정확한 재시도는 최초 ACK 그대로 반환하므로 새 이벤트가 다시 증가하지 않는다. 다른 배치의 동일 이벤트는 `duplicates`에 반영한다.

`POST /api/field/v1/heartbeat/`는 시작할 때, 기본 60초마다, 상태가 바뀌면 디바운스해 보낸다. 응답은 수신을 확인한다. 이벤트 ACK로 처리할 수 없다. 이벤트 묶음처럼 오래된 heartbeat를 큐에 쌓아 재생하지 않는다. 단절 후에는 최신 상태를 만든다. 한 station에서 관측 송신기는 하나다. `session_epoch`는 station에 바인딩된 송신 상태에서 재시작마다 영속적으로 1 증가하고 `heartbeat_seq`는 그 세션에서 매 전송마다 증가한다. 서버는 자격 세대와 이 두 순번의 순서로 최신 여부를 판정한다. 같은 순번·동일 heartbeat의 반복 및 이전 순번의 도착은 최근 접속 시각을 갱신하지 않는다. 동일 순번에 다른 ID/내용은 `409 heartbeat_conflict`, 카운터 복원 불가 시 station 자격을 회전해 새 자격 세대로 시작한다. 서버는 시계 추정과 무관하게 마지막 최신 상태와 수신 시각을 보존한다.

```json
{
  "contract": "wj.field.v1", "station_id": "SYNTH-STATION-01",
  "database_id": "22222222-2222-4222-8222-222222222222",
  "heartbeat_id": "33333333-3333-4333-8333-333333333333",
  "session_id": "44444444-4444-4444-8444-444444444444", "session_epoch": 2, "heartbeat_seq": 3,
  "started_at": "2026-01-02T08:00:00+08:00", "client_at": "2026-01-02T08:11:00+08:00", "agent_version": "1.0.0",
  "apps": [{"app": "weigh_label", "version": "1.0.0", "mode": "test", "state": "running", "last_work_at": "2026-01-02T08:10:00+08:00"}],
  "devices": [{"app": "weigh_label", "device": "scale", "state": "connected", "last_input_at": "2026-01-02T08:10:00+08:00"}],
  "outbox": {"pending_count": 0, "oldest_occurred_at": null, "last_ack_at": "2026-01-02T08:10:02+08:00", "state": "ready", "last_error_code": null, "coverage": "known"},
  "resources": {"disk_free_bytes": 4000000000, "ledger_bytes": 102400, "cpu_pct": "0.8", "rss_bytes": 33554432}
}
```

```json
{
  "contract": "wj.field.v1", "station_id": "SYNTH-STATION-01",
  "database_id": "22222222-2222-4222-8222-222222222222",
  "heartbeat_id": "33333333-3333-4333-8333-333333333333",
  "received_at": "2026-01-02T00:11:01Z", "current": true
}
```

장비와 앱 목록은 각각 최대 64개와 16개, 모르는 리소스와 마지막 수신은 null. `coverage`는 `known/partial/unknown`이며 `known`은 해당 에이전트 원장의 관측 범위다. `outbox.state`는 `ready/backoff/blocked/storage_pressure`, 장치는 `connected/disconnected/fault/unknown`, 앱은 `running/stopped/fault/unknown`. heartbeat는 연결 증거이며 현장 생산량 집계에는 커밋 이벤트가 필요하다. HTTP 수신 시각에서 PC 시각을 비교한 시계차는 네트워크 지연을 포함한 추정치로 표시한다.

| 응답 | 송신 처리 |
| --- | --- |
| `408/425/429/5xx`, 네트워크 실패 | 동일 묶음 유지. 지수 backoff + jitter, 최초 기준 2초·최대 기준 300초. 유효한 `Retry-After`의 초 또는 HTTP date보다 먼저 재개하지 않는다. |
| `400` (`invalid_payload`, `contract_unsupported`), `409` (`batch_conflict`, `event_conflict`, `heartbeat_conflict`), `413` (`payload_too_large`), `415` (`unsupported_media_type`) | 해당 묶음 보류. 응답은 최소화한 `code`, 필요 시 `event_index`. 원인 처리 뒤 합의된 재구성으로 새 batch ID를 발급할 수 있으며, 동일 이벤트 키에 내용을 덮어쓰지 않는다. |
| `401` (`invalid_token`), `403` (`station_denied`), `404`, 그 밖의 영구 4xx | 자동 재전송 중지, 로컬에 오류 기록. 정상 자격이 있는 경우만 가능한 heartbeat에 사유를 포함한다. |
| `3xx`, 예상 밖 2xx, invalid/mismatched ACK | 영구 확인 대기. HTTP 성공만으로 로컬에서 지우지 않는다. |

## 로컬 원장, 백업, 적합성

- SQLite WAL, 비동기 송신, 이벤트 UPDATE/DELETE 금지 트리거. 새 앱의 업무 기록과 이벤트는 같은 트랜잭션에 저장한다. 외부 파일 commit을 쓰는 앱은 최종 JSON/디렉터리의 안정 ID를 기준으로 작게 복구 조회해 크래시 틈을 메운다. 커서는 받은 자료와 이벤트 매핑을 저장한 뒤에만 전진한다. 저울이 검사 도중 출력 요청에 실패해도 이미 관측된 계량 결정과 출력 상태를 별도로 기록한다.
- legacy에서 스키마·세대·파일 교체를 감시한다. `mode=ro` 원장의 열린 연결에서 `data_version`을 읽고, 바뀐 경우 인덱스가 있는 `id > cursor`를 5–10초 주기로 제한 조회한다. `data_version`은 다른 연결 값과 비교하거나 세대 검증에 쓰지 않는다. 행 수정/삭제/파일 재생성/복원에 의한 관측 단절을 표시한다. 파일형 원장은 전체 재스캔 없이 날짜·경로 및 안정 ID로 제한 조회한다.
- 원본 포함 송신 전 데이터를 보존한다. ACK 후 outbox의 전송 메타는 정책에 따라 정리할 수 있다. 용량 경보 및 수집 불완전 상태를 제공한다. 디스크 부족/원장 오류 시 앱별 기존 작업 안전 기준을 따르고, 로컬 저장에 실패한 결과를 저장·전송 성공으로 표시하지 않는다. 장기 단절의 실제 보존 한도는 조사 뒤 확정한다.
- 유휴 시 하루 1회 SQLite online backup, `quick_check` 확인 후 완성 파일 교체. 30일 보관을 초기 제안으로 두고 용량·실제 복원 시험 후 확정한다. 비전 sidecar/선택 증거 파일은 별도 매니페스트가 필요하다. 원격 수신본은 조회용으로 쓰며 로컬 전체 DB/이미지 복원에는 별도 백업을 쓴다. 복원 시 원장 세대·sequence·미전송 배치의 일관성을 확인한다.
- 대표 PC에서 측정하는 초기 목표는 에이전트 평균 CPU <2%, RSS <120MB, 브라우저와 에이전트의 전체 추가 비용도 별도 비교, 전후 장치 처리 p95 지연이 늘지 않는지 확인. 원장 이외의 잦은 파일 쓰기나 전체 로그 반복 스캔 없이 제한된 주기·페이지로 전송하고 일일 백업을 시험한다. 수락 기준은 대표 PC 실측을 바탕으로 확정한다.
- `wj.field.v1`의 호환 확장은 선택 필드 추가와 새로운 등록 앱/유형/사유 추가다. 송신 전 서버 수용을 확인하며 수신기는 허용 크기·형식의 선택 필드를 안전하게 보존한다. 알 수 없는 앱/유형의 이벤트는 검증 정책에 따라 보류하며 기본 KPI에 넣지 않는다. ID/ACK/필수 필드, 판정 의미, 도메인 정책의 비호환 변경은 새 계약과 경로를 사용한다. 원 판정 변경은 별도 원천 버전 및 업무 검증을 거친다.

새 현장 앱은 다음 항목을 통과해야 v1 적합으로 기록할 수 있다.

- [ ] 실제 장치 소유자가 하나이며 인터넷이 끊겨도 정상 작업·판정·출력·로컬 기록을 완료한다. 브라우저 재시작/닫기와 송신 오류가 검사 루프를 제어하지 않는다.
- [ ] 원 판정·중복·타임아웃·재작업 회귀를 가짜 장치와 승인된 실기 샘플에서 통과한다. 판정 정확성은 기준 샘플/교정/독립 확인으로 입증한다.
- [ ] commit 직전/직후 강제 종료, 리셋, 복원, 디스크 부족에서 저장·미저장 및 관측 범위가 표시된다. 백업으로 복원하고 전송 중복과 세대 충돌을 확인한다.
- [ ] ACK 유실, 같은 batch 재송신, 다른 batch의 같은 이벤트, 키 충돌, 429와 5xx, 영구 거절, 불일치 ACK에서 중복 집계와 원장 손실이 없다.
- [ ] 업무일 08:00 경계, 미래 시계, 재전송 지연, preview/demo/manual/unknown, 미완료·부분출력·불확실 상태의 집계가 예상과 같다.
- [ ] 토큰 격리/폐기, loopback 접근 제한, payload 제한, 로그/CSV 보안, 수집량과 CPU/RSS/디스크/처리 지연의 현장 시험을 통과한다.

## 단계 B 구현 제안

- 신규 Django 앱 `field_monitoring`. 최초 additive migration에 `FieldStation`, 장비 자격·회수 이력, `FieldIngestBatch`(`station,batch_id` unique), `FieldEvent`(`station,database_id,seq` unique), `FieldStationHeartbeat`(station별 최신 상태)를 추가한다. 이벤트에는 원천 JSON과 typed filter 필드를 둔다. 인덱스는 `(station,business_date,occurred_at)`, `(business_date,app,result)`, 제한된 품번/바코드/시리얼 정확 검색부터 사용한다. 사용량을 확인해 추가한다. MES·기존 현장 원장과 운영 DB 데이터 이관은 별도 결정한다.
- 신규 ingest/heartbeat, JWT `GET /api/field/v1/{overview,exceptions,events}/` 및 제한된 CSV, superuser `POST /api/field/v1/stations/`와 등록/회수/회전 액션. 최근 결과·접속·장치 입력·송신 지연을 분리 표시한다. `mode=production`과 검증된 시간/수집 범위에서만 생산 시도 지표를 만든다. MES shot은 참고이며 검사 모집단은 별도 근거로 확인한다. 분모가 없으면 누락률과 검사 정확성은 미확인으로 표시한다.
- 조회는 활성 superuser 및 명시적으로 승인된 사출 운영 조회 권한으로 시작한다. 현장 단말은 사람 API에서 거부하고 station 등록·회수는 활성 superuser로 제한한다. 경로 권한과 서버 조회 권한을 일치시킨다. 기존 [현장 기록 집계](../../backend/analytics/field_operations.py)는 MES·수기 체크포인트의 업무일/검증 패턴 참고용. [AI 토큰 권한](../../backend/ai_core/views.py)의 사람-기계 분리 원칙을 따르고 공통 설정 토큰 대신 PC별 자격을 쓴다.
- [사출 메뉴](../../frontend/src/App.tsx) 아래 [준비 페이지](../../frontend/src/pages/injection/FieldMonitoringPage.tsx)에 현황·예외·기록검색·등록을 제공한다. 기존 `/field` 단말 및 `/mes/monitoring` 설비 모니터링은 각자의 목적을 유지한다. 단계 B의 수락은 격리 Django·프런트에서 가짜 장비로 인증·재전송·중복·ACK 및 한 업무일 검색까지 확인한다.
