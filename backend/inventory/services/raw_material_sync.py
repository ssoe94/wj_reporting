"""Coordinate the once-daily and exceptional manual raw-material MES sync."""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.management import call_command
from django.db import close_old_connections, transaction
from django.utils import timezone

from inventory.mes import _safe_exception_message
from inventory.models import RawMaterialMESDataset, RawMaterialSyncState
from inventory.services.raw_material_storage import (
    load_inventory_dataset,
    load_pending_inventory_dataset,
    save_mes_dataset,
)
from inventory.services.raw_materials import (
    build_raw_material_overview,
    with_zero_stock_markers,
)


logger = logging.getLogger(__name__)
SYNC_STALE_AFTER = timedelta(hours=3)
MANUAL_SYNC_COOLDOWN = timedelta(minutes=10)
FAILED_SYNC_COOLDOWN = timedelta(minutes=2)
DEFAULT_LOOKBACK_DAYS = 30
DATASET_RETENTION_DAYS = 45
SHANGHAI = ZoneInfo("Asia/Shanghai")


def _serialise_state(state: RawMaterialSyncState) -> dict[str, Any]:
    return {
        "status": state.status,
        "trigger": state.trigger,
        "message": state.message,
        "started_at": state.started_at.isoformat() if state.started_at else None,
        "finished_at": state.finished_at.isoformat() if state.finished_at else None,
        "updated_at": state.updated_at.isoformat() if state.updated_at else None,
    }


def get_raw_material_sync_status() -> dict[str, Any]:
    state, _ = RawMaterialSyncState.objects.get_or_create(
        pk=RawMaterialSyncState.SINGLETON_PK
    )
    return _serialise_state(state)


