"""Confirmed inventory is an observation alongside, not a rewrite of, MES."""

import copy
import unittest

from injection.mould_inventory import (
    decorate_inventory_board,
    decorate_inventory_detail,
    latest_movement,
)


CONFIRMED_ASSET = "NDIF02754750"
DUPLICATE_SOURCE_ASSET = "NDIF02767282"


def mould(instance_id="101", asset_code="UNLISTED", location_code="厂外", **fields):
    return {
        "instance_id": instance_id,
        "mould_code": f"MOLD-{instance_id}",
        "asset_code": asset_code,
        "name": "Example mould",
        "summary_category": "offsite",
        "location": {
            "code": location_code,
            "label": location_code,
            "kind": "unknown",
            "parent_code": None,
            "parent_label": None,
            "zone_code": None,
            "zone_label": None,
        },
        **fields,
    }


def board(*moulds):
    return {
        "moulds": list(moulds),
        "summary": {"total": len(moulds), "offsite": len(moulds)},
        "locations": [],
        "machines": [],
        "data_freshness": {"snapshot_at": "2026-11-09T10:00:00+08:00"},
    }


def groups(result):
    return {
        group["site"]: group
        for group in result["storage_inventory"]["groups"]
    }


def source_entries(result, asset_code):
    return [
        entry for entry in result["storage_inventory"]["entries"]
        if entry["asset_code"] == asset_code
    ]


def movement(destination, at="2026-11-01T09:00:00+08:00", **fields):
    return {
        "occurred_at": at,
        "from_location": "万佳",
        "to_location": destination,
        "reason": "mould storage transfer",
        "time_quality": "child_field",
        **fields,
    }


