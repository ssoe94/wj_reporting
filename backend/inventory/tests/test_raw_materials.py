from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from inventory.mes import _safe_exception_message
from inventory.models import RawMaterialSyncState
from inventory.services.raw_material_sync import (
    claim_raw_material_sync,
    execute_claimed_raw_material_sync,
)
from inventory.services.raw_materials import (
    PAGE_SIZE,
    _fetch_pages,
    _unit,
    build_raw_material_overview,
    with_zero_stock_markers,
)
from inventory.services.raw_material_storage import save_mes_dataset


TZ = ZoneInfo("Asia/Shanghai")
NOW = datetime(2026, 7, 14, 12, 0, tzinfo=TZ)


def inventory_row(
    *,
    row_id=17000000000000001,
    material_id=17000000000000002,
    material_code="RM-001",
    material_name="Resin",
    warehouse_code="RAW",
    warehouse_name="原材料仓库",
    warehouse_id=17000000000000003,
    amount="10.10",
    unit="kg",
    unit_name=None,
    qc_status=1,
):
    return {
        "id": row_id,
        "updatedAt": int(NOW.timestamp() * 1000),
        "material": {
            "id": material_id,
            "code": material_code,
            "name": material_name,
            "specification": "25kg",
        },
        "amount": {
            "amount": amount,
            "unit": (
                {"code": unit, **({"name": unit_name} if unit_name else {})}
                if unit is not None
                else None
            ),
        },
        "qcStatus": {"code": qc_status, "message": "quality status"},
        "storageLocationDetail": {
            "warehouse": {
                "id": warehouse_id,
                "code": warehouse_code,
                "name": warehouse_name,
            }
        },
    }


def change_row(
    action,
    quantity,
    *,
    direction,
    row_id,
    created_at=NOW,
    unit="kg",
    unit_name=None,
):
    return {
        "id": row_id,
        "createdAt": int(created_at.timestamp() * 1000),
        "action": {"action": action, "desc": action},
        "amount": {
            "amount": {
                "amount": quantity,
                "unit": (
                    {"code": unit, **({"name": unit_name} if unit_name else {})}
                    if unit is not None
                    else None
                ),
            },
            "afterAmount": {
                "amount": "10.1",
                "unit": (
                    {"code": unit, **({"name": unit_name} if unit_name else {})}
                    if unit is not None
                    else None
                ),
            },
            "direction": direction,
        },
        "material": {"id": 17000000000000002, "code": "RM-001", "name": "Resin"},
        "specification": "25kg",
        "warehouse": "原材料仓库",
        "storageLocation": "A-01",
        "batchNo": "B-1",
        "operator": "tester",
        "bizAttr": {"supplierName": "Supplier"},
    }


class RawMaterialServiceTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    def test_all_supported_raw_material_unit_aliases_are_canonical_kg(self):
        for alias in ("UN001", "kg", "KG", "千克", "公斤", "킬로그램"):
            with self.subTest(alias=alias):
                self.assertEqual(_unit({"unit": {"name": alias}}), "kg")

    def test_depleted_raw_material_is_carried_as_an_explicit_zero_marker(self):
        rows = with_zero_stock_markers([], [inventory_row(amount="10")])

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["amount"]["amount"], "0")
        self.assertTrue(rows[0]["syntheticZero"])
        self.assertEqual(
            rows[0]["storageLocationDetail"]["warehouse"]["name"],
            "原材料仓库",
        )

    def test_depleted_explicit_non_kg_row_is_not_carried_forward(self):
        rows = with_zero_stock_markers([], [inventory_row(amount="10", unit="g")])

        self.assertEqual(rows, [])

    def test_code_less_depleted_raw_warehouse_gets_a_zero_marker(self):
        rows = with_zero_stock_markers(
            [],
            [inventory_row(amount="10", warehouse_code="")],
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["amount"]["amount"], "0")
        self.assertTrue(rows[0]["syntheticZero"])

    def test_raw_warehouse_code_appearing_later_does_not_create_a_false_zero(self):
        rows = with_zero_stock_markers(
            [inventory_row(amount="5", warehouse_code="RAW")],
            [inventory_row(amount="10", warehouse_code="")],
        )

        self.assertEqual(len(rows), 1)
        self.assertNotIn("syntheticZero", rows[0])

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_only_exact_raw_material_warehouse_is_exposed_and_selected(
        self, inventory_call, change_call
    ):
        inventory_call.return_value = {
            "data": {
                "list": [
                    inventory_row(),
                    inventory_row(
                        row_id=17000000000000008,
                        warehouse_code="PRODUCT",
                        warehouse_name="成品仓库",
                        warehouse_id=17000000000000009,
                        amount="99",
                    ),
                ],
                "total": 2,
            }
        }
        change_call.return_value = {"list": [], "total": 0}

        result = build_raw_material_overview(now=NOW)

        self.assertEqual(
            [row["name"] for row in result["warehouse_options"]],
            ["原材料仓库"],
        )
        self.assertEqual(
            [row["code"] for row in result["selected_warehouses"]],
            ["RAW"],
        )
        self.assertEqual(result["summary"]["quantities"][0]["current"], 10.1)

    @override_settings(
        MES_RAW_MATERIAL_WAREHOUSE_CODES="RAW",
        MES_RAW_MATERIAL_WAREHOUSE_IDS="17000000000000003",
    )
    @patch("inventory.services.raw_materials.call_inventory_change_log")
    def test_configured_id_backfills_an_existing_staging_warehouse(self, change_call):
        change_call.return_value = {"data": {"list": [], "total": 0}}

        result = build_raw_material_overview(
            now=NOW,
            inventory_rows_override=[inventory_row(warehouse_id=None)],
        )

        self.assertEqual(result["selected_warehouses"][0]["id"], "17000000000000003")
        self.assertEqual(
            change_call.call_args.kwargs["warehouseIds"],
            [17000000000000003],
        )

    @override_settings(
        MES_RAW_MATERIAL_WAREHOUSE_CODES="RAW",
        MES_RAW_MATERIAL_WAREHOUSE_IDS="17000000000000003",
    )
    @patch("inventory.services.raw_materials.call_inventory_change_log")
    def test_code_less_exact_warehouse_merges_into_configured_scope(self, change_call):
        change_call.return_value = {"data": {"list": [], "total": 0}}

        result = build_raw_material_overview(
            now=NOW,
            inventory_rows_override=[
                inventory_row(warehouse_code="", warehouse_id=None)
            ],
        )

        self.assertEqual(
            result["warehouse_options"],
            [
                {
                    "id": "17000000000000003",
                    "code": "RAW",
                    "name": "原材料仓库",
                    "is_raw_material_candidate": True,
                }
            ],
        )
        self.assertEqual(len(result["selected_warehouses"]), 1)
        self.assertEqual(
            change_call.call_args.kwargs["warehouseIds"],
            [17000000000000003],
        )

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_mes_unit_code_and_names_are_normalized_to_kg(
        self, inventory_call, change_call
    ):
        inventory_call.return_value = {
            "data": {
                "list": [inventory_row(unit="UN001", unit_name="千克")],
                "total": 1,
            }
        }
        change_call.return_value = {
            "list": [
                change_row(
                    "out",
                    "2.5",
                    direction=False,
                    row_id=17000000000000004,
                    unit="UN001",
                    unit_name="KG",
                )
            ],
            "total": 1,
        }

        result = build_raw_material_overview(now=NOW)

        self.assertEqual(result["units"], ["kg"])
        self.assertEqual(result["materials"][0]["unit"], "kg")
        self.assertEqual(result["materials"][0]["consumption_quantity"], 2.5)
        self.assertEqual(result["recent_transactions"][0]["unit"], "kg")

    @override_settings(
        MES_RAW_MATERIAL_WAREHOUSE_CODES="RAW",
        MES_RAW_MATERIAL_WAREHOUSE_IDS="17000000000000003",
    )
    @patch("inventory.services.raw_materials.call_inventory_change_log")
    def test_configured_empty_raw_warehouse_still_fetches_movements(self, change_call):
        change_call.return_value = {"data": {"list": [], "total": 0}}

        result = build_raw_material_overview(
            now=NOW,
            inventory_rows_override=[],
        )

        self.assertEqual(result["selected_warehouses"][0]["code"], "RAW")
        self.assertEqual(result["selected_warehouses"][0]["id"], "17000000000000003")
        change_call.assert_called_once()
        self.assertEqual(
            change_call.call_args.kwargs["warehouseIds"],
            [17000000000000003],
        )

    def test_pagination_continues_when_mes_total_is_zero(self):
        page_one = [{"id": index} for index in range(PAGE_SIZE)]
        fetcher = Mock(
            side_effect=[
                {"data": {"list": page_one, "total": 0}},
                {"data": {"list": [{"id": PAGE_SIZE}], "total": 0}},
            ]
        )

        rows, cached, warnings = _fetch_pages(
            fetcher, cache_kind="pagination-test", filters={"sample": True}
        )

        self.assertEqual(len(rows), PAGE_SIZE + 1)
        self.assertFalse(cached)
        self.assertEqual(warnings, [])
        self.assertEqual(fetcher.call_count, 2)

    def test_pagination_removes_overlapping_record_ids_and_marks_partial(self):
        page_one = [{"id": index} for index in range(PAGE_SIZE)]
        fetcher = Mock(
            side_effect=[
                {"data": {"list": page_one, "total": 0}},
                {"data": {"list": [{"id": PAGE_SIZE - 1}, {"id": PAGE_SIZE}], "total": 0}},
            ]
        )

        rows, cached, warnings = _fetch_pages(
            fetcher, cache_kind="overlap-test", filters={"sample": True}
        )

        self.assertEqual(len(rows), PAGE_SIZE + 1)
        self.assertFalse(cached)
        self.assertTrue(any("overlapping" in warning for warning in warnings))

    def test_pagination_marks_short_page_before_declared_total_incomplete(self):
        page_one = [{"id": index} for index in range(PAGE_SIZE)]
        fetcher = Mock(
            side_effect=[
                {"data": {"list": page_one, "total": PAGE_SIZE + 50}},
                {"data": {"list": [{"id": PAGE_SIZE}], "total": PAGE_SIZE + 50}},
            ]
        )

        rows, cached, warnings = _fetch_pages(
            fetcher,
            cache_kind="short-total-test",
            filters={"sample": True},
        )

        self.assertEqual(len(rows), PAGE_SIZE + 1)
        self.assertFalse(cached)
        self.assertTrue(any("short page" in warning for warning in warnings))

    def test_force_refresh_bypasses_a_successful_cached_page_set(self):
        first = Mock(return_value={"data": {"list": [{"id": 1}], "total": 1}})
        second = Mock(return_value={"data": {"list": [{"id": 2}], "total": 1}})

        cached_rows, cached, _ = _fetch_pages(
            first, cache_kind="refresh-test", filters={"sample": True}
        )
        refreshed_rows, refreshed_from_cache, _ = _fetch_pages(
            second,
            cache_kind="refresh-test",
            filters={"sample": True},
            force_refresh=True,
        )

        self.assertEqual(cached_rows, [{"id": 1}])
        self.assertFalse(cached)
        self.assertEqual(refreshed_rows, [{"id": 2}])
        self.assertFalse(refreshed_from_cache)
        second.assert_called_once()

    def test_cache_key_can_ignore_moving_change_log_end_time(self):
        first = Mock(return_value={"data": {"list": [{"id": 1}], "total": 1}})
        second = Mock(return_value={"data": {"list": [{"id": 2}], "total": 1}})
        stable_key = {"dateStart": 100, "warehouseIds": [1]}

        _fetch_pages(
            first,
            cache_kind="change-cache-test",
            filters={**stable_key, "dateEnd": 200},
            cache_key_filters=stable_key,
        )
        rows, cached, _ = _fetch_pages(
            second,
            cache_kind="change-cache-test",
            filters={**stable_key, "dateEnd": 300},
            cache_key_filters=stable_key,
        )

        self.assertTrue(cached)
        self.assertEqual(rows, [{"id": 1}])
        second.assert_not_called()

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_overview_aggregates_by_unit_and_keeps_ids_as_strings(
        self, inventory_call, change_call
    ):
        inventory_call.return_value = {"data": {"list": [inventory_row()], "total": 1}}
        change_call.return_value = {
            "list": [
                change_row("receive", "4.00", direction=True, row_id=17000000000000004),
                change_row("out", "2.50", direction=False, row_id=17000000000000005),
                change_row("amount_adjust", "0.50", direction=False, row_id=17000000000000006),
            ],
            "total": 0,
        }

        result = build_raw_material_overview(
            lookback_days=7,
            lead_time_days=2,
            review_period_days=1,
            now=NOW,
        )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["warehouse_options"][0]["id"], "17000000000000003")
        self.assertTrue(result["warehouse_options"][0]["is_raw_material_candidate"])
        material = result["materials"][0]
        self.assertEqual(material["material_id"], "17000000000000002")
        self.assertEqual(material["current_quantity"], 10.1)
        self.assertEqual(material["inbound_quantity"], 4.0)
        self.assertEqual(material["outbound_quantity"], 2.5)
        self.assertEqual(material["consumption_quantity"], 2.5)
        self.assertEqual(material["adjustment_quantity"], -0.5)
        self.assertEqual(result["summary"]["quantities"][0]["unit"], "kg")
        self.assertEqual(result["recent_transactions"][0]["id"], "17000000000000004")
        self.assertTrue(any(row["is_consumption"] for row in result["recent_transactions"]))
        self.assertTrue(result["meta"]["recommendations_available"])
        self.assertTrue(material["recommendation_available"])
        sent_filters = change_call.call_args.kwargs
        self.assertEqual(sent_filters["warehouseIds"], [17000000000000003])

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_reorder_uses_only_accepted_and_concession_inventory(
        self, inventory_call, change_call
    ):
        inventory_call.return_value = {
            "data": {
                "list": [
                    inventory_row(amount="2", qc_status=1),
                    inventory_row(
                        row_id=17000000000000008, amount="100", qc_status=4
                    ),
                ],
                "total": 2,
            }
        }
        change_call.return_value = {
            "list": [
                change_row(
                    "out",
                    "7",
                    direction=False,
                    row_id=17000000000000007,
                    created_at=datetime(2026, 7, 13, 12, 0, tzinfo=TZ),
                )
            ],
            "total": 1,
        }

        result = build_raw_material_overview(
            lookback_days=7,
            lead_time_days=1,
            review_period_days=0,
            now=NOW,
        )

        material = result["materials"][0]
        self.assertEqual(material["current_quantity"], 102)
        self.assertEqual(material["usable_quantity"], 2)
        self.assertEqual(material["restricted_quantity"], 100)
        self.assertEqual(material["avg_daily_consumption"], 1)
        self.assertGreater(material["recommended_order"], 0)

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_active_business_day_is_excluded_from_reorder_statistics(
        self, inventory_call, change_call
    ):
        inventory_call.return_value = {"data": {"list": [inventory_row()], "total": 1}}
        change_call.return_value = {
            "list": [change_row("out", "7", direction=False, row_id=8)],
            "total": 1,
        }

        result = build_raw_material_overview(lookback_days=7, now=NOW)

        self.assertEqual(result["materials"][0]["consumption_quantity"], 7)
        self.assertEqual(result["materials"][0]["avg_daily_consumption"], 0)
        self.assertEqual(result["meta"]["statistics_range_end"], "2026-07-13")

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_inventory_freshness_is_not_overstated_by_a_newer_change_record(
        self, inventory_call, change_call
    ):
        inventory = inventory_row()
        inventory_updated_at = datetime(2026, 7, 13, 9, 0, tzinfo=TZ)
        inventory["updatedAt"] = int(inventory_updated_at.timestamp() * 1000)
        inventory_call.return_value = {"data": {"list": [inventory], "total": 1}}
        change_call.return_value = {
            "list": [change_row("out", "1", direction=False, row_id=81)],
            "total": 1,
        }

        result = build_raw_material_overview(lookback_days=7, now=NOW)

        self.assertEqual(
            result["meta"]["inventory_source_latest_at"],
            inventory_updated_at.isoformat(),
        )
        self.assertEqual(result["meta"]["source_latest_at"], inventory_updated_at.isoformat())
        self.assertEqual(result["meta"]["change_log_source_latest_at"], NOW.isoformat())

    def test_mes_exception_sanitizer_removes_access_tokens(self):
        message = _safe_exception_message(
            RuntimeError("POST https://mes.example/path?access_token=top-secret&foo=1 failed")
        )

        self.assertNotIn("top-secret", message)
        self.assertIn("access_token=[redacted]", message)

    def test_mes_exception_sanitizer_removes_body_and_bearer_secrets(self):
        message = _safe_exception_message(
            RuntimeError(
                'Authorization: Bearer bearer-secret appSecret="body-secret" user_code=auth-code'
            )
        )

        self.assertNotIn("bearer-secret", message)
        self.assertNotIn("body-secret", message)
        self.assertNotIn("auth-code", message)

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_change_rows_without_a_timestamp_are_skipped(self, inventory_call, change_call):
        inventory_call.return_value = {"data": {"list": [inventory_row()], "total": 1}}
        invalid = change_row("out", "4", direction=False, row_id=9)
        invalid["createdAt"] = None
        change_call.return_value = {"list": [invalid], "total": 1}

        result = build_raw_material_overview(lookback_days=7, now=NOW)

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["materials"][0]["consumption_quantity"], 0)
        self.assertFalse(result["materials"][0]["recommendation_available"])
        self.assertEqual(result["recent_transactions"], [])
        self.assertTrue(
            any("invalid timestamp" in warning for warning in result["meta"]["warnings"])
        )
        self.assertIn(
            {"code": "change_timestamp_invalid", "params": {"count": 1}},
            result["meta"]["warning_details"],
        )

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_does_not_guess_a_non_raw_material_warehouse(self, inventory_call, change_call):
        inventory_call.return_value = {
            "data": {
                "list": [inventory_row(warehouse_code="Product", warehouse_name="成品仓库")],
                "total": 1,
            }
        }

        result = build_raw_material_overview(now=NOW)

        self.assertEqual(result["status"], "selection_required")
        self.assertEqual(result["selected_warehouses"], [])
        self.assertEqual(result["materials"], [])
        self.assertEqual(result["trend"], [])
        change_call.assert_not_called()

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_change_log_failure_returns_current_inventory_as_partial(
        self, inventory_call, change_call
    ):
        inventory_call.return_value = {"data": {"list": [inventory_row()], "total": 1}}
        change_call.side_effect = RuntimeError(
            "GET https://mes.example/api?access_token=super-secret&foo=1 timeout"
        )

        result = build_raw_material_overview(now=NOW)

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["materials"][0]["current_quantity"], 10.1)
        self.assertEqual(result["meta"]["sources"]["inventory_change_log"]["status"], "error")
        self.assertFalse(result["meta"]["recommendations_available"])
        self.assertFalse(result["materials"][0]["recommendation_available"])
        self.assertEqual(result["materials"][0]["risk"], "unknown")
        self.assertEqual(result["summary"]["recommendation_unavailable_count"], 1)
        self.assertTrue(result["meta"]["warnings"])
        self.assertNotIn("super-secret", " ".join(result["meta"]["warnings"]))

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_direction_flag_is_authoritative_and_business_day_starts_at_eight(
        self, inventory_call, change_call
    ):
        inventory_call.return_value = {"data": {"list": [inventory_row()], "total": 1}}
        conflict = change_row("out", "2.50", direction=True, row_id=77)
        conflict["createdAt"] = int(
            datetime(2026, 7, 14, 7, 30, tzinfo=TZ).timestamp() * 1000
        )
        change_call.return_value = {"list": [conflict], "total": 1}

        result = build_raw_material_overview(lookback_days=7, now=NOW)

        material = result["materials"][0]
        self.assertEqual(material["inbound_quantity"], 2.5)
        self.assertEqual(material["outbound_quantity"], 0)
        self.assertEqual(material["consumption_quantity"], 0)
        previous_business_day = next(
            row for row in result["trend"] if row["date"] == "2026-07-13"
        )
        self.assertEqual(previous_business_day["values"][0]["inbound"], 2.5)
        self.assertTrue(
            any("conflict" in warning for warning in result["meta"]["warnings"])
        )
        self.assertFalse(material["recommendation_available"])

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_missing_warehouse_id_never_falls_back_to_unfiltered_change_log(
        self, inventory_call, change_call
    ):
        inventory_call.return_value = {
            "data": {
                "list": [inventory_row(warehouse_id=None)],
                "total": 1,
            }
        }

        result = build_raw_material_overview(now=NOW)

        change_call.assert_not_called()
        self.assertEqual(
            result["meta"]["sources"]["inventory_change_log"]["status"], "skipped"
        )
        self.assertFalse(result["meta"]["recommendations_available"])

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_missing_units_use_the_raw_warehouse_kg_default(
        self, inventory_call, change_call
    ):
        inventory_call.return_value = {
            "data": {
                "list": [
                    inventory_row(unit=None, amount="2"),
                    inventory_row(
                        row_id=17000000000000009,
                        material_id=17000000000000010,
                        material_code="RM-002",
                        material_name="Additive",
                        unit=None,
                        amount="3",
                    ),
                ],
                "total": 2,
            }
        }
        change_call.return_value = {"list": [], "total": 0}

        result = build_raw_material_overview(now=NOW)

        self.assertEqual(result["units"], ["kg"])
        self.assertEqual(result["summary"]["quantities"][0]["current"], 5)
        self.assertEqual(
            result["meta"]["warning_details"],
            [
                {
                    "code": "unit_assumed_kg",
                    "params": {
                        "count": 2,
                        "source_counts": {"inventory_detail": 2},
                    },
                }
            ],
        )

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_explicit_non_kg_is_excluded_without_downgrading_complete_sources(
        self, inventory_call, change_call
    ):
        kg_row = inventory_row(amount="2", unit="kg")
        kg_updated_at = datetime(2026, 7, 13, 9, 0, tzinfo=TZ)
        kg_row["updatedAt"] = int(kg_updated_at.timestamp() * 1000)
        inventory_call.return_value = {
            "data": {
                "list": [
                    kg_row,
                    inventory_row(
                        row_id=17000000000000011,
                        amount="300",
                        unit="UN001",
                        unit_name="g",
                    ),
                ],
                "total": 2,
            }
        }
        change_call.return_value = {
            "list": [
                change_row(
                    "out",
                    "25",
                    direction=False,
                    row_id=17000000000000012,
                    unit="L",
                )
            ],
            "total": 1,
        }

        result = build_raw_material_overview(now=NOW)

        quantities = {row["unit"]: row["current"] for row in result["summary"]["quantities"]}
        self.assertEqual(quantities, {"kg": 2.0})
        self.assertEqual(len(result["materials"]), 1)
        self.assertIn(
            {
                "code": "unexpected_unit",
                "params": {
                    "count": 2,
                    "units": ["L", "g"],
                    "source_counts": {
                        "inventory_change_log": 1,
                        "inventory_detail": 1,
                    },
                },
            },
            result["meta"]["warning_details"],
        )
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["summary"]["inventory_record_count"], 1)
        self.assertEqual(
            result["meta"]["inventory_source_latest_at"],
            kg_updated_at.isoformat(),
        )
        self.assertTrue(result["materials"][0]["recommendation_available"])
        self.assertTrue(result["meta"]["recommendations_available"])
        # The raw-material sync promotes only complete MES sources. Safely
        # excluded business-unit anomalies must not make that gate fail.
        self.assertEqual(result["meta"]["sources"]["inventory_detail"]["status"], "ok")
        self.assertEqual(
            result["meta"]["sources"]["inventory_change_log"]["status"],
            "ok",
        )

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_transfer_issue_is_separate_from_consumption_and_receive_is_inbound(
        self, inventory_call, change_call
    ):
        inventory_call.return_value = {"data": {"list": [inventory_row()], "total": 1}}
        completed_day = datetime(2026, 7, 13, 12, 0, tzinfo=TZ)
        change_call.return_value = {
            "list": [
                change_row("issue", "3", direction=False, row_id=12, created_at=completed_day),
                change_row("receive", "3", direction=True, row_id=13, created_at=completed_day),
            ],
            "total": 2,
        }

        result = build_raw_material_overview(lookback_days=7, now=NOW)

        material = result["materials"][0]
        self.assertEqual(material["outbound_quantity"], 3)
        self.assertEqual(material["inbound_quantity"], 3)
        self.assertEqual(material["consumption_quantity"], 0)
        self.assertEqual(material["transfer_out_quantity"], 3)
        self.assertTrue(material["recommendation_available"])


