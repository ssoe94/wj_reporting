# Ted_SSD 품질 미디어 로컬 아카이브

프런트엔드나 Render가 Mac에 직접 연결되지 않은 상태로, 현재 `QualityReport`가 참조하는
Cloudinary 품질 사진과 인증된 품질 import API의 정규화·중복 제거 사진 asset을 로컬
SSD에 보존하는 도구입니다. 서버 import에 쓰인 Excel 원본과 chunk는 일회성 임시
입력으로, 처리 후 삭제되며 수동 archive 및 API sync 대상이 아닙니다.

브라우저에 발급된 Cloudinary upload 서명은 발급 후 최대 1시간 재전송될 수 있습니다.
서버는 정규화 결과 저장을 검증한 뒤 raw object를 먼저 삭제하고 현황을 READY로 전환하되,
`public_id`만 바이트가 없는 tombstone으로 65분간 유지합니다. worker cleanup은 서명 만료 후
같은 ID를 한 번 더 삭제한 뒤 tombstone을 제거합니다. `source_discarded_at`은 최초 raw object
삭제가 확인된 시각이며, 서명 만료 후 2차 삭제까지는 `discard_pending` 상태로 별도 추적됩니다.
어느 단계에서도 Excel 원본 다운로드 API나 Ted_SSD 원본 보관 경로는 제공하지 않습니다.

## 고정 저장 계약

저장 root는 CLI에서 변경할 수 없습니다.

```text
/Volumes/Ted_SSD/WJ_DATA_CENTER/quality_media_archive
```

```text
quality_media_archive/
├── objects/sha256/aa/bb/<sha256>       # Cloudinary 정규화 이미지의 검증된 바이트
├── manifests/items/aa/<event_id>.json  # 콘텐츠 + 출처 provenance
├── manifests/runs/<run_id>.jsonl       # 실행별 결과
└── state/
    ├── archive.lock                    # 단일 writer / verify lock
    └── staging/                        # 같은 볼륨의 임시 파일
```

객체 경로는 콘텐츠 SHA-256으로만 결정됩니다. 같은 바이트는 출처나 파일명이 달라도
한 번만 저장되고, 출처별 event manifest가 별도로 남습니다.

이 root와 manifest는 **local-only**입니다. event manifest에는 Cloudinary delivery
URL이 포함될 수 있으므로 웹 서버, 공개 API, 공개 동기화 폴더에 노출하면 안 됩니다.
이 도구는 backend/frontend/API에 manifest를 전송하지 않습니다.

API sync는 Mac에서 서버로 outbound HTTPS만 사용합니다. 브라우저와 Render 서버가
`Ted_SSD`를 mount하거나 Mac의 파일 경로를 알 필요가 없습니다.

## 기존 시스템에서 확인한 범위

- 품질 사진은 `QualityReport.image1`, `image2`, `image3`에 Cloudinary URL로 저장됩니다.
- 현재 `QualityReport`에는 승인 상태 필드가 없습니다.
- 수동 archive 모드는 credential이나 DB를 직접 읽지 않고, 사용자가 별도로 준비한
  **완전한 현재 QualityReport JSON export**를 입력으로 받습니다.
- API sync 모드는 별도의 최소권한 사용자 bearer token으로 reports/import asset API를
  페이지 끝까지 읽습니다. token은 환경변수에서만 읽고 CLI 인자, stdout,
  error, object/event/run manifest에 기록하지 않습니다.
- export에 참조된 URL은 `current_quality_report_reference`로 기록되며, 승인 상태는
  `not_modeled_in_current_schema`로 명시됩니다. 승인 사실로 바꾸어 기록하지 않습니다.

## 안전 특성

- 기본 동작은 dry-run입니다. 파일을 만들지 않고 Cloudinary에도 접속하지 않습니다.
- 실제 저장은 명시적 `--apply`에서만 수행됩니다.
- 마운트가 없거나 쓰기 불가, symlink 경로, 불완전한 페이지 export이면 중단합니다.
- Cloudinary는 정확히 `https://res.cloudinary.com/.../image/upload/.../quality/...` 또는
  SHA-256으로 이름 붙은 관리 경로 `.../quality-import/assets/<sha256>`만 허용합니다.
  credential/query/fragment/custom port, redirect, 비공개 DNS 주소를 거부합니다.
