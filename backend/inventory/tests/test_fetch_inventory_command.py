import datetime
from decimal import Decimal
from io import StringIO
from unittest.mock import call, patch
from zoneinfo import ZoneInfo

from django.core.cache import cache
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase

from inventory.models import RawMaterialMESDataset, StagingInventory


SHANGHAI = ZoneInfo("Asia/Shanghai")
SOURCE_TIME = datetime.datetime(2026, 7, 14, 0, 0, tzinfo=datetime.timezone.utc)
RUN_TIME = datetime.datetime(2026, 7, 14, 8, 0, tzinfo=SHANGHAI)
BIG_MATERIAL_ID = 8_001_000_000_000_000_000
BIG_WAREHOUSE_ID = 8_002_000_000_000_000_000


def mes_inventory_row(index):
    updated_at = SOURCE_TIME + datetime.timedelta(seconds=index)
    return {
        "id": 8_000_000_000_000_000_000 + index,
        "updatedAt": int(updated_at.timestamp() * 1000),
        "qrCode": f"QR-{index}",
        "trolleyCode": f"TROLLEY-{index}",
        "material": {
            "id": BIG_MATERIAL_ID + index,
            "code": f"RM-{index:03d}",
            "name": f"Raw material {index}",
            "specification": "25kg bag",
            "bizType": 7,
        },
        "amount": {
            "amount": f"{index + 1}.2500",
            "unit": {"code": "kg"},
        },
        "storageStatus": {"code": 1},
        "qcStatus": {"code": 2},
        "storageLocationDetail": {
            "warehouse": {
                "id": BIG_WAREHOUSE_ID,
                "code": "RAW",
                "name": "原材料仓库",
            },
            "location": {"name": "A-01"},
        },
        "workOrderSimpleInfos": [{"code": "WO-1"}],
    }


