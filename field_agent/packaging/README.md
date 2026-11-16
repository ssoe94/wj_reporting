# Windows 포터블 빌드 · Windows 便携版构建

## 빌드 입력 · 构建输入

| 프로필 · 配置 | 입력 런타임 · 运行时 | 현장 브라우저 · 现场浏览器 |
| --- | --- | --- |
| `win7` | Python 3.8.x Windows embeddable ZIP | Chrome 109 |
| `win10` | Python 3.12.x Windows embeddable ZIP | Edge / Chrome |

빌드 전에 대상 장비와 아키텍처에 맞는 공식 Python ZIP, 승인된 pyserial wheel, 별도 UV 화면 패치를 준비합니다. 공급 경로에서 받은 파일의 버전과 SHA-256을 검증하고 `--pins`에 영문 파일명 기준으로 고정합니다. 형식은 줄마다 `<64자리 소문자 SHA-256>  <파일명>`입니다. 빌드는 로컬 파일만 엽니다.

构建前准备与目标架构相符的官方 Python ZIP、已批准的 pyserial wheel 及单独的 UV 界面补丁。核对来源、版本和 SHA-256 后，将英文文件名对应的哈希写入 `--pins`。每行的格式是 `<64 位小写 SHA-256>  <文件名>`。构建只读取本地文件。

```text
python -m field_agent.packaging.build_portable --profile win10 --version 0.2.0 --output <WJField.zip> --pins <approved-sha256.txt> --python-zip <official-embed.zip> --wheel <approved-pyserial.whl> --uv-patch <approved-uv.patch>
```

`--python-zip` 대신 `--skeleton`을 지정하면 구조 시험 ZIP을 만듭니다. UV 패치를 동봉할 때는 같은 방식으로 입력 해시를 고정합니다. 골격의 `TEST-ONLY.txt`와 manifest의 `skeleton: true`로 구별합니다.

用 `--skeleton` 取代 `--python-zip` 可生成结构测试包。若附带 UV 补丁，同样验证输入哈希。以 `TEST-ONLY.txt` 和清单中的 `skeleton: true` 标记骨架包。

## 전달과 검증 · 交付与核验

```text
WJField/
  install.cmd, configure.cmd, start.cmd, agent-view.cmd, stop.cmd, update.cmd, rollback.cmd
  install-autostart.cmd, remove-autostart.cmd, uninstall.cmd
  current.txt                   설치 후 활성 버전 · 安装后活动版本
  versions/<version>/
    python/                     고정 입력 런타임 · 固定运行时
    field_agent/                코드 및 화면 · 代码及界面
    components/uv/              별도 화면 패치 · 独立界面补丁
    docs/field-monitoring/operations/
    BUILD-MANIFEST.json
    SHA256SUMS
  data/                         설치 후 원장·설정·토큰·백업·로그 · 安装后台账、配置、令牌、备份和日志
```

완성된 ZIP 옆의 `.zip.sha256`을 승인된 경로에서 전달합니다. 압축을 풀거나 ZIP을 실행 도구에 건네기 전에 승인 값과 실제 ZIP의 SHA-256을 확인합니다. 버전 내부 `SHA256SUMS`는 자신의 파일을 제외한 모든 파일의 경로와 해시를 포함합니다. UV 구성요소는 별도 복사본의 언어 검증에 쓰며, 실제 설치 순서는 운영 안내를 따릅니다.

通过批准的渠道交付 ZIP 的 `.zip.sha256`。解包或提交给更新工具前，对照批准的值检查实际 ZIP 的 SHA-256。版本目录内的 `SHA256SUMS` 列出除自身以外的所有文件及哈希。UV 组件用于独立副本的语言验证，安装方法见管理员指南。

교대 시간에 앱 사이클을 마치고 동반 앱을 닫은 뒤 `stop.cmd`를 실행합니다. 업데이트·롤백은 잠금, 활성 인쇄, V49 안전 기록, 설정, 원장 사본, 로컬 포트를 확인한 뒤 `current.txt`를 원자적으로 바꿉니다. 현재와 직전 두 버전을 보관하며 `data/`의 바이트를 보존합니다. `start.cmd`로 새 버전을 다시 시작합니다.

交接班时结束作业周期、关闭配套程序，再执行 `stop.cmd`。更新和回滚检查独占锁、未完成打印、V49 安全记录、配置、台账副本和本机端口，然后原子更新 `current.txt`。默认保留当前版和两个旧版，保留 `data/` 内容。用 `start.cmd` 重新启动。

[관리자 안내 · 管理员指南](../../docs/field-monitoring/operations/administrator.md) · [Windows 로그인 작업 · Windows 登录任务](https://learn.microsoft.com/en-us/windows/win32/taskschd/logon-trigger-example--xml-)