- 응답은 최대 50 MiB이며 HTTP image MIME과 JPEG/PNG/WebP/GIF/BMP/TIFF/AVIF/HEIC signature를
  모두 검사합니다.
- 다운로드 임시 파일은 최종 object와 같은 ExFAT 볼륨에 만들고 `fsync` 후
  `os.replace`합니다. 이동 후 SHA-256과 크기를 다시 읽어 검증합니다.
- 실행이 중단되면 다음 `--apply`가 lock을 잡은 뒤 이 도구의 남은 `archive-*.part`만
  정리합니다. object 저장 후 manifest 전에 중단된 경우 같은 입력을 재실행하면
  기존 object를 검증·재사용하여 event manifest를 완성합니다.
- 예상하지 않은 staging 파일은 자동 삭제하지 않고 무결성 오류로 중단합니다.
- 입력 JSON export는 수정·이동·삭제하지 않습니다.
- secret 파일, `.env` 파일, Cloudinary API key/secret을 탐색하지 않습니다. API sync에
  명시적으로 제공된 bearer 환경변수도 출력하거나 manifest에 저장하지 않습니다.
- API sync의 bearer는 구성된 API origin에만 전송합니다. Cloudinary 다운로드에는 bearer를
  보내지 않으며 redirect, 다른 origin, HTTP, credential이 포함된 URL을 거부합니다.
- 모든 list 페이지를 count와 대조하여 먼저 수집한 다음 archive 쓰기를 시작합니다.
- import 사진은 서버가 제공한 SHA-256, byte size, MIME과 image magic을 모두
  검증합니다. object를 다시 hash한 뒤에만 `mark-*-mirrored`를 POST합니다.
- mark POST가 실패해도 콘텐츠와 manifest는 남습니다. 다음 실행은 같은 SHA object를
  재사용하고 acknowledgement만 안전하게 재시도할 수 있습니다.

## 입력 계약

### 현재 QualityReport export

DRF의 한 페이지가 아니라 전체 결과여야 합니다. `next` 또는 `previous`가 남아 있으면
부분 백업을 막기 위해 실패합니다. 각 행에는 `id`, timezone을 포함한 `updated_at`,
`image1..3`이 필요합니다.

[`examples/quality_reports.current.example.json`](examples/quality_reports.current.example.json)을
참고하세요. 실제 export에 access token이나 request header를 넣지 마세요.

## 실행

드라이브 상태 확인은 읽기 전용입니다.

```bash
python3 tools/quality_media_archive/quality_media_archive.py status
```

먼저 dry-run 결과를 검토합니다. 이 명령은 네트워크·디스크 쓰기를 하지 않습니다.

```bash
python3 tools/quality_media_archive/quality_media_archive.py archive \
  --quality-reports-json /absolute/path/quality-reports-current.json
```

검토한 동일 입력을 실제로 보관합니다.

```bash
python3 tools/quality_media_archive/quality_media_archive.py archive \
  --quality-reports-json /absolute/path/quality-reports-current.json \
  --apply
```

전체 manifested object를 다시 해시하고 event/run manifest와 orphan object를 검사합니다.
ExFAT에서 macOS가 자동 생성하는 AppleDouble(`._*`)과 `.DS_Store` 메타데이터는
업무 객체가 아니므로 검증 대상에서 제외합니다.

```bash
python3 tools/quality_media_archive/quality_media_archive.py verify
```

## 인증 API sync

현재 backend 계약을 다음 순서로 완전 pagination합니다.

1. `GET /api/quality/archive/reports/` — 현재 `image1..3` Cloudinary 참조만 제공하는 축소 응답
2. `GET /api/quality/archive/assets/?mirror_state=pending` — 아직 mirror되지 않은 중복 제거 사진 asset
3. 인증된 `content` 다운로드 및 Ted_SSD hash archive
4. object hash 재검증 후 asset의 `mark-mirrored` POST

`QualityReport`에는 mirror 상태가 없으므로 별도 POST를 하지 않습니다. 매 실행에서 현재
참조를 다시 확인하되, URL·`updated_at`·출처가 같은 기존 manifest의 로컬 객체 hash가
일치하면 Cloudinary 재다운로드를 생략합니다. 변경되거나 새로 추가된 참조만 원격에서
받고, 동일 bytes는 content-addressed object/event로 dedupe됩니다.