class MouldInventorySourceTests(unittest.TestCase):
    def test_source_rows_are_preserved_without_fabricating_mes_moulds(self):
        result = decorate_inventory_board(board())
        inventory = result["storage_inventory"]

        self.assertEqual(result["moulds"], [])
        self.assertEqual(result["summary"]["total"], 0)
        self.assertEqual(inventory["source"]["mould_rows"], 35)
        self.assertEqual(inventory["source"]["unique_assets"], 34)
        self.assertEqual(inventory["source"]["duplicate_assets"], [DUPLICATE_SOURCE_ASSET])
        self.assertEqual(len(inventory["entries"]), 35)
        self.assertEqual(len({entry["entry_id"] for entry in inventory["entries"]}), 35)
        self.assertTrue(all(entry["instance_id"] is None for entry in inventory["entries"]))
        self.assertEqual(sum(entry["match_status"] == "unmatched" for entry in inventory["entries"]), 33)
        self.assertEqual(inventory["reconciliation"], {
            "physical_mould_count": 35, "individually_linked_mould_count": 0,
            "identity_pending_mould_count": 2, "unmatched_mould_count": 33,
        })
        self.assertEqual(groups(result)["SVC"]["entry_count"], 35)
        self.assertEqual(groups(result)["SVC"]["mould_count"], 0)

    def test_confirmed_distinct_moulds_do_not_share_an_individual_mes_identity(self):
        result = decorate_inventory_board(board(
            mould(asset_code=DUPLICATE_SOURCE_ASSET),
        ))
        entries = source_entries(result, DUPLICATE_SOURCE_ASSET)

        self.assertEqual(len(entries), 2)
        self.assertEqual({entry["instance_id"] for entry in entries}, {None})
        self.assertEqual({entry["match_status"] for entry in entries}, {"shared_asset_identity_pending"})
        for entry in entries:
            self.assertEqual(entry["candidate_instance_ids"], ["101"])
            self.assertEqual(entry["candidate_mould_codes"], ["MOLD-101"])
            self.assertEqual(entry["confirmed_mould_nos"], ["NT1", "NT2"])
            self.assertEqual(entry["record_location"], "")
        self.assertEqual(
            {(entry["rack"], entry["mould_no"], entry["confirmed_mould_no"]) for entry in entries},
            {("第4排 下层", "NT2", "NT2"), ("第5排 下层", "NT4", "NT1")},
        )
        self.assertEqual({entry["mould_no"] for entry in entries}, {"NT2", "NT4"})
        self.assertEqual(len({entry["source_range"] for entry in entries}), 2)
        self.assertEqual(len({entry["rack"] for entry in entries}), 2)
        self.assertEqual(groups(result)["SVC"]["mould_count"], 1)
        self.assertEqual(groups(result)["SVC"]["instance_ids"], ["101"])
        self.assertEqual(len(result["moulds"][0]["inventory"]["source_ranges"]), 2)
        self.assertTrue(result["moulds"][0]["inventory"]["identity_pending"])
        self.assertEqual(result["moulds"][0]["inventory"]["confirmed_mould_nos"], ["NT1", "NT2"])
        self.assertEqual(result["storage_inventory"]["reconciliation"]["physical_mould_count"], 35)

    def test_all_source_assets_reconcile_physical_and_mes_identity_counts_separately(self):
        source = decorate_inventory_board(board())["storage_inventory"]["entries"]
        records = [mould(str(index), asset_code=asset) for index, asset in enumerate(sorted({row["asset_code"] for row in source}))]
        result = decorate_inventory_board(board(*records))
        self.assertEqual(result["storage_inventory"]["reconciliation"], {
            "physical_mould_count": 35, "individually_linked_mould_count": 33,
            "identity_pending_mould_count": 2, "unmatched_mould_count": 0,
        })
        self.assertEqual(groups(result)["SVC"]["mould_count"], 34)
        self.assertEqual(len(result["moulds"]), 34)

    def test_multiple_same_asset_mes_candidates_cannot_resolve_physical_variants(self):
        result = decorate_inventory_board(board(
            mould("101", DUPLICATE_SOURCE_ASSET), mould("102", DUPLICATE_SOURCE_ASSET),
        ))
        for entry in source_entries(result, DUPLICATE_SOURCE_ASSET):
            self.assertIsNone(entry["instance_id"])
            self.assertEqual(entry["candidate_instance_ids"], ["101", "102"])
            self.assertEqual(entry["match_status"], "shared_asset_identity_pending")
        self.assertEqual(result["storage_inventory"]["reconciliation"]["individually_linked_mould_count"], 0)
        self.assertEqual(result["storage_inventory"]["reconciliation"]["identity_pending_mould_count"], 2)

    def test_asset_match_does_not_assign_same_part_to_another_mould(self):
        result = decorate_inventory_board(board(
            mould("101", CONFIRMED_ASSET, drawing_no="MCK70204301"),
            mould("102", "ANOTHER-ASSET", drawing_no="MCK70204301"),
        ))

        self.assertEqual(result["moulds"][0]["inventory"]["site"], "SVC")
        self.assertEqual(result["moulds"][1]["inventory"]["site"], "UNCONFIRMED")
        self.assertEqual(source_entries(result, CONFIRMED_ASSET)[0]["instance_id"], "101")

    def test_duplicate_mes_asset_is_ambiguous_instead_of_first_match_wins(self):
        result = decorate_inventory_board(board(
            mould("101", CONFIRMED_ASSET),
            mould("102", CONFIRMED_ASSET),
        ))
        entry = source_entries(result, CONFIRMED_ASSET)[0]

        self.assertIsNone(entry["instance_id"])
        self.assertEqual(entry["match_status"], "ambiguous")
        self.assertEqual(groups(result)["SVC"]["mould_count"], 0)
        self.assertTrue(all(row["inventory"]["site"] != "SVC" for row in result["moulds"]))

    def test_missing_asset_cannot_match_source_by_model_or_name(self):
        result = decorate_inventory_board(board(mould(
            asset_code=None, model="34WK95C", name="Back cover", drawing_no="MCK70204301",
        )))

        self.assertEqual(result["moulds"][0]["inventory"]["site"], "UNCONFIRMED")
        self.assertIsNone(source_entries(result, CONFIRMED_ASSET)[0]["instance_id"])

    def test_confirmation_is_additive_and_decorating_twice_is_stable(self):
        original = board(mould(asset_code=CONFIRMED_ASSET, location_code="仓库保管-16"))
        before = copy.deepcopy(original)

        result = decorate_inventory_board(original)

        self.assertEqual(original, before)
        self.assertEqual(result["summary"], before["summary"])
        self.assertEqual(result["moulds"][0]["location"], before["moulds"][0]["location"])
        self.assertEqual(result["moulds"][0]["summary_category"], "offsite")
        self.assertEqual(result, decorate_inventory_board(result))
        result["moulds"][0]["location"]["code"] = "changed in returned value"
        self.assertEqual(original, before)


