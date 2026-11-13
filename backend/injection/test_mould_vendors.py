"""Vendor destinations refine inventory without changing MES repair/status facts."""

import copy
import hashlib
import json
import unittest
from unittest.mock import patch

from injection.mould_inventory import (
    decorate_inventory_board,
    decorate_inventory_detail,
    latest_movement,
)
from injection.test_mould_inventory import (
    CONFIRMED_ASSET,
    CORRECTED_NT1_ASSET,
    board,
    groups,
    mould,
    movement,
    source_entries,
)


# Exact spellings observed in the read-only vendor inventory investigation.
# Live population sizes are deliberately not fixtures or business constants.
VENDORS = (
    ("TIANLU", "天路", "external", "南京天路新材料科技有限公司"),
    ("VENDOR:ZIJIN", "紫金", "external", "句容紫金辰龙塑料电子有限公司"),
    ("VENDOR:YUEHEBAO", "跃和保", "external", "南京跃和保电子有限公司"),
    ("VENDOR:PINJIE", "品捷", "external", "滁州品捷模塑有限公司"),
    ("VENDOR:TAIZHIKE", "泰之科", "repair", "苏州泰之科模具有限公司"),
    ("VENDOR:GUANGLI", "广立", "repair", "丹阳广立模塑有限公司"),
    ("VENDOR:SUOBOTE", "索博特", "external", "苏州索博特模具有限公司"),
    ("VENDOR:LG", "LG", "external", "LG电子"),
    ("VENDOR:HUASHAN", "华山", "external", "南京华山喷涂有限公司"),
    ("VENDOR:SUHONG", "速鸿", "external", "南京速鸿电子科技有限公司"),
    ("VENDOR:HAILE", "海勒", "external", "南京海勒汽车电子科技有限公司"),
    ("VENDOR:YINGCHANG", "映昌", "external", "映昌"),
)


def with_history(row, history):
    return {**row, "last_movement": latest_movement(history)}


class MouldVendorClassificationTests(unittest.TestCase):
    def test_observed_exact_vendor_destinations_have_explicit_business_categories(self):
        for site, name, category, alias in VENDORS:
            with self.subTest(destination=alias):
                result = decorate_inventory_board(board(mould(location_code=alias)))
                inventory = result["moulds"][0]["inventory"]
                self.assertEqual(inventory["site"], site)
                self.assertEqual(inventory["vendor"], {"key": site, "name": name, "category": category})
                self.assertEqual(inventory["basis"], "mes_location")
                self.assertEqual(groups(result)[site]["name"], name)
                self.assertEqual(groups(result)[site]["category"], category)

    def test_new_vendor_aliases_do_not_match_company_name_fragments(self):
        for destination in (
            "苏州泰之科模具有限公司配件",
            "非丹阳广立模塑有限公司",
            "广立新厂",
            "泰之科技",
            "ZIJINX",
        ):
            with self.subTest(destination=destination):
                result = decorate_inventory_board(board(mould(location_code=destination)))
                inventory = result["moulds"][0]["inventory"]
                self.assertNotIn(inventory["site"], {"VENDOR:GUANGLI", "VENDOR:TAIZHIKE", "VENDOR:ZIJIN"})
                vendor = inventory.get("vendor")
                if vendor is not None:
                    self.assertEqual(vendor["category"], "external")

    def test_supplier_and_classification_fields_cannot_create_vendor_location(self):
        row = mould(
            manufacturer="丹阳广立模塑有限公司",
            classification="苏州泰之科模具有限公司",
            name="句容紫金辰龙塑料电子有限公司模具",
            repair_status="维修中",
        )
        result = decorate_inventory_board(board(row))

        inventory = result["moulds"][0]["inventory"]
        self.assertEqual(inventory["site"], "UNCONFIRMED")
        self.assertIsNone(inventory["vendor"])
        self.assertEqual(result["moulds"][0]["repair_status"], "维修中")

    def test_unknown_company_is_external_even_when_name_says_mould_or_repair(self):
        for company in ("苏州新伙伴模具有限公司", "南京新伙伴模具维修有限公司"):
            with self.subTest(company=company):
                result = decorate_inventory_board(board(mould(location_code=company)))
                inventory = result["moulds"][0]["inventory"]
                self.assertTrue(inventory["site"].startswith("VENDOR:"))
                self.assertEqual(inventory["vendor"]["key"], inventory["site"])
                self.assertEqual(inventory["vendor"]["category"], "external")
                self.assertEqual(groups(result)[inventory["site"]]["category"], "external")
                self.assertEqual(groups(result)[inventory["site"]]["mould_count"], 1)

    def test_location_parent_can_name_vendor_only_when_current_position_is_generic(self):
        for location_code, kind, expected in (
            ("厂外", "unknown", "VENDOR:ZIJIN"),
            ("仓库保管-48", "unknown", "OTHER"),
            ("A1-1", "storage", None),
            ("#1-850T", "machine", None),
        ):
            with self.subTest(location=location_code):
                row = mould(location_code=location_code)
                row["location"]["kind"] = kind
                row["location"]["parent_label"] = "句容紫金辰龙塑料电子有限公司"
                result = decorate_inventory_board(board(row))
                self.assertEqual(result["moulds"][0]["inventory"]["site"], expected)


