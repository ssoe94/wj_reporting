from datetime import date
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from inventory.models import RawMaterialMESDataset, RawMaterialSyncState
from inventory.services.raw_material_storage import save_mes_dataset
from inventory.services.raw_material_sync import (
    claim_raw_material_sync,
    execute_claimed_raw_material_sync,
    get_raw_material_sync_status,
    launch_claimed_raw_material_sync,
)


class RawMaterialSyncServiceTests(TestCase):
    @patch(
        "inventory.management.commands.daily_snapshot_auto.Command.create_daily_snapshot"
    )
    @patch(
        "inventory.management.commands.daily_snapshot_auto.run_raw_material_sync"
    )
    def test_daily_snapshot_is_not_created_when_mes_sync_does_not_start(
        self, run_sync, create_snapshot
    ):
        run_sync.return_value = (
            False,
            {"status": "running", "message": "already running"},
        )

        with self.assertRaises(CommandError):
            call_command("daily_snapshot_auto", stdout=StringIO(), stderr=StringIO())

        create_snapshot.assert_not_called()

    @patch("inventory.services.raw_material_sync.subprocess.Popen")
    def test_manual_worker_is_launched_as_a_detached_management_process(
        self, popen
    ):
        popen.return_value.pid = 321

        pid = launch_claimed_raw_material_sync(
            trigger="manual",
            claimed_started_at="2026-07-14T08:00:00+08:00",
        )

        self.assertEqual(pid, 321)
        command = popen.call_args.args[0]
        self.assertIn("run_claimed_raw_material_sync", command)
        self.assertIn("--trigger=manual", command)
        self.assertNotIn("shell", popen.call_args.kwargs)

    def test_claim_blocks_a_second_daily_or_manual_run(self):
        claimed, first = claim_raw_material_sync("daily")
        claimed_again, second = claim_raw_material_sync("manual")

        self.assertTrue(claimed)
        self.assertFalse(claimed_again)
        self.assertEqual(first["status"], RawMaterialSyncState.STATUS_RUNNING)
        self.assertEqual(second["trigger"], RawMaterialSyncState.TRIGGER_DAILY)

    def test_manual_sync_has_a_global_cooldown_after_completion(self):
        state = RawMaterialSyncState.objects.create(
            pk=RawMaterialSyncState.SINGLETON_PK,
            status=RawMaterialSyncState.STATUS_COMPLETED,
            trigger=RawMaterialSyncState.TRIGGER_MANUAL,
            started_at=timezone.now(),
            finished_at=timezone.now(),
        )

        claimed, result = claim_raw_material_sync("manual")

        self.assertFalse(claimed)
        self.assertEqual(result["status"], "cooldown")
        self.assertIn("서버 부하", result["message"])
        state.refresh_from_db()
        self.assertEqual(state.status, RawMaterialSyncState.STATUS_COMPLETED)

    @patch("inventory.services.raw_material_sync.build_raw_material_overview")
    @patch("inventory.services.raw_material_sync.load_pending_inventory_dataset")
    @patch("inventory.services.raw_material_sync.call_command")
    def test_claimed_sync_completes_and_reports_material_count(
        self, call_command, load_inventory, build_overview
    ):
        _claimed, claimed_state = claim_raw_material_sync("manual")
        load_inventory.return_value = SimpleNamespace(
            id=999,
            rows=[{"id": "1"}],
            warehouse_codes=(),
            warehouse_ids=(),
            source_latest_at=None,
            snapshot_date=date(2026, 7, 14),
        )
        build_overview.return_value = {
            "meta": {
                "sources": {
                    "inventory_detail": {"status": "ok"},
                    "inventory_change_log": {"status": "ok"},
                }
            },
            "summary": {"material_count": 17},
            "selected_warehouses": [],
        }

        result = execute_claimed_raw_material_sync(
            trigger="manual",
            claimed_started_at=claimed_state["started_at"],
        )

        self.assertEqual(result["status"], RawMaterialSyncState.STATUS_COMPLETED)
        self.assertIn("17", result["message"])
        call_command.assert_called_once_with(
            "fetch_inventory",
            pending_dataset=True,
            capture_type="manual",
        )
        self.assertFalse(build_overview.call_args.kwargs["persist"])
        self.assertTrue(build_overview.call_args.kwargs["force_refresh"])

    @patch("inventory.services.raw_material_sync.call_command")
    def test_failed_sync_keeps_a_sanitised_durable_status(self, call_command):
        _claimed, claimed_state = claim_raw_material_sync("manual")
        call_command.side_effect = RuntimeError(
            "POST https://mes.example/path?access_token=top-secret failed"
        )

        result = execute_claimed_raw_material_sync(
            trigger="manual",
            claimed_started_at=claimed_state["started_at"],
        )
        stored = get_raw_material_sync_status()

        self.assertEqual(result["status"], RawMaterialSyncState.STATUS_FAILED)
        self.assertEqual(stored["status"], RawMaterialSyncState.STATUS_FAILED)
        self.assertNotIn("top-secret", stored["message"])
        self.assertIn("마지막 정상 데이터", stored["message"])

    @patch("inventory.services.raw_material_sync.build_raw_material_overview")
    @patch("inventory.services.raw_material_sync.call_command")
    def test_movement_failure_does_not_promote_pending_inventory(
        self, call_command, build_overview
    ):
        published = save_mes_dataset(
            RawMaterialMESDataset.KIND_INVENTORY,
            [{"id": 1}],
            snapshot_date=date(2026, 7, 13),
        )
        pending = save_mes_dataset(
            RawMaterialMESDataset.KIND_INVENTORY_PENDING,
            [{"id": 2}],
            snapshot_date=date(2026, 7, 14),
            capture_type="manual",
        )
        build_overview.return_value = {
            "meta": {
                "sources": {
                    "inventory_detail": {"status": "ok"},
                    "inventory_change_log": {"status": "error"},
                }
            },
            "summary": {"material_count": 1},
            "selected_warehouses": [],
        }
        _claimed, claimed_state = claim_raw_material_sync("manual")

        result = execute_claimed_raw_material_sync(
            trigger="manual",
            claimed_started_at=claimed_state["started_at"],
        )

        self.assertEqual(result["status"], RawMaterialSyncState.STATUS_FAILED)
        self.assertTrue(
            RawMaterialMESDataset.objects.filter(pk=published.id).exists()
        )
        self.assertTrue(
            RawMaterialMESDataset.objects.filter(pk=pending.id).exists()
        )
        self.assertFalse(
            RawMaterialMESDataset.objects.filter(
                kind=RawMaterialMESDataset.KIND_INVENTORY,
                snapshot_date=date(2026, 7, 14),
            ).exists()
        )


class RawMaterialSyncViewTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = get_user_model().objects.create_user(
            username="raw-material-sync-user", password="unused", is_staff=True
        )

    def test_authentication_is_required(self):
        self.assertEqual(
            self.client.get("/api/inventory/raw-materials/sync/").status_code,
            401,
        )
        self.assertEqual(
            self.client.post("/api/inventory/raw-materials/sync/").status_code,
            401,
        )

    def test_non_staff_user_cannot_start_a_costly_manual_sync(self):
        ordinary = get_user_model().objects.create_user(
            username="raw-material-ordinary-user", password="unused"
        )
        self.client.force_authenticate(ordinary)

        response = self.client.post("/api/inventory/raw-materials/sync/")

        self.assertEqual(response.status_code, 403)
        self.assertFalse(RawMaterialSyncState.objects.exists())

    @patch("inventory.raw_material_views.launch_claimed_raw_material_sync")
    def test_manual_sync_starts_once_and_rejects_duplicate(self, launch_sync):
        self.client.force_authenticate(self.user)

        first = self.client.post("/api/inventory/raw-materials/sync/")
        second = self.client.post("/api/inventory/raw-materials/sync/")

        self.assertEqual(first.status_code, 202)
        self.assertEqual(first.json()["status"], RawMaterialSyncState.STATUS_RUNNING)
        launch_sync.assert_called_once()
        self.assertEqual(second.status_code, 409)
        self.assertEqual(second.json()["status"], RawMaterialSyncState.STATUS_RUNNING)

    @patch("inventory.services.raw_material_sync.launch_claimed_raw_material_sync")
    def test_legacy_inventory_refresh_uses_the_same_single_sync_slot(
        self, launch_sync
    ):
        self.client.force_authenticate(self.user)

        first = self.client.post("/api/inventory/refresh/")
        second = self.client.post("/api/inventory/refresh/")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["status"], "started")
        launch_sync.assert_called_once()
        self.assertEqual(second.status_code, 409)
