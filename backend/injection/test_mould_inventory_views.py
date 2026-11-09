"""Public snapshot, cache and live-build reads share inventory observations."""

from unittest.mock import patch

from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient

from injection.models import MouldDataSnapshot
from injection.mould_snapshots import BOARD_SNAPSHOT_KEY, detail_snapshot_key
from injection.mould_views import _project_detail_payload
from injection.test_mould_inventory import CONFIRMED_ASSET, board, mould, movement


class MouldInventoryViewTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()

    def tearDown(self):
        cache.clear()

    def store_board(self, *rows):
        return MouldDataSnapshot.objects.create(
            snapshot_key=BOARD_SNAPSHOT_KEY,
            kind=MouldDataSnapshot.KIND_BOARD,
            payload=board(*rows),
        )

    def assert_confirmed(self, payload):
        self.assertEqual(payload["inventory"]["site"], "SVC")
        self.assertEqual(payload["inventory"]["basis"], "confirmed_list")
        self.assertEqual(payload["inventory"]["confirmed_on"], "2026-11-09")
        self.assertEqual(payload["location"]["code"], "仓库保管-16")
        self.assertNotIn("source_fields", payload)
        self.assertNotIn("resource_provenance", payload)
        self.assertNotIn("raw_secret", payload)

    @patch("injection.mould_views.build_mould_board")
    def test_existing_board_snapshot_gets_inventory_without_rewriting_saved_mes(self, build_board):
        row = mould(asset_code=CONFIRMED_ASSET, location_code="仓库保管-16")
        row["source_fields"] = {"operator": "synthetic-private-source"}
        snapshot = self.store_board(row)

        response = self.client.get("/api/injection/moulds/board/")

        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"].split(", "))
        payload = response.json()
        self.assert_confirmed(payload["moulds"][0])
        self.assertEqual(payload["storage_inventory"]["source"]["mould_rows"], 35)
        self.assertEqual(len(payload["storage_inventory"]["entries"]), 35)
        self.assertEqual(payload["summary"]["total"], 1)
        build_board.assert_not_called()
        snapshot.refresh_from_db()
        self.assertNotIn("inventory", snapshot.payload["moulds"][0])
        self.assertNotIn("storage_inventory", snapshot.payload)
        self.assertEqual(snapshot.payload["moulds"][0]["location"]["code"], "仓库保管-16")

    @patch("injection.mould_views.build_mould_board")
    def test_query_build_and_cache_hit_receive_same_public_inventory(self, build_board):
        row = mould(asset_code=CONFIRMED_ASSET, location_code="仓库保管-16")
        row["resource_provenance"] = {"raw_secret": "synthetic-private-resource"}
        row["raw_secret"] = "synthetic-private-record"
        build_board.return_value = board(row)

        first = self.client.get("/api/injection/moulds/board/", {"q": "MCK70204301"})
        second = self.client.get("/api/injection/moulds/board/", {"q": "MCK70204301"})

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        for response in (first, second):
            self.assert_confirmed(response.json()["moulds"][0])
            self.assertEqual(response.json()["storage_inventory"]["source"]["mould_rows"], 35)
            self.assertNotIn("synthetic-private", response.content.decode())
        self.assertEqual(first.json()["storage_inventory"], second.json()["storage_inventory"])
        build_board.assert_called_once_with(quick_search="MCK70204301")

    @patch("injection.mould_views.build_mould_detail")
    def test_detail_fresh_snapshot_and_cache_paths_keep_confirmation_and_projection(self, build_detail):
        row = mould(asset_code=CONFIRMED_ASSET, location_code="仓库保管-16")
        self.store_board(row)
        private_row = {**row, "raw_secret": "synthetic-private-record"}
        build_detail.return_value = {
            "mould": private_row,
            "movement_history": [{
                "id": "movement-1", "from_location": "厂外", "to_location": "仓库保管-16",
                "reason": "confirmed movement", "operator_name": "synthetic-private-operator",
            }],
            "production_history": [],
            "repair_history": [],
            "data_freshness": {"status": "live"},
            "raw_payload": {"raw_secret": "synthetic-private-detail"},
        }

        fresh = self.client.get("/api/injection/moulds/101/")
        snapshot = self.client.get("/api/injection/moulds/101/")
        # Delete only the disposable fixture to exercise the already populated
        # public detail cache rather than the database snapshot path again.
        MouldDataSnapshot.objects.filter(snapshot_key=detail_snapshot_key("101")).delete()
        cached = self.client.get("/api/injection/moulds/101/")

        for response in (fresh, snapshot, cached):
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assert_confirmed(payload["mould"])
            self.assertEqual(payload["movement_history"][0]["reason"], "confirmed movement")
            self.assertNotIn("operator_name", payload["movement_history"][0])
            self.assertNotIn("raw_payload", payload)
            self.assertNotIn("synthetic-private", response.content.decode())
        self.assertEqual(fresh.json()["mould"]["inventory"], cached.json()["mould"]["inventory"])
        build_detail.assert_called_once_with("101")

    @patch("injection.mould_views.build_mould_detail")
    def test_detail_snapshot_uses_board_pool_to_reject_ambiguous_asset_link(self, build_detail):
        first = mould("101", CONFIRMED_ASSET)
        second = mould("102", CONFIRMED_ASSET)
        self.store_board(first, second)
        MouldDataSnapshot.objects.create(
            snapshot_key=detail_snapshot_key("101"),
            kind=MouldDataSnapshot.KIND_DETAIL,
            instance_id="101",
            payload=_project_detail_payload({"mould": first}),
        )

        response = self.client.get("/api/injection/moulds/101/")

        self.assertEqual(response.status_code, 200)
        inventory = response.json()["mould"]["inventory"]
        self.assertEqual(inventory["site"], "UNCONFIRMED")
        self.assertEqual(inventory["source_ranges"], [])
        self.assertIsNone(inventory["confirmed_on"])
        build_detail.assert_not_called()

    @patch("injection.mould_views.build_mould_board")
    def test_board_reads_latest_movement_from_existing_detail_snapshot_without_new_mes_fetch(self, build_board):
        row = mould()
        stored_board = self.store_board(row)
        history = [movement("天路")]
        detail = MouldDataSnapshot.objects.create(
            snapshot_key=detail_snapshot_key("101"),
            kind=MouldDataSnapshot.KIND_DETAIL,
            instance_id="101",
            payload=_project_detail_payload({"mould": row, "movement_history": history}),
        )

        first = self.client.get("/api/injection/moulds/board/")

        self.assertEqual(first.status_code, 200)
        first_inventory = first.json()["moulds"][0]["inventory"]
        self.assertEqual(first_inventory["site"], "TIANLU")
        self.assertEqual(first_inventory["basis"], "last_movement")
        self.assertEqual(first_inventory["last_movement"]["to_location"], "天路")
        history.append(movement("万佳", "2026-11-02T09:00:00+08:00"))
        detail.payload = _project_detail_payload({"mould": row, "movement_history": history})
        detail.save(update_fields=["payload"])

        second = self.client.get("/api/injection/moulds/board/")
        detail_response = self.client.get("/api/injection/moulds/101/")

        self.assertEqual(second.status_code, 200)
        self.assertEqual(detail_response.status_code, 200)
        second_inventory = second.json()["moulds"][0]["inventory"]
        self.assertEqual(second_inventory["site"], "UNCONFIRMED")
        self.assertEqual(second_inventory["last_movement"]["to_location"], "万佳")
        self.assertEqual(second_inventory, detail_response.json()["mould"]["inventory"])
        stored_board.refresh_from_db()
        self.assertNotIn("last_movement", stored_board.payload["moulds"][0])
        self.assertEqual(stored_board.payload["moulds"][0]["location"]["code"], "厂外")
        build_board.assert_not_called()
