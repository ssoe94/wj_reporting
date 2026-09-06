from copy import deepcopy
from datetime import date

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.urls import path
from rest_framework.test import APIClient

from injection.models import MouldDataSnapshot

from .field_operations import build_field_operations
from .field_operations_views import AnalyticsFieldOperationsView


# This small URL configuration also permits tests with isolated SQLite settings,
# without importing production settings or its external-source integrations.
urlpatterns = [path("api/analytics/field-operations/", AnalyticsFieldOperationsView.as_view())]


@override_settings(ROOT_URLCONF=__name__)
class FieldOperationsTests(TestCase):
    target_date = date(2026, 9, 4)

    def checkpoint(self, *, machine=1, suffix=1, defects=2, **changes):
        row = {
            "event_key": f"manual:{self.target_date}:{machine}:{suffix}",
            "trigger": "manual",
            "business_date": self.target_date.isoformat(),
            "machine_number": machine,
            "part_no": "TEST-PART",
            "model_name": "TEST-MODEL",
            "plan_id": 100,
            "sequence": 1,
            "ending_business_day_shots": 10,
            "segment_shots": 10,
            "cavity": 2,
            "gross_piece_qty": 20,
            "defect_piece_qty": defects,
            "good_piece_qty": 20 - defects,
            "items": [{"code": "scratch", "quantity": defects}] if defects else [],
            "completed_at": "2026-09-04T20:00:00+08:00",
            "completed_by": "private-operator",
        }
        return {**row, **changes}

    def save_document(self, rows, *, machine=1, day=None, **payload_changes):
        day = day or self.target_date
        return MouldDataSnapshot.objects.create(
            snapshot_key=f"field-defects-v1-{day:%Y%m%d}-{machine:02d}",
            kind="board",
            payload={
                "schema_version": "field-defects.v1",
                "business_date": day.isoformat(),
                "machine_number": machine,
                "checkpoints": rows,
                **payload_changes,
            },
        )

    def test_unrecorded_day_has_null_quantities_not_zero_defects(self):
        result = build_field_operations(self.target_date)
        self.assertEqual(result["status"], "no_records")
        self.assertEqual(result["summary"]["checkpoint_count"], 0)
        self.assertIsNone(result["summary"]["reported_defect_qty"])
        self.assertIsNone(result["summary"]["estimated_gross_qty"])
        self.assertIsNone(result["summary"]["latest_reported_at"])
        self.assertEqual(len(result["machines"]), 17)
        self.assertTrue(all(row["status"] == "no_records" for row in result["machines"]))

    def test_zero_defect_report_is_distinct_from_an_unrecorded_machine(self):
        self.save_document([self.checkpoint(defects=0)])
        result = build_field_operations(self.target_date)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["summary"]["reported_defect_qty"], 0)
        self.assertEqual(result["summary"]["zero_defect_checkpoint_count"], 1)
        self.assertEqual(result["machines"][0]["status"], "reported")
        self.assertEqual(result["machines"][1]["status"], "no_records")
        self.assertIsNone(result["machines"][1]["reported_defect_qty"])
        self.assertEqual(result["defects"], [])

    def test_existing_segments_aggregate_by_machine_and_cause_without_private_fields(self):
        self.save_document([self.checkpoint(), self.checkpoint(suffix=2, defects=0, ending_business_day_shots=20)])
        self.save_document([self.checkpoint(machine=2, defects=3)], machine=2)
        with self.assertNumQueries(1):
            result = build_field_operations(self.target_date)
        self.assertEqual(result["summary"]["checkpoint_count"], 3)
        self.assertEqual(result["summary"]["reported_defect_qty"], 5)
        self.assertEqual(result["summary"]["estimated_gross_qty"], 60)
        self.assertEqual(result["summary"]["derived_good_qty"], 55)
        self.assertEqual(result["coverage"]["recorded_machine_count"], 2)
        self.assertEqual(result["coverage"]["unrecorded_machine_count"], 15)
        self.assertEqual(result["defects"], [{"code": "scratch", "reported_defect_qty": 5, "checkpoint_count": 2}])
        self.assertNotIn("private-operator", str(result))
        self.assertNotIn("TEST-PART", str(result))
        self.assertNotIn("defect_rate", str(result))

    def test_exact_duplicate_event_counts_once_and_warns(self):
        row = self.checkpoint()
        self.save_document([row, deepcopy(row)])
        result = build_field_operations(self.target_date)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["summary"]["reported_defect_qty"], 2)
        self.assertEqual(result["coverage"]["duplicate_checkpoint_count"], 1)

    def test_conflicting_duplicate_event_is_excluded_instead_of_chosen_arbitrarily(self):
        self.save_document([self.checkpoint(), self.checkpoint(defects=3)])
        result = build_field_operations(self.target_date)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["summary"]["checkpoint_count"], 0)
        self.assertIsNone(result["summary"]["reported_defect_qty"])
        self.assertEqual(result["coverage"]["excluded_by_reason"], {"conflicting_checkpoint_event": 1})

    def test_distinct_events_with_overlapping_shot_ranges_are_all_excluded(self):
        self.save_document([
            self.checkpoint(),  # shots (0, 10]
            self.checkpoint(suffix=2, ending_business_day_shots=15),  # (5, 15]
            self.checkpoint(suffix=3, ending_business_day_shots=25),  # (15, 25], valid
        ])
        result = build_field_operations(self.target_date)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["summary"]["checkpoint_count"], 1)
        self.assertEqual(result["summary"]["estimated_gross_qty"], 20)
        self.assertEqual(result["coverage"]["invalid_checkpoint_count"], 2)
        self.assertEqual(result["coverage"]["excluded_by_reason"], {"overlapping_checkpoint_segments": 2})

    def test_zero_shot_report_does_not_overlap_an_existing_positive_segment(self):
        self.save_document([
            self.checkpoint(),
            self.checkpoint(suffix=2, defects=0, segment_shots=0, gross_piece_qty=0, good_piece_qty=0),
        ])
        result = build_field_operations(self.target_date)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["summary"]["checkpoint_count"], 2)
        self.assertEqual(result["summary"]["zero_defect_checkpoint_count"], 1)
        self.assertEqual(result["summary"]["estimated_gross_qty"], 20)

    def test_invalid_values_and_scope_do_not_become_valid_zeroes(self):
        rows = [
            self.checkpoint(suffix=1, defect_piece_qty=-1),
            self.checkpoint(suffix=2, gross_piece_qty=21),
            self.checkpoint(suffix=3, cavity=True),
            self.checkpoint(suffix=4, items=[{"code": "scratch", "quantity": 1}]),
            self.checkpoint(suffix=5, machine_number=2),
            self.checkpoint(suffix=6, completed_at="invalid"),
            self.checkpoint(suffix=7, trigger=[]),
            self.checkpoint(suffix=8, items=[{"code": [], "quantity": 2}]),
            self.checkpoint(suffix=9, defect_piece_qty=1.2),
            self.checkpoint(suffix=10),
        ]
        self.save_document(rows)
        result = build_field_operations(self.target_date)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["summary"]["checkpoint_count"], 1)
        self.assertEqual(result["summary"]["reported_defect_qty"], 2)
        self.assertEqual(result["coverage"]["invalid_checkpoint_count"], 9)

    def test_other_snapshot_families_and_other_days_do_not_leak_into_totals(self):
        self.save_document([self.checkpoint()], day=date(2026, 9, 3))
        MouldDataSnapshot.objects.create(snapshot_key="field-materials-v1", payload={"checkpoints": [self.checkpoint()]})
        MouldDataSnapshot.objects.create(snapshot_key="board", payload={"checkpoints": [self.checkpoint()]})
        result = build_field_operations(self.target_date)
        self.assertEqual(result["status"], "no_records")
        self.assertEqual(result["used_data"][0]["document_count"], 0)

    def test_corrupt_document_is_partial_and_machine_is_invalid(self):
        self.save_document([], schema_version="unknown")
        result = build_field_operations(self.target_date)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["coverage"]["invalid_document_count"], 1)
        self.assertEqual(result["machines"][0]["status"], "invalid")
        self.assertIsNone(result["summary"]["reported_defect_qty"])

    def test_checkpoint_completion_can_follow_its_business_day(self):
        self.save_document([self.checkpoint(
            trigger="shift_0800", event_key="defect:shift:2026-09-04:1:0800",
            completed_at="2026-09-05T08:05:00+08:00",
        )])
        result = build_field_operations(self.target_date)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["summary"]["latest_reported_at"], "2026-09-05T08:05:00+08:00")
        self.assertEqual(result["business_window"]["start"], "2026-09-04T08:00:00+08:00")

    def test_endpoint_requires_authentication(self):
        response = APIClient().get("/api/analytics/field-operations/", {"date": "2026-09-04"})
        self.assertIn(response.status_code, [401, 403])

    def test_endpoint_validates_date_and_returns_no_store_without_mutating(self):
        user = get_user_model().objects.create_user(username="field-analytics-test")
        client = APIClient()
        client.force_authenticate(user=user)
        for value in [None, "2026-9-4", "2026-02-30", "n/a", "9999-12-31"]:
            response = client.get("/api/analytics/field-operations/", {} if value is None else {"date": value})
            self.assertEqual(response.status_code, 400)
        response = client.get("/api/analytics/field-operations/", {"date": "2026-09-04"})
        self.assertEqual(response.status_code, 200)
        cache_directives = {directive.strip().lower() for directive in response["Cache-Control"].split(",")}
        self.assertIn("no-store", cache_directives)
        self.assertEqual(response.data["status"], "no_records")
        self.assertEqual(MouldDataSnapshot.objects.count(), 0)
