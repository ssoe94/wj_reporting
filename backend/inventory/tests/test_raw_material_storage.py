from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.test import TestCase

from inventory.models import (
    RawMaterialMESDataset,
    RawMaterialSyncState,
    StagingInventory,
)
from inventory.services.raw_material_storage import (
    load_change_dataset,
    load_inventory_dataset,
    load_inventory_history,
    load_staging_inventory_rows,
    save_mes_dataset,
)


SHANGHAI = ZoneInfo("Asia/Shanghai")
BIG_MES_ID = 17_284_622_643_881_151


class RawMaterialDatasetStorageTests(TestCase):
    def test_sync_state_uses_a_single_known_coordination_row(self):
        state, created = RawMaterialSyncState.objects.get_or_create(
            pk=RawMaterialSyncState.SINGLETON_PK
        )
        same_state, created_again = RawMaterialSyncState.objects.get_or_create(
            pk=RawMaterialSyncState.SINGLETON_PK
        )

        self.assertTrue(created)
        self.assertFalse(created_again)
        self.assertEqual(state.pk, 1)
        self.assertEqual(same_state.pk, state.pk)
        self.assertEqual(RawMaterialSyncState.objects.count(), 1)
        self.assertEqual(state.status, RawMaterialSyncState.STATUS_IDLE)

        started_at = datetime(2026, 7, 14, 8, 0, tzinfo=SHANGHAI)
        finished_at = datetime(2026, 7, 14, 8, 5, tzinfo=SHANGHAI)
        state.status = RawMaterialSyncState.STATUS_COMPLETED
        state.trigger = RawMaterialSyncState.TRIGGER_DAILY
        state.message = "4,200 rows stored"
        state.started_at = started_at
        state.finished_at = finished_at
        state.save()
        state.refresh_from_db()

        self.assertEqual(state.status, RawMaterialSyncState.STATUS_COMPLETED)
        self.assertEqual(state.trigger, RawMaterialSyncState.TRIGGER_DAILY)
        self.assertEqual(state.message, "4,200 rows stored")
        self.assertEqual(state.started_at, started_at)
        self.assertEqual(state.finished_at, finished_at)
        self.assertIsNotNone(state.updated_at)

    def test_inventory_scope_is_deterministic_and_daily_history_is_retained(self):
        first = save_mes_dataset(
            RawMaterialMESDataset.KIND_INVENTORY,
            [
                {
                    "id": BIG_MES_ID,
                    "material": {"id": BIG_MES_ID + 1, "code": "RM-001"},
                    "warehouseIds": [BIG_MES_ID + 2],
                    "updatedAt": 1_721_015_200_000,
                }
            ],
            warehouse_codes=("RAW-B", "RAW-A", "RAW-A"),
            warehouse_ids=(BIG_MES_ID + 2, str(BIG_MES_ID + 3)),
            snapshot_date=date(2026, 7, 13),
            source_latest_at=datetime(2026, 7, 13, 8, 0, tzinfo=SHANGHAI),
        )
        rerun = save_mes_dataset(
            RawMaterialMESDataset.KIND_INVENTORY,
            [{"id": BIG_MES_ID + 10, "material": {"id": BIG_MES_ID + 11}}],
            warehouse_codes=("RAW-A", "RAW-B"),
            warehouse_ids=(str(BIG_MES_ID + 3), BIG_MES_ID + 2),
            snapshot_date="2026-07-13",
        )

        self.assertEqual(first.rows[0]["id"], str(BIG_MES_ID))
        self.assertEqual(first.rows[0]["material"]["id"], str(BIG_MES_ID + 1))
        self.assertEqual(first.rows[0]["warehouseIds"], [str(BIG_MES_ID + 2)])
        self.assertEqual(rerun.id, first.id)
        self.assertEqual(RawMaterialMESDataset.objects.count(), 1)
        self.assertEqual(rerun.record_count, 1)
        self.assertEqual(rerun.warehouse_codes, ("RAW-A", "RAW-B"))
        self.assertEqual(
            rerun.warehouse_ids,
            (str(BIG_MES_ID + 2), str(BIG_MES_ID + 3)),
        )
        self.assertEqual(rerun.rows[0]["id"], str(BIG_MES_ID + 10))
        self.assertEqual(rerun.rows[0]["material"]["id"], str(BIG_MES_ID + 11))

        current = save_mes_dataset(
            RawMaterialMESDataset.KIND_INVENTORY,
            [{"id": BIG_MES_ID + 20}],
            warehouse_codes=("RAW-A", "RAW-B"),
            warehouse_ids=(BIG_MES_ID + 2, BIG_MES_ID + 3),
            snapshot_date=date(2026, 7, 14),
        )
        manual_current = save_mes_dataset(
            RawMaterialMESDataset.KIND_INVENTORY,
            [{"id": BIG_MES_ID + 21}],
            warehouse_codes=("RAW-A", "RAW-B"),
            warehouse_ids=(BIG_MES_ID + 2, BIG_MES_ID + 3),
            snapshot_date=date(2026, 7, 14),
            capture_type=RawMaterialMESDataset.CAPTURE_MANUAL,
        )
        save_mes_dataset(
            RawMaterialMESDataset.KIND_INVENTORY,
            [{"id": BIG_MES_ID + 30}],
            warehouse_codes=("RAW-A", "RAW-B"),
            warehouse_ids=(BIG_MES_ID + 2, BIG_MES_ID + 3),
            snapshot_date=date(2026, 7, 12),
        )

        self.assertNotEqual(current.id, first.id)
        self.assertNotEqual(manual_current.id, current.id)
        self.assertEqual(load_inventory_dataset().id, manual_current.id)
        history = load_inventory_history(limit=2)
        self.assertEqual(history[0].id, current.id)
        self.assertEqual(
            [dataset.snapshot_date for dataset in history],
            [date(2026, 7, 14), date(2026, 7, 13)],
        )

    def test_change_loader_matches_scope_and_smallest_sufficient_window(self):
        warehouse_id = BIG_MES_ID
        save_mes_dataset(
            RawMaterialMESDataset.KIND_CHANGE,
            [{"id": 1}],
            warehouse_codes=("RAW",),
            warehouse_ids=(warehouse_id,),
            lookback_days=30,
            range_start=datetime(2026, 6, 13, 8, 0, tzinfo=SHANGHAI),
            range_end=datetime(2026, 7, 13, 8, 0, tzinfo=SHANGHAI),
        )
        current_30 = save_mes_dataset(
            RawMaterialMESDataset.KIND_CHANGE,
            [{"id": 2, "materialId": BIG_MES_ID + 1}],
            warehouse_codes=("RAW",),
            warehouse_ids=(str(warehouse_id),),
            lookback_days=30,
            range_start=datetime(2026, 6, 14, 8, 0, tzinfo=SHANGHAI),
            range_end=datetime(2026, 7, 14, 8, 0, tzinfo=SHANGHAI),
        )
        current_60 = save_mes_dataset(
            RawMaterialMESDataset.KIND_CHANGE,
            [{"id": 3}],
            warehouse_codes=("RAW",),
            warehouse_ids=(warehouse_id,),
            lookback_days=60,
            range_start=datetime(2026, 5, 15, 8, 0, tzinfo=SHANGHAI),
            range_end=datetime(2026, 7, 14, 8, 0, tzinfo=SHANGHAI),
        )

        selected_30 = load_change_dataset(("RAW",), (warehouse_id,), 20)
        selected_60 = load_change_dataset(("RAW",), (warehouse_id,), 31)

        self.assertEqual(selected_30.id, current_30.id)
        self.assertEqual(selected_30.snapshot_date, date(2026, 7, 14))
        self.assertEqual(selected_30.rows[0]["id"], "2")
        self.assertEqual(
            selected_30.rows[0]["materialId"],
            str(BIG_MES_ID + 1),
        )
        self.assertEqual(selected_60.id, current_60.id)
        self.assertIsNone(load_change_dataset(("OTHER",), (warehouse_id,), 20))
        self.assertIsNone(load_change_dataset(("RAW",), (warehouse_id + 99,), 20))

        same_day_rerun = save_mes_dataset(
            RawMaterialMESDataset.KIND_CHANGE,
            [{"id": 4}],
            warehouse_codes=("RAW",),
            warehouse_ids=(warehouse_id,),
            lookback_days=30,
            range_start=datetime(2026, 6, 14, 9, 0, tzinfo=SHANGHAI),
            range_end=datetime(2026, 7, 14, 12, 0, tzinfo=SHANGHAI),
        )
        self.assertEqual(same_day_rerun.id, current_30.id)
        self.assertEqual(
            RawMaterialMESDataset.objects.filter(
                kind=RawMaterialMESDataset.KIND_CHANGE,
                lookback_days=30,
            ).count(),
            2,
        )

    def test_change_loader_can_reuse_a_saved_superset_warehouse_scope(self):
        raw_a_id = BIG_MES_ID
        raw_b_id = BIG_MES_ID + 1
        saved = save_mes_dataset(
            RawMaterialMESDataset.KIND_CHANGE,
            [{"id": 11}],
            warehouse_codes=("RAW-A", "RAW-B"),
            warehouse_ids=(raw_a_id, raw_b_id),
            lookback_days=30,
            range_start=datetime(2026, 6, 14, 8, 0, tzinfo=SHANGHAI),
            range_end=datetime(2026, 7, 14, 8, 0, tzinfo=SHANGHAI),
        )

        selected = load_change_dataset(("RAW-A",), (raw_a_id,), 14)

        self.assertEqual(selected.id, saved.id)

    def test_change_loader_prefers_newer_snapshot_over_older_narrow_window(self):
        warehouse_id = BIG_MES_ID
        save_mes_dataset(
            RawMaterialMESDataset.KIND_CHANGE,
            [{"id": 21}],
            warehouse_codes=("RAW",),
            warehouse_ids=(warehouse_id,),
            lookback_days=7,
            range_end=datetime(2026, 7, 13, 8, 0, tzinfo=SHANGHAI),
        )
        current = save_mes_dataset(
            RawMaterialMESDataset.KIND_CHANGE,
            [{"id": 22}],
            warehouse_codes=("RAW",),
            warehouse_ids=(warehouse_id,),
            lookback_days=30,
            range_end=datetime(2026, 7, 14, 8, 0, tzinfo=SHANGHAI),
        )

        selected = load_change_dataset(("RAW",), (warehouse_id,), 7)

        self.assertEqual(selected.id, current.id)

    def test_staging_rows_are_converted_to_mes_shape_with_string_ids(self):
        updated_at = datetime(2026, 7, 14, 8, 15, tzinfo=SHANGHAI)
        staging = StagingInventory.objects.create(
            material_id=BIG_MES_ID,
            material_code="PCABS-001",
            qr_code="QR-001",
            label_code="LABEL-001",
            composite_key="LABEL-001::PCABS-001",
            material_name="PCABS Resin",
            specification="Black",
            biz_type="1",
            warehouse_code="RAW",
            warehouse_name="原材料仓库",
            location_name="A-01-01",
            storage_status="1",
            qc_status="1",
            work_order_code="WO-001",
            quantity=Decimal("12.3400"),
            unit="kg",
            updated_at=updated_at,
        )

        rows, latest = load_staging_inventory_rows()

        self.assertEqual(latest, updated_at)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["id"], str(staging.pk))
        self.assertEqual(row["material"]["id"], str(BIG_MES_ID))
        self.assertEqual(row["material"]["code"], "PCABS-001")
        self.assertEqual(row["amount"]["amount"], "12.3400")
        self.assertEqual(row["amount"]["unit"]["code"], "kg")
        self.assertEqual(row["qcStatus"]["code"], 1)
        self.assertEqual(
            row["storageLocationDetail"]["warehouse"]["name"],
            "原材料仓库",
        )
        self.assertEqual(row["workOrderSimpleInfos"], [{"code": "WO-001"}])
        self.assertEqual(row["updatedAt"], int(updated_at.timestamp() * 1000))