class RawMaterialSyncPromotionRegressionTests(TestCase):
    @patch("inventory.services.raw_material_sync.build_raw_material_overview")
    @patch("inventory.services.raw_material_sync.load_pending_inventory_dataset")
    @patch("inventory.services.raw_material_sync.call_command")
    def test_partial_report_with_complete_sources_is_promoted(
        self, call_command, load_pending, build_overview
    ):
        _claimed, claimed_state = claim_raw_material_sync("manual")
        load_pending.return_value = SimpleNamespace(
            rows=[inventory_row(amount="2")],
            warehouse_codes=("RAW",),
            warehouse_ids=("17000000000000003",),
            source_latest_at=None,
            snapshot_date=date(2026, 7, 14),
        )
        build_overview.return_value = {
            "status": "partial",
            "meta": {
                "sources": {
                    "inventory_detail": {"status": "ok"},
                    "inventory_change_log": {"status": "ok"},
                },
                "change_log_source_latest_at": None,
                "warning_details": [
                    {
                        "code": "unexpected_unit",
                        "params": {"count": 1, "units": ["L"]},
                    }
                ],
            },
            "summary": {"material_count": 1},
            "selected_warehouses": [
                {"code": "RAW", "id": "17000000000000003"}
            ],
        }

        result = execute_claimed_raw_material_sync(
            trigger="manual",
            claimed_started_at=claimed_state["started_at"],
        )

        self.assertEqual(result["status"], RawMaterialSyncState.STATUS_COMPLETED)
        call_command.assert_called_once()


class RawMaterialOverviewViewTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.user = get_user_model().objects.create_user(
            username="raw-material-viewer", password="unused"
        )

    def test_authentication_is_required(self):
        response = self.client.get("/api/inventory/raw-materials/overview/")
        self.assertEqual(response.status_code, 401)

    def test_mes_debug_endpoint_is_not_public(self):
        response = self.client.get("/api/inventory/mes-test/")
        self.assertEqual(response.status_code, 401)

    @patch("inventory.services.raw_materials.call_inventory_change_log")
    @patch("inventory.services.raw_materials.call_inventory_list")
    def test_overview_reads_saved_snapshots_without_contacting_mes(
        self, inventory_call, change_call
    ):
        warehouse_id = "17000000000000003"
        save_mes_dataset(
            "inventory",
            [inventory_row(amount="10", unit="UN001")],
            snapshot_date=date(2026, 7, 13),
        )
        save_mes_dataset(
            "inventory",
            [inventory_row(amount="14", unit="UN001", unit_name="千克")],
            snapshot_date=date(2026, 7, 14),
        )
        save_mes_dataset(
            "inventory",
            [inventory_row(amount="20", unit="KG")],
            snapshot_date=date(2026, 7, 14),
            capture_type="manual",
        )
        save_mes_dataset(
            "change",
            [],
            warehouse_codes=("RAW",),
            warehouse_ids=(warehouse_id,),
            lookback_days=30,
            range_start=datetime(2026, 6, 14, 8, 0, tzinfo=TZ),
            range_end=datetime(2026, 7, 14, 12, 0, tzinfo=TZ),
        )
        save_mes_dataset(
            "change",
            [],
            warehouse_codes=("RAW",),
            warehouse_ids=(warehouse_id,),
            lookback_days=30,
            range_start=datetime(2026, 6, 14, 8, 0, tzinfo=TZ),
            range_end=datetime(2026, 7, 14, 13, 0, tzinfo=TZ),
            capture_type="manual",
        )
        self.client.force_authenticate(self.user)

        response = self.client.get("/api/inventory/raw-materials/overview/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["meta"]["data_mode"], "stored")
        self.assertTrue(payload["meta"]["comparison_available"])
        self.assertEqual(payload["materials"][0]["current_quantity"], 20)
        self.assertEqual(
            payload["materials"][0]["comparison_current_quantity"], 14
        )
        self.assertEqual(payload["materials"][0]["previous_quantity"], 10)
        self.assertEqual(payload["materials"][0]["quantity_change_24h"], 4)
        inventory_call.assert_not_called()
        change_call.assert_not_called()

    def test_rejects_out_of_range_lookback(self):
        self.client.force_authenticate(self.user)
        response = self.client.get(
            "/api/inventory/raw-materials/overview/", {"lookback_days": "31"}
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("lookback_days", response.json()["error"])

    @patch("inventory.raw_material_views.build_raw_material_overview")
    def test_ignores_arbitrary_warehouse_query_parameters(self, build):
        build.return_value = {
            "status": "ok",
            "meta": {},
            "warehouse_options": [],
            "selected_warehouses": [],
            "units": [],
            "summary": {},
            "trend": [],
            "materials": [],
            "recent_transactions": [],
        }
        self.client.force_authenticate(self.user)

        response = self.client.get(
            "/api/inventory/raw-materials/overview/?warehouse_code=RAW,RAW2&warehouse_codes=RAW3&lookback_days=7&refresh=true"
        )
        cached_response = self.client.get(
            "/api/inventory/raw-materials/overview/?warehouse_code=RAW,RAW2&warehouse_codes=RAW3&lookback_days=7&refresh=true"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(cached_response.status_code, 200)
        self.assertNotIn("warehouse_codes", build.call_args.kwargs)
        self.assertEqual(build.call_args.kwargs["lookback_days"], 7)
        self.assertTrue(build.call_args.kwargs["prefer_stored"])
        self.assertNotIn("force_refresh", build.call_args.kwargs)
        self.assertEqual(build.call_count, 1)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(response["Pragma"], "no-cache")