class MouldVendorGroupingTests(unittest.TestCase):
    def test_requested_vendor_blocks_exist_with_zero_counts(self):
        result = decorate_inventory_board(board())
        metadata = groups(result)

        for site, name, category in (
            ("TIANLU", "天路", "external"),
            ("VENDOR:ZIJIN", "紫金", "external"),
            ("VENDOR:GUANGLI", "广立", "repair"),
            ("VENDOR:TAIZHIKE", "泰之科", "repair"),
        ):
            with self.subTest(site=site):
                self.assertEqual(metadata[site]["name"], name)
                self.assertEqual(metadata[site]["category"], category)
                self.assertEqual(metadata[site]["mould_count"], 0)
                self.assertEqual(metadata[site]["entry_count"], 0)
                self.assertEqual(metadata[site]["instance_ids"], [])
        self.assertEqual(metadata["SVC"]["category"], "svc")
        self.assertEqual(metadata["OTHER"]["category"], "other")
        self.assertEqual(metadata["UNCONFIRMED"]["category"], "unconfirmed")

    def test_group_counts_are_disjoint_and_repair_labels_do_not_rewrite_mes_summary(self):
        rows = [
            mould("1", location_code="丹阳广立模塑有限公司", repair_status="正常"),
            mould("2", location_code="丹阳广立模塑有限公司", repair_status="正常"),
            mould("3", location_code="苏州泰之科模具有限公司", repair_status="正常"),
            mould("4", location_code="句容紫金辰龙塑料电子有限公司"),
            mould("5", location_code="苏州索博特模具有限公司"),
            mould("6", CONFIRMED_ASSET, "仓库保管-16"),
            mould("7", location_code="仓库保管-48"),
            mould("8"),
            mould("9", location_code="A1-1"),
        ]
        rows[-1]["location"]["kind"] = "storage"
        payload = board(*rows)
        before = copy.deepcopy(payload)
        result = decorate_inventory_board(payload)
        metadata = groups(result)
        member_ids = [instance_id for group in metadata.values() for instance_id in group["instance_ids"]]

        self.assertEqual(len(member_ids), len(set(member_ids)))
        self.assertEqual(set(member_ids), {str(index) for index in range(1, 9)})
        self.assertEqual(sum(group["mould_count"] for group in metadata.values()), 8)
        self.assertEqual(sum(group["mould_count"] for group in metadata.values() if group["category"] == "repair"), 3)
        self.assertEqual(metadata["VENDOR:GUANGLI"]["mould_count"], 2)
        self.assertEqual(metadata["VENDOR:TAIZHIKE"]["mould_count"], 1)
        self.assertEqual(result["summary"], before["summary"])
        self.assertEqual(result["moulds"][0]["repair_status"], "正常")
        self.assertEqual(result["moulds"][0]["summary_category"], "offsite")
        self.assertEqual(payload, before)
        self.assertEqual(result, decorate_inventory_board(result))

    def test_svc_source_rows_and_unmatched_corrected_nt1_remain_separate_from_mes_population(self):
        result = decorate_inventory_board(board(mould("101", location_code="丹阳广立模塑有限公司")))
        inventory = result["storage_inventory"]
        nt1_entries = source_entries(result, CORRECTED_NT1_ASSET)

        self.assertEqual(len(inventory["entries"]), 35)
        self.assertEqual(inventory["source"]["mould_rows"], 35)
        self.assertEqual(groups(result)["SVC"]["entry_count"], 35)
        self.assertEqual(groups(result)["SVC"]["mould_count"], 0)
        self.assertEqual(len(nt1_entries), 1)
        self.assertIsNone(nt1_entries[0]["instance_id"])
        self.assertEqual(nt1_entries[0]["match_status"], "unmatched")
        self.assertEqual(len(result["moulds"]), 1)
        self.assertEqual(result["summary"]["total"], 1)


