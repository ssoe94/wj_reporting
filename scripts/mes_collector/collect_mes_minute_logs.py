#!/usr/bin/env python3
"""Collect MES minute-level monitoring data into a local SQLite database."""

from __future__ import annotations

import argparse
import json
import sqlite3
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


DEFAULT_API_URL = "https://wj-reporting.onrender.com/api/injection/production-matrix/?interval=1min&columns=180"
DEFAULT_DATA_DIR = Path.home() / "wj-data" / "mes"
LOCAL_TZ = timezone(timedelta(hours=8))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect WJ MES minute logs into local SQLite.")
    parser.add_argument("--api-url", default=DEFAULT_API_URL)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--minute-retention-days", type=int, default=60)
    return parser.parse_args()


def fetch_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS injection_mes_minute_logs (
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

        CREATE TABLE IF NOT EXISTS injection_mes_hourly_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hour_time TEXT NOT NULL,
          machine_no INTEGER NOT NULL,
          machine_name TEXT NOT NULL,
          tonnage TEXT,
          output_count REAL,
          power_usage_kwh REAL,
          avg_oil_temperature REAL,
          latest_cumulative_output REAL,
          latest_cumulative_power_kwh REAL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(hour_time, machine_no)
        );
        """
    )


def matrix_value(matrix: dict[str, list[Any]], machine_no: int, index: int) -> float | None:
    values = matrix.get(str(machine_no)) or []
    if index >= len(values):
        return None
    value = values[index]
    return float(value) if value is not None else None


def save_raw_payload(data_dir: Path, payload: dict[str, Any]) -> Path:
    now = datetime.now(LOCAL_TZ)
    raw_dir = data_dir / "raw" / now.strftime("%Y-%m-%d")
    raw_dir.mkdir(parents=True, exist_ok=True)
    raw_path = raw_dir / f"{now.strftime('%H-%M-%S')}.json"
    raw_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return raw_path


def upsert_minute_logs(conn: sqlite3.Connection, payload: dict[str, Any], source_url: str, raw_path: Path) -> int:
    collected_at = datetime.now(LOCAL_TZ).isoformat()
    time_slots = payload.get("time_slots") or []
    machines = payload.get("machines") or []
    actual = payload.get("actual_production_matrix") or {}
    cumulative = payload.get("cumulative_production_matrix") or {}
    oil = payload.get("oil_temperature_matrix") or {}
    power_total = payload.get("power_kwh_matrix") or {}
    power_usage = payload.get("power_usage_matrix") or {}

    rows = []
    for index, slot in enumerate(time_slots):
      slot_time = slot.get("time")
      if not slot_time:
          continue
      for machine in machines:
          machine_no = int(machine.get("machine_number"))
          rows.append(
              (
                  collected_at,
                  slot_time,
                  machine_no,
                  machine.get("machine_name") or f"{machine_no}호기",
                  str(machine.get("tonnage") or ""),
                  matrix_value(actual, machine_no, index),
                  matrix_value(cumulative, machine_no, index),
                  matrix_value(power_usage, machine_no, index),
                  matrix_value(power_total, machine_no, index),
                  matrix_value(oil, machine_no, index),
                  source_url,
                  str(raw_path),
              )
          )

    conn.executemany(
        """
        INSERT INTO injection_mes_minute_logs (
          collected_at, slot_time, machine_no, machine_name, tonnage,
          output_count, cumulative_output, power_usage_kwh, cumulative_power_kwh,
          oil_temperature, source_url, raw_payload_path
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slot_time, machine_no) DO UPDATE SET
          collected_at=excluded.collected_at,
          machine_name=excluded.machine_name,
          tonnage=excluded.tonnage,
          output_count=excluded.output_count,
          cumulative_output=excluded.cumulative_output,
          power_usage_kwh=excluded.power_usage_kwh,
          cumulative_power_kwh=excluded.cumulative_power_kwh,
          oil_temperature=excluded.oil_temperature,
          source_url=excluded.source_url,
          raw_payload_path=excluded.raw_payload_path
        """,
        rows,
    )
    return len(rows)


def compact_old_minutes(conn: sqlite3.Connection, retention_days: int) -> None:
    cutoff = datetime.now(LOCAL_TZ) - timedelta(days=retention_days)
    cutoff_iso = cutoff.isoformat()

    conn.execute(
        """
        INSERT INTO injection_mes_hourly_logs (
          hour_time, machine_no, machine_name, tonnage, output_count,
          power_usage_kwh, avg_oil_temperature, latest_cumulative_output,
          latest_cumulative_power_kwh
        )
        SELECT
          substr(slot_time, 1, 13) || ':00:00' AS hour_time,
          machine_no,
          max(machine_name),
          max(tonnage),
          sum(coalesce(output_count, 0)),
          sum(coalesce(power_usage_kwh, 0)),
          avg(nullif(oil_temperature, 0)),
          max(cumulative_output),
          max(cumulative_power_kwh)
        FROM injection_mes_minute_logs
        WHERE slot_time < ?
        GROUP BY hour_time, machine_no
        ON CONFLICT(hour_time, machine_no) DO UPDATE SET
          machine_name=excluded.machine_name,
          tonnage=excluded.tonnage,
          output_count=excluded.output_count,
          power_usage_kwh=excluded.power_usage_kwh,
          avg_oil_temperature=excluded.avg_oil_temperature,
          latest_cumulative_output=excluded.latest_cumulative_output,
          latest_cumulative_power_kwh=excluded.latest_cumulative_power_kwh
        """,
        (cutoff_iso,),
    )
    conn.execute("DELETE FROM injection_mes_minute_logs WHERE slot_time < ?", (cutoff_iso,))


def main() -> None:
    args = parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    db_path = args.data_dir / "mes_logs.sqlite3"

    payload = fetch_json(args.api_url)
    raw_path = save_raw_payload(args.data_dir, payload)

    with sqlite3.connect(db_path) as conn:
        ensure_schema(conn)
        row_count = upsert_minute_logs(conn, payload, args.api_url, raw_path)
        compact_old_minutes(conn, args.minute_retention_days)
        conn.commit()

    print(f"saved_or_updated={row_count} db={db_path} raw={raw_path}")


if __name__ == "__main__":
    main()
