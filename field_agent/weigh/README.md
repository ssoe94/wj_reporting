# 중량·라벨·재리딩 E1 실행

저울, 프린터, 스캐너, 신호등은 에이전트에서 연결한다. 브라우저는 127.0.0.1에서 제품 선택, 판정, 인쇄 상태, 재리딩과 작업자 조치를 제공한다. ZPL·TSPL 레이아웃은 승인된 로컬 설정을 사용한다. 프린터로 전송한 바이트가 수락되어도 실물 출력·박리·부착·재리딩은 각 근거로 확인한다.

## 합성 설정과 실행

저장소 또는 릴리스 루트에서 아래 합성 JSON을 별도 데이터 폴더의 규칙 파일에 저장한다. 실제 앱의 보정·품번·출력 설정은 현장 담당자가 해당 PC에 전달한다.

```json
{
  "mode": "test",
  "site_code": "S",
  "vendor_code": "YN",
  "selected_part": "TST10000001",
  "products": [
    {
      "part_no": "TST10000001",
      "name": "Synthetic",
      "model": "55",
      "unit_weight_g": "20",
      "calibration_g": ["20", "40", "60", "80", "100"],
      "calibrated_at": "2026-01-02T08:00:00+08:00",
      "scanner": "A",
      "columns": 1,
      "peel": false,
      "template": {
        "language": "zpl",
        "prefix": "^XA",
        "cells": ["^FO10,10^BY2^BCN,60,Y,N,N^FD{barcode}^FS"],
        "suffix": "^XZ"
      }
    }
  ]
}
```

```text
python -m field_agent configure --data-dir <data> --connection <연결 JSON>
python -m field_agent run --data-dir <data> --weigh-config <규칙 JSON> --weigh-fake
```

합성 모드는 시험 이벤트를 남긴다. stdin에서 JSON 한 줄씩 받아 저울·스캐너·프린터·박리를 시험한다. 예를 들어 `{"type":"scale","grams":"0"}`을 0.1초마다 1.3초 이상 보내 빈 저울을 안정화한 뒤 `{"type":"scale","grams":"20"}`을 같은 주기로 보낸다. `{"type":"scan","device":"W","barcode":"TST..."}`의 바코드는 합성 예약에 실제로 생성된 값을 사용한다. `{"type":"printer","outcome":"rejected_unsent"}` 또는 `"uncertain"`으로 다음 출력의 실패를 지정하고, `{"type":"peel","waiting":true}`로 가상 박리 상태를 설정한다.

## 현장 시범 구성

- 실기 경로는 `--weigh-fake`를 뺀다. Windows 런처는 `start.cmd "<data>" "<규칙 JSON>" weigh`로 연다. 대상 PC에서 시리얼 포트 배정과 프린터 언어를 확인한다.
- `devices.scale`의 `port`에 저울 포트를 지정한다. `devices.scanner`의 `ports` 또는 `identities`에 A/B/W를 배정하고, 필요 시 `auto_detect`를 사용한다. 저울과 신호등 포트는 스캐너 후보에서 제외한다.
- `devices.printer.printer_mode`는 `idprt_usb`(USBPRINT 네이티브 ZPL), `windows_raw`(Windows RAW spooler), `tcp`(기본 9100) 중 선택한다. 각각 `idprt_device_path`, `windows_printer`, `printer_host`·`printer_port`로 대상을 지정한다. `devices.signal.light_mode`는 `k50l_serial`, `patlite_usb`, `virtual` 중 선택한다. 필요에 따라 `light_serial_port` 또는 `light_device_path`를 사용한다. 시리얼·HID 의존성과 Windows 드라이버는 해당 릴리스에 검증된 버전으로 제공한다.
- 템플릿의 `cells`는 실제 열 수와 맞춘다. 셀에는 `{barcode}`와 선택적으로 `{part_no}`를 넣는다. ZPL은 한 쌍의 `^XA`·`^XZ`, TSPL은 마지막에 한 번의 `PRINT 1,1`을 사용한다. 센서가 있는 박리 경로는 대기 감지 뒤 준비 상태가 와야 다음 행을 보낸다. 센서 증거를 읽을 수 없는 경로는 실물 제거를 작업자가 확인한다.
- 같은 PART·날짜에 기존 앱이 시리얼을 이미 예약했다면 현장 전환 때 양쪽 원장을 대조한다. 신규 원장의 첫 예약 전에 `serial_floors`를 `{"<PART>":{"YYYY-MM-DD":100}}` 형태로 설정한다. 수치는 마지막 사용·예약 번호다. 기존 앱은 한 번에 하나의 앱이 같은 시리얼 범위를 발급하도록 종료한다.
- 재시작 후 대기건은 작업자가 재개한다. 불확실한 행에는 확인한 실물 수량을 입력한다. 확인한 수량이 행 전체보다 적으면 개별 라벨은 검토 대상으로 남는다. 박리 대기 해제와 후속 큐 재개는 각각 의도적으로 수행한다. 잔량은 작업자 승인 후 한 행을 고정해 출력한다.

## 교체 전 병행 수집

```text
python -m field_agent run --data-dir <data> --legacy-weigh-dbs "<기존 앱>/production/scans.sqlite3" "<기존 앱>/production/production.sqlite3"
```

에이전트는 읽기 전용 스냅샷에서 새 스캔·예약·전송 및 확인 상태만 가져오고, 원장 커밋과 함께 커서를 전진시킨다. 구버전 원장에 남지 않은 계량 NG나 폴링 사이의 미관측 변화는 수집 범위에 포함할 수 없다. 모드·원래 시각 등 증거가 없는 필드는 별도로 표시한다.