class MouldInventoryLocationTests(unittest.TestCase):
    def test_current_location_aliases_identify_sites(self):
        for code, expected in (
            ("天路", "TIANLU"),
            ("天路仓库", "TIANLU"),
            ("TIANLU", "TIANLU"),
            ("tianlu", "TIANLU"),
            ("SVC", "SVC"),
            ("svc-warehouse", "SVC"),
            ("SVC仓库", "SVC"),
            ("仓库保管-45", "OTHER"),
            ("修理区-3", "OTHER"),
            ("厂外", "UNCONFIRMED"),
            ("offsite", "UNCONFIRMED"),
            ("", "UNCONFIRMED"),
        ):
            with self.subTest(location=code):
                result = decorate_inventory_board(board(mould(location_code=code)))
                self.assertEqual(result["moulds"][0]["inventory"]["site"], expected)

    def test_parent_location_can_name_site_without_overwriting_source_location(self):
        row = mould()
        row["location"]["parent_label"] = "天路"
        result = decorate_inventory_board(board(row))

        self.assertEqual(result["moulds"][0]["inventory"]["site"], "TIANLU")
        self.assertEqual(result["moulds"][0]["location"]["code"], "厂外")

    def test_manufacturer_classification_and_word_fragments_do_not_prove_site(self):
        for code in ("厂外", "TIANLUX", "XSVCX"):
            with self.subTest(location=code):
                result = decorate_inventory_board(board(mould(
                    location_code=code,
                    manufacturer="天路模具有限公司",
                    classification="SVC",
                    name="SVC customer part",
                )))
                self.assertNotIn(result["moulds"][0]["inventory"]["site"], {"SVC", "TIANLU"})

    def test_abcs_and_machine_locations_are_not_counted_in_external_inventory(self):
        records = []
        for index, (code, kind) in enumerate((
            ("A1-1", "storage"), ("B2-3", "storage"),
            ("C9-18", "storage"), ("S3-7", "storage"),
            ("S-2", "storage"), ("#1-850T", "machine"),
        )):
            row = mould(str(index), location_code=code, classification="SVC")
            row["location"]["kind"] = kind
            records.append(row)

        result = decorate_inventory_board(board(*records))

        self.assertEqual(sum(group["mould_count"] for group in groups(result).values()), 0)
        self.assertTrue(all(not group["instance_ids"] for group in groups(result).values()))

    def test_physical_grouping_is_independent_of_repair_summary_status(self):
        result = decorate_inventory_board(board(mould(
            location_code="天路", summary_category="repair", repair_status="维修中",
        )))

        self.assertEqual(result["moulds"][0]["inventory"]["site"], "TIANLU")
        self.assertEqual(result["moulds"][0]["summary_category"], "repair")
        self.assertEqual(groups(result)["TIANLU"]["mould_count"], 1)

    def test_conflicting_current_rack_is_visible_without_rewriting_mes(self):
        row = mould(asset_code=CONFIRMED_ASSET, location_code="A1-1")
        row["location"]["kind"] = "storage"
        result = decorate_inventory_board(board(row))

        self.assertTrue(result["moulds"][0]["inventory"]["location_conflict"])
        self.assertTrue(source_entries(result, CONFIRMED_ASSET)[0]["location_conflict"])
        self.assertEqual(result["moulds"][0]["location"]["code"], "A1-1")

    def test_newer_verified_movement_takes_precedence_over_confirmed_inventory(self):
        result = decorate_inventory_board(board(mould(
            asset_code=CONFIRMED_ASSET,
            location_code="天路",
            position_changed_at="2026-11-10T00:00:01+08:00",
            time_quality="verified",
        )))

        self.assertEqual(result["moulds"][0]["inventory"]["site"], "TIANLU")
        self.assertTrue(source_entries(result, CONFIRMED_ASSET)[0]["location_conflict"])
        self.assertEqual(groups(result)["TIANLU"]["mould_count"], 1)
        self.assertEqual(groups(result)["SVC"]["mould_count"], 0)

    def test_record_update_and_same_day_move_do_not_invalidate_day_level_confirmation(self):
        for fields in (
            {"record_updated_at": "2026-11-20T15:00:00+08:00"},
            {"position_changed_at": "2026-11-09T23:59:59+08:00", "time_quality": "verified"},
            {"position_changed_at": "invalid timestamp"},
        ):
            with self.subTest(fields=fields):
                result = decorate_inventory_board(board(mould(
                    asset_code=CONFIRMED_ASSET, **fields,
                )))
                self.assertEqual(result["moulds"][0]["inventory"]["site"], "SVC")
                self.assertEqual(result["moulds"][0]["inventory"]["basis"], "confirmed_list")