class FetchInventoryCommandTests(TestCase):
    def setUp(self):
        cache.clear()
        self.old_inventory = StagingInventory.objects.create(
            material_id=1,
            material_code="OLD-RM",
            qr_code="OLD-QR",
            label_code="OLD-LABEL",
            composite_key="OLD-LABEL::OLD-RM",
            material_name="Last good inventory",
            quantity="9.0000",
            unit="kg",
            updated_at=SOURCE_TIME - datetime.timedelta(days=1),
        )

    @patch("inventory.management.commands.fetch_inventory.timezone.now")
    @patch("inventory.management.commands.fetch_inventory.call_inventory_list")
    def test_success_replaces_staging_only_after_all_pages_and_saves_raw_rows(
        self,
        inventory_call,
        timezone_now,
    ):
        first_page = [mes_inventory_row(index) for index in range(100)]
        final_row = mes_inventory_row(100)
        inventory_call.side_effect = [
            {"data": {"list": first_page, "total": 101}},
            {"data": {"list": [final_row], "total": 101}},
        ]
        timezone_now.return_value = RUN_TIME

        call_command("fetch_inventory", stdout=StringIO(), stderr=StringIO())

        self.assertFalse(StagingInventory.objects.filter(material_code="OLD-RM").exists())
        self.assertEqual(StagingInventory.objects.count(), 101)
        imported = StagingInventory.objects.get(material_code="RM-100")
        self.assertEqual(imported.material_id, BIG_MATERIAL_ID + 100)
        self.assertEqual(imported.composite_key, "TROLLEY-100::RM-100")
        self.assertEqual(imported.warehouse_code, "RAW")
        self.assertEqual(imported.warehouse_name, "原材料仓库")
        self.assertEqual(imported.location_name, "A-01")
        self.assertEqual(imported.storage_status, "1")
        self.assertEqual(imported.qc_status, "2")
        self.assertEqual(imported.work_order_code, "WO-1")
        self.assertEqual(imported.unit, "kg")

        inventory_call.assert_has_calls(
            [call(page=1, size=100), call(page=2, size=100)]
        )
        self.assertEqual(inventory_call.call_count, 2)

        dataset = RawMaterialMESDataset.objects.get(kind="inventory")
        self.assertEqual(dataset.record_count, 101)
        self.assertEqual(dataset.snapshot_date, datetime.date(2026, 7, 14))
        self.assertEqual(
            dataset.source_latest_at,
            SOURCE_TIME + datetime.timedelta(seconds=100),
        )
        self.assertEqual(
            dataset.payload[0]["storageLocationDetail"]["warehouse"]["id"],
            str(BIG_WAREHOUSE_ID),
        )

        progress = cache.get("inventory_fetch_progress")
        self.assertEqual(
            progress,
            {"current": 101, "total": 101, "status": "completed"},
        )

    @patch("inventory.management.commands.fetch_inventory.call_inventory_list")
    def test_json_number_quantity_is_normalised_before_decimal_validation(
        self,
        inventory_call,
    ):
        row = mes_inventory_row(0)
        row["amount"]["amount"] = 12.34
        inventory_call.return_value = {"data": {"list": [row], "total": 1}}

        call_command("fetch_inventory", stdout=StringIO(), stderr=StringIO())

        imported = StagingInventory.objects.get(material_code="RM-000")
        self.assertEqual(imported.quantity, Decimal("12.3400"))
        dataset = RawMaterialMESDataset.objects.get(kind="inventory")
        self.assertEqual(dataset.payload[0]["amount"]["amount"], 12.34)

    @patch("inventory.management.commands.fetch_inventory.call_inventory_list")
    def test_quantity_is_rounded_half_up_to_staging_precision(
        self,
        inventory_call,
    ):
        row = mes_inventory_row(0)
        row["amount"]["amount"] = 12.34567
        inventory_call.return_value = {"data": {"list": [row], "total": 1}}

        call_command("fetch_inventory", stdout=StringIO(), stderr=StringIO())

        imported = StagingInventory.objects.get(material_code="RM-000")
        self.assertEqual(imported.quantity, Decimal("12.3457"))

    @patch("inventory.management.commands.fetch_inventory.call_inventory_list")
    def test_non_finite_quantity_preserves_last_good_inventory(
        self,
        inventory_call,
    ):
        row = mes_inventory_row(0)
        row["amount"]["amount"] = "NaN"
        inventory_call.return_value = {"data": {"list": [row], "total": 1}}

        with self.assertRaises(CommandError):
            call_command("fetch_inventory", stdout=StringIO(), stderr=StringIO())

        self.assertEqual(
            list(StagingInventory.objects.values_list("material_code", flat=True)),
            ["OLD-RM"],
        )
        self.assertEqual(RawMaterialMESDataset.objects.count(), 0)

    @patch("inventory.management.commands.fetch_inventory.call_inventory_list")
    def test_later_page_failure_preserves_last_good_staging_rows(
        self,
        inventory_call,
    ):
        first_page = [mes_inventory_row(index) for index in range(100)]
        upstream_error = RuntimeError(
            "MES timeout: access_token=super-secret&request=inventory"
        )
        inventory_call.side_effect = [
            {"data": {"list": first_page, "total": 101}},
            upstream_error,
        ]

        with self.assertRaises(CommandError) as raised:
            call_command("fetch_inventory", stdout=StringIO(), stderr=StringIO())

        self.assertEqual(
            list(StagingInventory.objects.values_list("material_code", flat=True)),
            ["OLD-RM"],
        )
        self.assertEqual(RawMaterialMESDataset.objects.count(), 0)
        self.assertEqual(
            inventory_call.call_args_list,
            [
                call(page=1, size=100),
                call(page=2, size=100),
            ],
        )
        progress = cache.get("inventory_fetch_progress")
        self.assertEqual(progress["status"], "error")
        self.assertEqual(progress["current"], 100)
        self.assertNotIn("super-secret", progress["error"])
        self.assertNotIn("super-secret", str(raised.exception))

    @patch("inventory.management.commands.fetch_inventory.save_mes_dataset")
    @patch("inventory.management.commands.fetch_inventory.call_inventory_list")
    def test_raw_dataset_failure_rolls_back_staging_replacement(
        self,
        inventory_call,
        save_dataset,
    ):
        inventory_call.return_value = {
            "data": {"list": [mes_inventory_row(0)], "total": 1}
        }
        save_dataset.side_effect = RuntimeError("dataset write failed")

        with self.assertRaises(CommandError):
            call_command("fetch_inventory", stdout=StringIO(), stderr=StringIO())

        preserved = StagingInventory.objects.get()
        self.assertEqual(preserved.pk, self.old_inventory.pk)
        self.assertEqual(preserved.material_code, "OLD-RM")
        self.assertEqual(RawMaterialMESDataset.objects.count(), 0)
        self.assertEqual(cache.get("inventory_fetch_progress")["status"], "error")

    @patch("inventory.management.commands.fetch_inventory.call_inventory_list")
    def test_repeated_full_page_stops_without_overwriting_last_good_data(
        self, inventory_call
    ):
        repeated_page = [mes_inventory_row(index) for index in range(100)]
        inventory_call.side_effect = [
            {"data": {"list": repeated_page, "total": 0}},
            {"data": {"list": repeated_page, "total": 0}},
        ]

        with self.assertRaises(CommandError):
            call_command("fetch_inventory", stdout=StringIO(), stderr=StringIO())

        self.assertEqual(inventory_call.call_count, 2)
        self.assertTrue(
            StagingInventory.objects.filter(pk=self.old_inventory.pk).exists()
        )
        self.assertEqual(RawMaterialMESDataset.objects.count(), 0)

    @patch("inventory.management.commands.fetch_inventory.call_inventory_list")
    def test_empty_mes_result_does_not_erase_existing_inventory(self, inventory_call):
        inventory_call.return_value = {"data": {"list": [], "total": 0}}

        with self.assertRaises(CommandError):
            call_command("fetch_inventory", stdout=StringIO(), stderr=StringIO())

        self.assertTrue(
            StagingInventory.objects.filter(pk=self.old_inventory.pk).exists()
        )
        self.assertEqual(RawMaterialMESDataset.objects.count(), 0)

    @patch("inventory.management.commands.fetch_inventory.call_inventory_list")
    def test_short_page_before_declared_total_preserves_last_good_data(
        self, inventory_call
    ):
        first_page = [mes_inventory_row(index) for index in range(100)]
        short_page = [mes_inventory_row(100 + index) for index in range(10)]
        inventory_call.side_effect = [
            {"data": {"list": first_page, "total": 150}},
            {"data": {"list": short_page, "total": 150}},
        ]

        with self.assertRaises(CommandError):
            call_command("fetch_inventory", stdout=StringIO(), stderr=StringIO())

        self.assertTrue(
            StagingInventory.objects.filter(pk=self.old_inventory.pk).exists()
        )
        self.assertEqual(RawMaterialMESDataset.objects.count(), 0)

    @patch(
        "inventory.management.commands.fetch_inventory.StagingInventory.objects.bulk_create"
    )
    @patch("inventory.management.commands.fetch_inventory.call_inventory_list")
    def test_staging_write_failure_rolls_back_raw_dataset(
        self,
        inventory_call,
        bulk_create,
    ):
        inventory_call.return_value = {
            "data": {"list": [mes_inventory_row(0)], "total": 1}
        }
        bulk_create.side_effect = RuntimeError("staging write failed")

        with self.assertRaises(CommandError):
            call_command("fetch_inventory", stdout=StringIO(), stderr=StringIO())

        self.assertTrue(
            StagingInventory.objects.filter(
                pk=self.old_inventory.pk,
                material_code="OLD-RM",
            ).exists()
        )
        self.assertEqual(RawMaterialMESDataset.objects.count(), 0)
        self.assertEqual(cache.get("inventory_fetch_progress")["status"], "error")
