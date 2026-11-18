# 비전 기록 수집

설치 담당자가 해당 PC에서 관측할 원본만 선택한다. 비전 원본 디렉터리는 에이전트 계정에 읽기 권한을 부여한다. 에이전트 데이터 디렉터리와 비전 기록 디렉터리는 별도로 둔다. 중앙 현장 PC 등록에도 같은 앱을 선택한다.

```json
{
  "backcover": {
    "history": "D:/vision-v49/data/history/history.sqlite3",
    "camera_mode": "unknown",
    "status_enabled": false
  },
  "capture": {
    "root": "D:/capture-output",
    "auto_mode": "unknown"
  },
  "uv": {
    "root": "D:/uv-output"
  }
}
```

```text
python -m field_agent configure --data-dir <data> --connection <연결 JSON> --vision-config <비전 원본 JSON>
python -m field_agent run --data-dir <data> --port 8769
```

상대 경로는 비전 원본 JSON의 위치에서 해석한다. 생략한 앱은 수집하지 않으며 빈 객체는 모든 비전 수집을 끈다. 구성 파일을 생략한 연결 갱신은 기존 비전 구성을 유지한다. 다음 실행 시 새 구성을 읽는다. 바코드 또는 중량 앱과 함께 실행할 수 있다.

| 원본 | 완료 기준과 모드 |
| --- | --- |
| 백커버 V49 | 읽기 전용 History의 반출 확정 OK·NG 또는 commit된 INCOMPLETE. 카메라 모드는 설치 확인 후에만 `production` 또는 `test`로 지정한다. 영상 파일 재생은 `preview`다. |
| 양면 촬영 | 날짜·품번 폴더의 최종 sidecar. 앞·뒤가 같은 쌍에서 확인되면 한 건으로 기록한다. 앞면만 저장됐으면 보류하고, 같은 면 중복 또는 두 면의 배정 충돌처럼 저장된 증거가 있을 때 미완료로 표시한다. 수동 촬영·배정은 `manual`, 시뮬레이션은 `demo`다. `auto_mode`는 WJ 배정이 일치하는 자동 촬영에만 적용한다. |
| UV 배치 | 출력 루트의 `manual`·`demo` 날짜 폴더 아래 최종 배치 디렉터리의 `result.json`. 배치 ID와 위치를 보존하고 재검사에서 생성된 새 ID는 별건이다. 두 모드 모두 생산 집계에서 제외한다. |

5초마다 별도 스레드에서 증분 조회한다. 파일 소스는 변경 폴더를 한 번에 최대 256개 항목 및 32개 후보 단위로 읽으므로 최초 연결 또는 틈 복구 직후에는 따라잡는 시간이 필요하다. 원장에 없는 과거 기록은 원본 삭제 후 복원할 수 없다. 오래된 파일의 제자리 변경을 전수 조사하지 않으며, 탐지된 삭제·교체·검증 실패는 수집 단절로 표시한다. 사진과 영상은 전송하지 않는다. 촬영은 sidecar의 SHA-256을 사용하고 UV는 원본이 사진 해시를 제공하지 않으므로 결과 JSON의 SHA-256을 사용한다.

V49의 `status_enabled`는 기본값이 `false`다. 켜면 고정된 loopback `/api/status`를 최대 60초에 한 번 읽어 카메라·신호등 상태를 반영한다. 검사 결과는 History에서 계속 읽는다. 백커버와 UV는 전체 화면이며 에이전트는 백그라운드로 동작한다. localhost의 비전 현황에서 소스 읽기와 실행기 확인을 별도로 본다. 실행기가 시작하고 PID 생성 시각까지 일치한 프로세스만 실행으로 확인한다.