class MouldInventoryDetailTests(unittest.TestCase):
    def test_board_pool_must_identify_the_same_unique_mes_instance(self):
        row = mould("101", CONFIRMED_ASSET)
        for pool, expected in (
            ([mould("101", CONFIRMED_ASSET)], "SVC"),
            ([mould("101", CONFIRMED_ASSET), mould("102", CONFIRMED_ASSET)], "UNCONFIRMED"),
            ([mould("102", CONFIRMED_ASSET)], "UNCONFIRMED"),
        ):
            with self.subTest(instance_ids=[item["instance_id"] for item in pool]):
                before = copy.deepcopy(pool)
                result = decorate_inventory_detail({"mould": row}, moulds=pool)
                self.assertEqual(result["mould"]["inventory"]["site"], expected)
                self.assertEqual(bool(result["mould"]["inventory"]["source_ranges"]), expected == "SVC")
                self.assertEqual(pool, before)

    def test_detail_and_board_share_confirmation_and_retain_original_detail(self):
        row = mould(asset_code=DUPLICATE_SOURCE_ASSET)
        history = [movement("厂外")]
        row["last_movement"] = latest_movement(history)
        payload = {
            "mould": row,
            "movement_history": history,
            "production_history": [{"year": 2026, "month": 10, "quantity": 321}],
        }
        before = copy.deepcopy(payload)
        result = decorate_inventory_detail(payload)
        board_result = decorate_inventory_board(board(row))

        self.assertEqual(result["mould"]["inventory"], board_result["moulds"][0]["inventory"])
        self.assertTrue(result["mould"]["inventory"]["identity_pending"])
        self.assertEqual(result["mould"]["inventory"]["confirmed_mould_nos"], ["NT1", "NT2"])
        self.assertEqual(result["movement_history"], payload["movement_history"])
        self.assertEqual(result["production_history"], payload["production_history"])
        self.assertEqual(payload, before)
        self.assertEqual(result, decorate_inventory_detail(result))

    def test_unlisted_detail_uses_current_location_without_source_confirmation(self):
        result = decorate_inventory_detail({"mould": mould(location_code="天路")})

        self.assertEqual(result["mould"]["inventory"]["site"], "TIANLU")
        self.assertEqual(result["mould"]["inventory"]["basis"], "mes_location")
        self.assertEqual(result["mould"]["inventory"]["source_ranges"], [])