class MouldVendorMovementTests(unittest.TestCase):
    def test_latest_dated_vendor_move_refines_generic_outside_and_detail_matches_board(self):
        history = [
            movement("丹阳广立模塑有限公司", "2026-11-02T09:00:00+08:00", id="1"),
            movement("句容紫金辰龙塑料电子有限公司", "2026-11-01T09:00:00+08:00", id="999"),
        ]
        row = mould()
        detail = decorate_inventory_detail({"mould": row, "movement_history": history})
        result = decorate_inventory_board(board(with_history(row, history)))

        inventory = detail["mould"]["inventory"]
        self.assertEqual(inventory["site"], "VENDOR:GUANGLI")
        self.assertEqual(inventory["basis"], "last_movement")
        self.assertEqual(inventory["vendor"]["category"], "repair")
        self.assertEqual(inventory, result["moulds"][0]["inventory"])
        self.assertEqual(detail["mould"]["location"]["code"], "厂外")

    def test_later_wj_return_does_not_reuse_an_older_repair_vendor(self):
        history = [
            movement("苏州泰之科模具有限公司", "2026-11-01T09:00:00+08:00"),
            movement("南京万佳精密注塑有限公司", "2026-11-02T09:00:00+08:00"),
        ]
        result = decorate_inventory_detail({"mould": mould(), "movement_history": history})

        inventory = result["mould"]["inventory"]
        self.assertEqual(inventory["site"], "UNCONFIRMED")
        self.assertIsNone(inventory["vendor"])
        self.assertEqual(inventory["last_movement"]["to_location"], "南京万佳精密注塑有限公司")

    def test_tied_or_missing_actual_dates_never_infer_repair_vendor(self):
        for history in (
            [movement("丹阳广立模塑有限公司"), movement("句容紫金辰龙塑料电子有限公司")],
            [movement("丹阳广立模塑有限公司"), movement("万佳", at=None)],
            [movement("丹阳广立模塑有限公司", time_quality="created_at")],
        ):
            with self.subTest(history=history):
                result = decorate_inventory_detail({"mould": mould(), "movement_history": history})
                inventory = result["mould"]["inventory"]
                self.assertEqual(inventory["site"], "UNCONFIRMED")
                self.assertIsNone(inventory["vendor"])
                self.assertTrue(inventory["last_movement"]["ambiguous"])

    def test_confirmed_svc_and_explicit_current_positions_outrank_old_vendor_history(self):
        history = [movement("丹阳广立模塑有限公司", "2026-10-20T09:00:00+08:00")]
        for row, expected in (
            (mould(asset_code=CONFIRMED_ASSET), "SVC"),
            (mould(location_code="仓库保管-48"), "OTHER"),
            (mould(location_code="A1-1"), None),
            (mould(location_code="#1-850T"), None),
            (mould(location_code="句容紫金辰龙塑料电子有限公司"), "VENDOR:ZIJIN"),
        ):
            with self.subTest(location=row["location"]["code"], asset=row["asset_code"]):
                result = decorate_inventory_detail({"mould": row, "movement_history": history})
                inventory = result["mould"]["inventory"]
                self.assertEqual(inventory["site"], expected)
                if expected in {"SVC", "OTHER", None}:
                    self.assertIsNone(inventory["vendor"])


if __name__ == "__main__":
    unittest.main()


class MouldTeamLocationTests(unittest.TestCase):
    @patch("injection.mould_inventory._team_location_catalog")
    def test_team_location_matches_board_and_detail_until_mes_evidence_changes(self, catalog):
        instance_id = "101"
        evidence = ["TEST-ASSET", "TEST-DRAWING", "2026-11-12T09:00:00+08:00", None, None, None, None]
        entry = {
            "site": "TIANLU",
            "source_row": 2,
            "evidence_sha256": hashlib.sha256(json.dumps(evidence, separators=(",", ":")).encode()).hexdigest(),
        }
        catalog.return_value = {
            "source": {"reviewed_on": "2026-11-13"},
            "entries": {hashlib.sha256(instance_id.encode()).hexdigest(): entry},
        }
        row = mould(instance_id, evidence[0], drawing_no=evidence[1], status="使用中", record_updated_at=evidence[2])
        inventory = decorate_inventory_board(board(row))["moulds"][0]["inventory"]
        self.assertEqual(inventory["site"], entry["site"])
        self.assertEqual(inventory["basis"], "team_confirmation")
        self.assertEqual(inventory["source_ranges"], [f'G{entry["source_row"]}'])
        self.assertEqual(
            decorate_inventory_detail({"mould": row, "movement_history": []})["mould"]["inventory"],
            inventory,
        )
        self.assertEqual(row["location"]["code"], "厂外")

        for change, expected in (
            ({"record_updated_at": "2026-11-14T10:00:00+08:00"}, "UNCONFIRMED"),
            ({"drawing_no": "DIFFERENT-DRAWING"}, "UNCONFIRMED"),
            ({"status": "已报废"}, "UNCONFIRMED"),
            ({"location": {"code": "B4-7", "kind": "storage"}}, None),
            ({"last_movement": latest_movement([movement("苏州泰之科模具有限公司")])}, "VENDOR:TAIZHIKE"),
        ):
            with self.subTest(change=change):
                updated = decorate_inventory_board(board({**row, **change}))
                self.assertEqual(updated["moulds"][0]["inventory"]["site"], expected)
