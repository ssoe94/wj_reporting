# MES Local Log Strategy

## 목적 / 目标

Render 배포 서버는 최근 24시간의 1분 단위 MES 데이터를 저장하고 분석 화면에 제공한다. 24시간이 지난 1분 데이터는 서버에서 시간 단위로 압축하고, 장기 보관용 1분 로그는 로컬 Mac/Mac Studio에 저장한다.

Render 部署服务器保存最近 24 小时的 1 分钟 MES 数据并提供给分析页面。超过 24 小时的 1 分钟数据在服务器端压缩为小时数据，长期保存用的 1 分钟日志存到本地 Mac/Mac Studio。

## 권장 구조 / 推荐结构

1. `frontend-next`는 운영 API인 `https://wj-reporting.onrender.com/api`에서 최신 MES 데이터를 조회한다.
2. Render Celery Beat는 1분마다 최신 MES snapshot을 저장한다.
3. Render는 최근 24시간 1분 데이터를 유지하고, 24시간 초과분은 시간 단위 snapshot만 남긴다.
4. 로컬 Mac collector는 1분마다 운영 API를 호출해 SQLite에 upsert한다.
5. 로컬 Mac은 1분 데이터를 60일 보관하고, 60일 초과분은 시간 단위로 압축한다.
6. 분석 화면은 필요 시 로컬 DB를 읽거나, 추후 Mac Studio의 로컬 API에서 제공한다.

1. `frontend-next` 从生产 API `https://wj-reporting.onrender.com/api` 查询最新 MES 数据。
2. Render Celery Beat 每 1 分钟保存最新 MES snapshot。
3. Render 保留最近 24 小时的 1 分钟数据，超过 24 小时只保留小时级 snapshot。
4. 本地 Mac collector 每 1 分钟调用生产 API 并 upsert 到 SQLite。
5. 本地 Mac 保留 60 天 1 分钟数据，超过 60 天压缩为小时数据。
6. 分析页面后续可读取本地 DB，或由 Mac Studio 本地 API 提供。

## 저장 형식 / 存储格式

초기에는 SQLite를 권장한다. 설치와 백업이 쉽고, 1분 단위 17대 설비를 60일 보관해도 약 150만 행 수준이라 충분히 관리 가능하다. 장기 분석이나 대용량 처리가 필요해지면 Parquet 파일을 월 단위로 추가 저장한다.

初期推荐 SQLite。部署和备份简单，1 分钟粒度、17 台设备保存 60 天约 150 万行，仍可管理。后续需要长期分析或大数据处理时，再按月追加 Parquet 文件。

## 테이블 초안 / 表结构草案

```sql
CREATE TABLE injection_mes_minute_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collected_at TEXT NOT NULL,
  slot_time TEXT NOT NULL,
  machine_no INTEGER NOT NULL,
  machine_name TEXT NOT NULL,
  tonnage TEXT,
  output_count REAL,
  cumulative_output REAL,
  power_usage_kwh REAL,
  cumulative_power_kwh REAL,
  oil_temperature REAL,
  source_url TEXT NOT NULL,
  raw_payload_path TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(slot_time, machine_no)
);
```

## 수집 주기 / 采集周期

1분마다 `production-matrix`를 호출하고, 응답의 `time_slots`와 각 matrix를 펼쳐 `slot_time + machine_no` 기준으로 upsert한다.

每 1 分钟调用 `production-matrix`，将 `time_slots` 和各 matrix 展开，以 `slot_time + machine_no` 为唯一键进行 upsert。

```text
https://wj-reporting.onrender.com/api/injection/production-matrix/?interval=1min&columns=180
```

## 실행 방식 / 执行方式

로컬 Mac에서는 `launchd`를 권장한다. Mac이 켜져 있을 때 1분마다 collector 스크립트를 실행할 수 있고, 별도 서버 운영 부담이 작다.

本地 Mac 推荐使用 `launchd`。Mac 开机时可每 1 分钟执行 collector 脚本，维护成本低。

```text
~/Library/LaunchAgents/com.wj.mes-collector.plist
~/wj-data/mes/mes_logs.sqlite3
~/wj-data/mes/raw/YYYY-MM-DD/HH-mm.json
```

현재 초안 파일:

```text
scripts/mes_collector/collect_mes_minute_logs.py
scripts/mes_collector/com.wj.mes-collector.plist
```

## 다음 작업 / 下一步

1. Render 배포 전 MES 1분 호출량을 1~2일 관찰한다.
2. 로컬 Mac에서 `launchd` collector를 활성화한다.
3. SQLite 백업 위치를 iCloud/외장디스크/NAS 중 하나로 정한다.
4. Mac Studio 도입 후 로컬 FastAPI 또는 Django lightweight API로 분석 화면에 연결한다.

1. Render 部署前观察 1~2 天 MES 1 分钟调用量。
2. 在本地 Mac 启用 `launchd` collector。
3. 确定 SQLite 备份位置，如 iCloud、外置硬盘或 NAS。
4. Mac Studio 到位后，通过本地 FastAPI 或轻量 Django API 接入分析页面。