class MouldInventoryMovementTests(unittest.TestCase):
    def test_latest_actual_destination_refines_only_generic_outside_location(self):
        history = [
            movement("天路", "2026-11-02T08:00:00+08:00", id="1"),
            movement("万佳", "2026-11-01T08:00:00+08:00", id="999"),
        ]
        before = copy.deepcopy(history)
        result = decorate_inventory_detail({"mould": mould(), "movement_history": history})

        inventory = result["mould"]["inventory"]
        self.assertEqual(inventory["site"], "TIANLU")
        self.assertEqual(inventory["basis"], "last_movement")
        self.assertEqual(inventory["last_movement"]["to_location"], "天路")
        self.assertFalse(inventory["last_movement"]["ambiguous"])
        self.assertEqual(result["mould"]["location"]["code"], "厂外")
        self.assertEqual(history, before)

    def test_later_return_to_wj_prevents_earlier_tianlu_from_classifying_current_outside(self):
        for returned_to in ("万佳", "WJ", "萬佳仓库"):
            with self.subTest(destination=returned_to):
                history = [
                    movement("天路", "2026-11-01T08:00:00+08:00"),
                    movement(returned_to, "2026-11-02T08:00:00+08:00"),
                ]
                result = decorate_inventory_detail({"mould": mould(), "movement_history": history})
                inventory = result["mould"]["inventory"]
                self.assertEqual(inventory["site"], "UNCONFIRMED")
                self.assertEqual(inventory["basis"], "unconfirmed")
                self.assertEqual(inventory["last_movement"]["to_location"], returned_to)

    def test_conflicting_same_time_destinations_are_ambiguous_in_either_order(self):
        history = [movement("天路", id="999"), movement("万佳", id="1")]
        for ordered in (history, list(reversed(history))):
            with self.subTest(ids=[row["id"] for row in ordered]):
                result = decorate_inventory_detail({"mould": mould(), "movement_history": ordered})
                inventory = result["mould"]["inventory"]
                self.assertEqual(inventory["site"], "UNCONFIRMED")
                self.assertTrue(inventory["last_movement"]["ambiguous"])
                self.assertIsNone(inventory["last_movement"]["to_location"])

    def test_undated_or_creation_date_rows_cannot_establish_the_latest_physical_move(self):
        for uncertain in (
            movement("万佳", at=None),
            movement("万佳", at="invalid"),
            movement("万佳", at="2026-11-02T08:00:00", time_quality="child_field"),
            movement("万佳", at="2026-11-02T08:00:00+08:00", time_quality="created_at"),
        ):
            with self.subTest(row=uncertain):
                history = [movement("天路"), uncertain]
                result = decorate_inventory_detail({"mould": mould(), "movement_history": history})
                inventory = result["mould"]["inventory"]
                self.assertEqual(inventory["site"], "UNCONFIRMED")
                self.assertTrue(inventory["last_movement"]["ambiguous"])
                self.assertIsNone(inventory["last_movement"]["to_location"])

    def test_explicit_current_position_outranks_earlier_tianlu_history(self):
        for code, kind, site in (
            ("A1-1", "storage", None),
            ("#1-850T", "machine", None),
            ("仓库保管-45", "unknown", "OTHER"),
            ("SVC", "unknown", "SVC"),
        ):
            with self.subTest(location=code):
                row = mould(location_code=code)
                row["location"]["kind"] = kind
                result = decorate_inventory_detail({"mould": row, "movement_history": [movement("天路")]})
                self.assertEqual(result["mould"]["inventory"]["site"], site)
                self.assertEqual(result["mould"]["location"]["code"], code)

    def test_confirmed_source_survives_older_history_but_yields_to_later_actual_movement(self):
        for at, expected in (
            ("2026-11-08T08:00:00+08:00", "SVC"),
            ("2026-11-09T23:59:59+08:00", "SVC"),
            ("2026-11-10T00:00:01+08:00", "TIANLU"),
        ):
            with self.subTest(moved_at=at):
                row = mould(asset_code=CONFIRMED_ASSET)
                result = decorate_inventory_detail({"mould": row, "movement_history": [movement("天路", at)]})
                inventory = result["mould"]["inventory"]
                self.assertEqual(inventory["site"], expected)
                self.assertEqual(inventory["confirmed_on"], "2026-11-09")
                self.assertTrue(inventory["source_ranges"])


if __name__ == "__main__":
    unittest.main()