먼저 아무 환경변수 없이 dry-run할 수 있습니다. 이 명령은 환경 credential을 읽지 않고,
네트워크 요청이나 SSD 쓰기도 하지 않습니다.

```bash
python3 tools/quality_media_archive/quality_media_archive.py sync
```

실제 실행 시에만 아래 두 환경변수가 필요합니다. token은 CLI 옵션으로 받을 수 없습니다.
아래처럼 hidden prompt로 입력하면 명령행 history에 token 값이 남지 않습니다.

```bash
export WJ_QUALITY_ARCHIVE_API_BASE_URL='https://wj-reporting.onrender.com'
read -rs 'WJ_QUALITY_ARCHIVE_BEARER_TOKEN?Quality archive bearer token: '
export WJ_QUALITY_ARCHIVE_BEARER_TOKEN
python3 tools/quality_media_archive/quality_media_archive.py sync --apply
unset WJ_QUALITY_ARCHIVE_BEARER_TOKEN
```

token 계정에는 품질 import read/mirror acknowledgement에 필요한 최소권한만 부여해야 합니다.
운영 token을 source code, `.env`, launch agent plist, shell history에 평문으로 저장하지 마세요.

## 매일 23:30 로컬 스케줄러

LaunchAgent는 Mac의 현지 시간 기준 매일 23:30에 한 번 실행합니다. access token(30분)은
저장하지 않고, macOS Keychain의 refresh token만 매 실행 직전에 회전한 뒤 메모리에서
사용합니다. 관리자 로그인 비밀번호는 최초 전용 계정 프로비저닝 요청에만 메모리에서
쓰고 저장하지 않습니다. 서버는 비밀번호 로그인이 불가능한
`wj_quality_archive_service` 계정과 범위가 제한된 refresh token을 만들며, 스케줄러는
그 refresh token만 Keychain에 저장합니다. 설치 시 실행 파일은 개발 저장소가 아니라
사용자 전용 Application Support의 버전별 디렉터리로 복사되고, LaunchAgent는 그 고정
버전을 실행합니다.

```bash
tools/quality_media_archive/install-scheduler.sh

/opt/homebrew/opt/python@3.12/libexec/bin/python3 \
  "$HOME/Library/Application Support/WJ/quality-media-archive/current/scheduler.py" configure
```

설정 상태는 secret을 읽어 출력하지 않고 확인할 수 있습니다.

```bash
/opt/homebrew/opt/python@3.12/libexec/bin/python3 \
  "$HOME/Library/Application Support/WJ/quality-media-archive/current/scheduler.py" status
```

로그는 `~/Library/Logs/wj-quality-media-archive/`에 남습니다. SSD가 분리되어 있거나
네트워크가 끊긴 실행은 실패로 기록되며 다음 일일 실행이 동일한 content-addressed 작업을
안전하게 이어받습니다. Mac이 7일 이상 실행되지 않아 refresh token이 만료된 경우에는
`configure`를 한 번 다시 실행해야 합니다.

제거 시 Keychain credential과 Ted_SSD 자료는 보존됩니다.

```bash
tools/quality_media_archive/install-scheduler.sh --uninstall
```

## 현재 제약과 운영 전 확인

1. 승인 상태를 증명할 DB 필드가 없어 현재 참조 여부까지만 기록할 수 있습니다.
2. ExFAT은 POSIX 권한을 강제하지 않습니다. 물리적 SSD 접근 통제와 별도 암호화 백업은
   운영 정책으로 보완해야 합니다.
3. 이 도구는 Cloudinary에서 삭제하는 기능이 없으며, 현재 report에서 참조되지 않는
   Cloudinary orphan asset도 수집하지 않습니다.
4. `configure`는 관리자 인증으로 archive-only 계정을 생성·수리하고 기존 service refresh를
   폐기한 뒤 새 refresh만 Keychain에 저장합니다. 서비스 계정은 일반 로그인, 관리자 화면,
   품질 보고 편집 및 다른 업무 API에 접근할 수 없습니다.

## 테스트

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s tools/quality_media_archive/tests -v
```
