# Windows 현장 앱 배치

관리자가 PC 설치 때 배치를 지정합니다. 작업 중에는 같은 데이터 폴더를 쓰며 화면에서 배치를 바꾸지 않습니다. 아래 파일과 경로는 합성 예시입니다.

```json
{
  "profile": "split",
  "monitor": "primary",
  "agent_side": "left",
  "companion": {
    "kind": "capture_cell",
    "python": "C:\\ExampleVision\\.venv\\Scripts\\pythonw.exe",
    "work_dir": "C:\\ExampleVision"
  }
}
```

```text
python -m field_agent configure --data-dir <data> --connection <연결 JSON> --language zh --layout-config <위 배치 JSON>
start.cmd "<data>" "<중량 앱 JSON>" weigh
start.cmd "<data>" "<바코드 앱 JSON>"
start.cmd "<data>"
```

- `split`은 에이전트와 동반 앱을 서로 반대쪽에 엽니다. `agent_side`는 `left` 또는 `right`입니다.
- `companion_full`은 동반 앱을 모니터 작업 영역 전체에 엽니다. 백커버 지그에는 `backcover_v49`, UV 배치에는 `batch_inspection`을 지정합니다. 두 앱은 전체 화면 전용입니다. 에이전트의 로컬 서버는 계속 실행됩니다. 작업 화면이 필요할 때 바탕화면의 **WJ Field Agent** 바로가기를 누르면 설정한 쪽에 에이전트 앱 창을 엽니다. 기본 실행을 다시 호출하면 실행기가 식별한 에이전트 창만 최소화합니다.
- `agent_only`는 파일이 없는 기존 설치의 기본값입니다. `agent_size`는 `full` 또는 `half`입니다. 이 프로필에서는 `companion`을 생략합니다.
- `monitor`는 `primary` 또는 Windows 디스플레이 이름인 `DISPLAY2` 등의 값을 씁니다. 지정 모니터가 현재 없으면 주 모니터를 사용합니다. 위치는 작업표시줄을 제외한 Windows 작업 영역을 기준으로 계산합니다. Chromium에는 DPI 환산 크기를 시작값으로 전달하고, 실제 창 배치는 Win32에서 요청합니다. [Microsoft 작업 영역과 모니터](https://learn.microsoft.com/en-us/windows/win32/desktop/gdi/multiple-monitor-system-metrics) · [Win32 창 배치](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos)

레거시 수집을 배치와 같이 시작할 수 있습니다. 기존 수집기와 에이전트 둘 다 같은 PC에서 동작하는 경우 각각의 데이터 디렉터리와 장치 소유 여부를 확인합니다.

```text
python -m field_agent.launcher --data-dir "<data>" --legacy-barcode-db "<기존 앱>/data/barcodes.db"
python -m field_agent.launcher --data-dir "<data>" --legacy-weigh-dbs "<기존 앱>/production/scans.sqlite3" "<기존 앱>/production/production.sqlite3"
python -m field_agent.launcher --data-dir "<data>" --show-agent
```

`companion_full`에서 숨기는 것은 에이전트 창입니다. 사용 가능한 백그라운드 수집 종류는 현장 에이전트 명령과 동일합니다. [비전 읽기 전용 수집](VISION.md)에서 V49, 양면 촬영, UV의 원본을 지정할 수 있습니다.

## 동반 앱 종류

| `kind` | 설치 대상과 실행 | 언어 |
| --- | --- | --- |
| `backcover_v49` | `app.py`가 있는 V49 디렉터리와 해당 Python을 지정합니다. `app.py --no-browser`를 실행한 뒤 고정 포트 8724의 상태를 확인하고 별도 Chromium 앱 창을 엽니다. | V49 자체의 언어 메뉴와 브라우저 저장을 사용합니다. 원본에 시작 언어 인수가 없습니다. |
| `capture_cell` | 두 면 촬영 패키지 디렉터리와 해당 `pythonw.exe`를 지정합니다. `-m capture_cell --connect`로 시작합니다. | PC 설정에 맞춰 `--lang ko` 또는 `--lang zh_CN`을 전달합니다. |
| `batch_inspection` | `companion_full`에서 UV 배치 패키지 디렉터리와 해당 `pythonw.exe`를 지정합니다. `-m batch_inspection --connect`로 시작합니다. | 원본 실행기에는 시작 언어 인수가 없습니다. |

에이전트는 로컬 포트 8769를 쓰며 동일한 데이터 폴더 내 별도 Chromium 사용 디렉터리로 앱 창을 엽니다. 인식된 창이 이미 있으면 재사용합니다. 동반 앱을 강제 종료하거나 재시작하지 않습니다. 인식할 수 없는 동일 네이티브 실행 파일이나 점유된 V49 포트가 감지되면 기존 프로세스를 보존하고 화면에 대기·실패를 표시합니다. 실행기 교체 때 구형 런처가 열어 둔 브라우저 창은 작업 교대 중 닫고 새 실행기로 시작하세요. Windows가 포커스 이동을 허용하지 않으면 작업표시줄에서 앱을 선택합니다. [Windows 포커스 제약](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)


UV 배치 창의 원본 최소 크기는 1040×690 논리 px입니다. 높은 배율 또는 작은 디스플레이에서 전체 작업 영역이 그보다 작으면 배치 실패를 표시하고 동반 앱의 원래 위치와 실행 상태를 보존합니다. Win32 요청 뒤에는 대상 DPI의 허용 오차 안에서 실제 창 경계를 확인합니다.

## Windows에서 확인할 항목

- 설치 계정에서 Chrome 또는 Edge의 앱 모드, 전용 프로필, 화면 위치·전체 또는 반폭, 축소된 창 열기
- 단일 및 다중 모니터, 100%·125% 배율과 작업표시줄 위치, 디스플레이 제거 뒤 주 모니터 선택
- 실제 PySide6 창의 최소 크기와 포커스, 중복 실행 방지 및 느린 시작/장치 오류의 분리
- V49의 전체 작업 영역과 상태 서버, 바로가기 한 번 열기, 창을 닫은 뒤 백그라운드 전송 유지
- 장치 연결, 적합한 언어와 부저, 기존 정상 작업을 종료하지 않는지 현장 교대 중 확인

현재 앱 배치 시험은 Linux/macOS에서 모의 창·프로세스·Win32 호출 및 합성 원장/전송기로 수행합니다. 실제 Windows 창과 비전 장비는 이 단계의 별도 실기 항목입니다.