def launch_claimed_raw_material_sync(
    *,
    trigger: str,
    claimed_started_at: str,
) -> int:
    """Run a manual sync outside the gunicorn request/worker lifecycle."""
    command = [
        sys.executable,
        str(settings.BASE_DIR / "manage.py"),
        "run_claimed_raw_material_sync",
        f"--trigger={trigger}",
        f"--claimed-started-at={claimed_started_at}",
    ]
    popen_kwargs: dict[str, Any] = {
        "cwd": str(settings.BASE_DIR),
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        popen_kwargs["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        )
    else:
        popen_kwargs["start_new_session"] = True
    process = subprocess.Popen(command, **popen_kwargs)
    return process.pid


def claim_raw_material_sync(trigger: str) -> tuple[bool, dict[str, Any]]:
    """Atomically claim the singleton sync slot across all web/cron processes."""
    allowed = {value for value, _label in RawMaterialSyncState.TRIGGER_CHOICES}
    if trigger not in allowed:
        raise ValueError("invalid raw-material sync trigger")

    now = timezone.now()
    with transaction.atomic():
        RawMaterialSyncState.objects.get_or_create(
            pk=RawMaterialSyncState.SINGLETON_PK
        )
        state = RawMaterialSyncState.objects.select_for_update().get(
            pk=RawMaterialSyncState.SINGLETON_PK
        )
        is_fresh_run = (
            state.status == RawMaterialSyncState.STATUS_RUNNING
            and state.started_at is not None
            and now - state.started_at < SYNC_STALE_AFTER
        )
        if is_fresh_run:
            return False, _serialise_state(state)

        cooldown = None
        if trigger == RawMaterialSyncState.TRIGGER_MANUAL:
            if state.status == RawMaterialSyncState.STATUS_COMPLETED:
                cooldown = MANUAL_SYNC_COOLDOWN
            elif state.status == RawMaterialSyncState.STATUS_FAILED:
                cooldown = FAILED_SYNC_COOLDOWN
        if (
            cooldown is not None
            and state.finished_at is not None
            and now - state.finished_at < cooldown
        ):
            remaining_seconds = max(
                1,
                int((cooldown - (now - state.finished_at)).total_seconds()),
            )
            result = _serialise_state(state)
            result["status"] = "cooldown"
            result["message"] = (
                "서버 부하 방지를 위해 최근 MES 업데이트 후 잠시 대기합니다. "
                f"약 {(remaining_seconds + 59) // 60}분 뒤 다시 시도할 수 있습니다."
            )
            return False, result

        state.status = RawMaterialSyncState.STATUS_RUNNING
        state.trigger = trigger
        state.message = "MES 원료 재고와 변동 기록을 업데이트하고 있습니다."
        state.started_at = now
        state.finished_at = None
        state.save(
            update_fields=[
                "status",
                "trigger",
                "message",
                "started_at",
                "finished_at",
                "updated_at",
            ]
        )
        return True, _serialise_state(state)


def fail_claimed_raw_material_sync(
    message: str,
    *,
    claimed_started_at: str | None = None,
) -> dict[str, Any]:
    """Mark a claimed run failed, including a thread-start failure."""
    safe_message = _safe_exception_message(RuntimeError(message))[:300]
    with transaction.atomic():
        state, _ = RawMaterialSyncState.objects.select_for_update().get_or_create(
            pk=RawMaterialSyncState.SINGLETON_PK
        )
        if (
            claimed_started_at
            and (
                state.started_at is None
                or state.started_at.isoformat() != claimed_started_at
            )
        ):
            return _serialise_state(state)
        state.status = RawMaterialSyncState.STATUS_FAILED
        state.message = safe_message
        state.finished_at = timezone.now()
        state.save(
            update_fields=["status", "message", "finished_at", "updated_at"]
        )
    return _serialise_state(state)


def execute_claimed_raw_material_sync(
    *,
    trigger: str,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    claimed_started_at: str | None = None,
) -> dict[str, Any]:
    """Execute a previously claimed sync and persist only complete MES payloads."""
    close_old_connections()
    try:
        # Inventory is first committed under a non-public pending kind.  Only a
        # complete movement fetch promotes both sources together below.
        call_command(
            "fetch_inventory",
            pending_dataset=True,
            capture_type=trigger,
        )
        pending_inventory = load_pending_inventory_dataset()
        if pending_inventory is None:
            raise RuntimeError("The inventory sync completed without a pending MES dataset.")
        published_inventory = load_inventory_dataset()
        working_inventory_rows = with_zero_stock_markers(
            pending_inventory.rows,
            published_inventory.rows if published_inventory is not None else (),
        )

        change_rows: list[dict[str, Any]] = []
        payload = build_raw_material_overview(
            lookback_days=lookback_days,
            force_refresh=True,
            persist=False,
            inventory_rows_override=working_inventory_rows,
            change_rows_output=change_rows,
        )
        sources = payload.get("meta", {}).get("sources", {})
        inventory_status = sources.get("inventory_detail", {}).get("status")
        change_status = sources.get("inventory_change_log", {}).get("status")
        if inventory_status not in {"ok", "stored"}:
            raise RuntimeError("MES inventory detail did not complete successfully.")
        if change_status not in {"ok", "stored"}:
            raise RuntimeError("MES inventory movement history did not complete successfully.")

        sync_now = timezone.now().astimezone(SHANGHAI)
        business_date = pending_inventory.snapshot_date or (
            sync_now - timedelta(hours=8)
        ).date()
        selected_warehouses = payload.get("selected_warehouses", [])
        warehouse_codes = sorted(
            str(row.get("code"))
            for row in selected_warehouses
            if row.get("code") not in (None, "")
        )
        warehouse_ids = sorted(
            str(row.get("id"))
            for row in selected_warehouses
            if row.get("id") not in (None, "")
        )
        range_start = datetime.combine(
            business_date - timedelta(days=lookback_days),
            time(hour=8),
            tzinfo=SHANGHAI,
        )
        latest_change_text = payload.get("meta", {}).get(
            "change_log_source_latest_at"
        )
        latest_change_at = (
            datetime.fromisoformat(latest_change_text)
            if latest_change_text
            else None
        )
        material_count = payload.get("summary", {}).get("material_count", 0)
        with transaction.atomic():
            state = RawMaterialSyncState.objects.select_for_update().get(
                pk=RawMaterialSyncState.SINGLETON_PK
            )
            if (
                claimed_started_at
                and (
                    state.started_at is None
                    or state.started_at.isoformat() != claimed_started_at
                )
            ):
                raise RuntimeError("This MES sync was superseded by a newer run.")
            save_mes_dataset(
                kind=RawMaterialMESDataset.KIND_INVENTORY,
                rows=working_inventory_rows,
                warehouse_codes=pending_inventory.warehouse_codes,
                warehouse_ids=pending_inventory.warehouse_ids,
                source_latest_at=pending_inventory.source_latest_at,
                snapshot_date=business_date,
                capture_type=trigger,
            )
            save_mes_dataset(
                kind=RawMaterialMESDataset.KIND_CHANGE,
                rows=change_rows,
                warehouse_codes=warehouse_codes,
                warehouse_ids=warehouse_ids,
                lookback_days=lookback_days,
                range_start=range_start,
                range_end=sync_now,
                source_latest_at=latest_change_at,
                snapshot_date=business_date,
                capture_type=trigger,
            )
            RawMaterialMESDataset.objects.filter(
                kind=RawMaterialMESDataset.KIND_INVENTORY_PENDING,
                snapshot_date__lte=business_date,
            ).delete()
            RawMaterialMESDataset.objects.filter(
                snapshot_date__lt=(
                    business_date - timedelta(days=DATASET_RETENTION_DAYS)
                )
            ).delete()
            state.status = RawMaterialSyncState.STATUS_COMPLETED
            state.trigger = trigger
            state.message = f"원료 {material_count}개 품목의 MES 업데이트가 완료되었습니다."
            state.finished_at = timezone.now()
            state.save(
                update_fields=[
                    "status",
                    "trigger",
                    "message",
                    "finished_at",
                    "updated_at",
                ]
            )
        return _serialise_state(state)
    except Exception as exc:
        safe_error = _safe_exception_message(exc)[:260]
        logger.error("Raw-material MES sync failed: %s", safe_error)
        return fail_claimed_raw_material_sync(
            f"MES 업데이트에 실패했습니다. 마지막 정상 데이터는 유지됩니다. {safe_error}",
            claimed_started_at=claimed_started_at,
        )
    finally:
        close_old_connections()


def run_raw_material_sync(
    *,
    trigger: str,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
) -> tuple[bool, dict[str, Any]]:
    """Claim and run synchronously; used by the 08:00 management command."""
    claimed, state = claim_raw_material_sync(trigger)
    if not claimed:
        return False, state
    return True, execute_claimed_raw_material_sync(
        trigger=trigger,
        lookback_days=lookback_days,
        claimed_started_at=state["started_at"],
    )


__all__ = [
    "claim_raw_material_sync",
    "execute_claimed_raw_material_sync",
    "fail_claimed_raw_material_sync",
    "get_raw_material_sync_status",
    "launch_claimed_raw_material_sync",
    "run_raw_material_sync",
]
