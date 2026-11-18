# UV 한·중 화면 구성요소 / UV 韩中界面组件

## 한국어

이 패치는 기존 UV 배치 검사 앱의 **별도 검증 복사본**에 적용합니다. 기존 설치 폴더에서 명령을 실행하지 않습니다. 원본 `batch_inspection/app.py`의 SHA-256은 `57c27bd2322cc2398b9cf1a5f79ac25f41548eab4c4666707653a78cca93871f`입니다. 복사본 루트에서 아래 명령으로 적용 여부를 먼저 확인합니다.

```cmd
git apply --check "X:\경로\batch-inspection-ko-zh.patch"
git apply "X:\경로\batch-inspection-ko-zh.patch"
python -m batch_inspection --demo-faults --lang zh_CN
```

한국어와 중국어의 검사·설정 탭, 경고, 결과, 언어 재시작 유지와 전체 화면 배치를 시험합니다. Git 및 기존 UV 앱에 맞는 Python·Qt·SDK는 별도로 준비합니다. 현장 전환 전에는 운영 디렉터리와 분리된 데모 출력 경로를 사용합니다. 복구는 검증 복사본 폐기 또는 `git apply --check -R`와 `git apply -R`로 진행합니다.

## 中文

把补丁应用于 UV 批次检测应用的**独立验证副本**。请勿在现用安装目录执行命令。先用 `certutil -hashfile batch_inspection\app.py SHA256` 核对上方的原版 SHA-256。在副本根目录通过 `git apply --check` 检查补丁，再执行 `git apply`。

用 `python -m batch_inspection --demo-faults --lang zh_CN` 验证中韩两种语言的检测和设置页、警告、结果、重启后语言保留和全屏布局。Git、原 UV 应用依赖的 Python、Qt 和 SDK 需另行准备。演示输出使用与生产分开的目录。恢复时丢弃验证副本，或先执行 `git apply --check -R` 再执行 `git apply -R`。
