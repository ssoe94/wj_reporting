from __future__ import annotations

from datetime import date, datetime, timedelta
from io import BytesIO
from unittest.mock import patch
import zipfile

import pytz
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from injection.models import InjectionMonitoringRecord, MouldDataSnapshot

from .field_kanban import (
    FIELD_DEFECTS_SCHEMA,
    FIELD_MATERIALS_SCHEMA,
    FIELD_MATERIALS_SNAPSHOT_KEY,
    FieldKanbanError,
    _defect_checkpoint_context,
    _defect_snapshot_key,
    _machine_shot_payload,
    _pending_shift_prompt,
    _quality_summary,
    apply_field_material_conversion_notification,
    build_field_kanban_snapshot,
    build_field_material_readiness,
    resolve_material_documents,
    save_defect_checkpoint,
    save_field_material,
)
from .models import (
    InjectionDowntimeConfirmation,
    ProductionPartCavity,
    ProductionPlan,
)


SHANGHAI_TZ = pytz.timezone("Asia/Shanghai")


def _stored_document(
    document_id: str,
    *,
    kind: str,
    part_no: str = "",
    model_name: str = "",
    uploaded_at: str = "2026-08-24T09:00:00+08:00",
    ready: bool = True,
    match_rule: str = "exact",
) -> dict:
    source = {
        "url": f"https://cdn.example.test/{document_id}.pdf",
        "format": "pdf",
        "file_name": f"{document_id}.pdf",
    }
    return {
        "id": document_id,
        "kind": kind,
        "part_no": part_no,
        "model_name": model_name,
        "revision": "A",
        "match_rule": match_rule,
        "source": source,
        "preview": source if ready else None,
        "active": True,
        "uploaded_at": uploaded_at,
        "uploaded_by": "developer",
    }


class FieldKanbanSnapshotTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_reset_safe_shots_drive_current_and_next_plan_payload(self):
        target_date = date(2026, 8, 24)
        business_start = SHANGHAI_TZ.localize(datetime(2026, 8, 24, 8, 0))

        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type="injection",
            machine_name="850T-1",
            part_no="PART-A",
            model_name="MODEL-A",
            planned_quantity=40,
            sequence=1,
        )
        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type="injection",
            machine_name="850T-1",
            part_no="PART-B",
            model_name="MODEL-B",
            planned_quantity=40,
            sequence=2,
        )
        ProductionPartCavity.objects.create(
            part_no="PART-A",
            cavity=2,
            cavity_pattern="1x2",
        )
        ProductionPartCavity.objects.create(
            part_no="PART-B",
            cavity=4,
            cavity_pattern="1x4",
        )
        for offset_minutes, capacity in [(-1, 90), (10, 100), (20, 5), (30, 9)]:
            InjectionMonitoringRecord.objects.create(
                machine_name="1호기",
                device_code="field-kanban-machine-1",
                timestamp=business_start + timedelta(minutes=offset_minutes),
                capacity=capacity,
            )

        snapshot = build_field_kanban_snapshot(
            target_date,
            1,
            include_quality=False,
            now=SHANGHAI_TZ.localize(datetime(2026, 8, 24, 14, 0)),
        )

        self.assertEqual(snapshot["machine"]["device_counter"], 9)
        self.assertEqual(snapshot["machine"]["shot_count"], 19)
        self.assertEqual(snapshot["counters"]["business_day_shots"], 19)
        self.assertEqual(snapshot["counters"]["shift_shots"], 19)
        self.assertEqual(snapshot["counters"]["shift_code"], "day")
        self.assertEqual(
            snapshot["counters"]["shift_start"],
            "2026-08-24T08:00:00+08:00",
        )
        self.assertEqual(
            snapshot["counters"]["shift_end"],
            "2026-08-24T20:00:00+08:00",
        )
        self.assertEqual(snapshot["active_plan"]["part_no"], "PART-A")
        self.assertEqual(snapshot["active_plan"]["allocated_shots"], 19)
        self.assertEqual(snapshot["active_plan"]["cavity"], 2)
        self.assertEqual(snapshot["active_plan"]["actual_piece_qty"], 38)
        self.assertEqual(snapshot["counters"]["theoretical_piece_qty"], 38)
        self.assertEqual(snapshot["next_plan"]["part_no"], "PART-B")
        self.assertEqual(snapshot["next_plan"]["allocated_shots"], 0)
        self.assertEqual(snapshot["next_plan"]["cavity"], 4)
        self.assertEqual(
            snapshot["quality"]["unavailable_reason"],
            "quality_permission_required",
        )

    @patch("production.field_kanban.get_injection_machine_shot_context")
    def test_machine_shot_cache_changes_immediately_at_shift_boundary(self, shot_context):
        target_date = date(2026, 8, 24)
        shot_context.side_effect = [
            {"rows": [{"shift_shots": 500, "shift_code": "day"}]},
            {"rows": [{"shift_shots": 0, "shift_code": "night"}]},
        ]

        before_change = _machine_shot_payload(
            target_date,
            1,
            as_of=SHANGHAI_TZ.localize(datetime(2026, 8, 24, 19, 59, 59)),
        )
        after_change = _machine_shot_payload(
            target_date,
            1,
            as_of=SHANGHAI_TZ.localize(datetime(2026, 8, 24, 20, 0)),
        )

        self.assertEqual(before_change["rows"][0]["shift_shots"], 500)
        self.assertEqual(after_change["rows"][0]["shift_shots"], 0)
        self.assertEqual(shot_context.call_count, 2)

    @patch("production.field_kanban._machine_shot_payload")
    @patch("production.field_kanban._production_summary_payload")
    def test_next_plan_skips_completed_rows_after_active_plan(self, production_summary, machine_shots):
        target_date = date(2026, 8, 24)
        production_summary.return_value = {
            "machine_rows": [{
                "machine_number": 5,
                "shot_count": 20,
                "parts": [
                    {
                        "plan_id": 101,
                        "sequence": 1,
                        "part_no": "ACTIVE-PART",
                        "model_name": "ACTIVE-MODEL",
                        "planned_qty": 100,
                        "estimated_qty": 20,
                        "allocated_shots": 20,
                        "cavity": 1,
                        "progress_rate": 20,
                        "status": "in_progress",
                    },
                    {
                        "plan_id": 102,
                        "sequence": 2,
                        "part_no": "OLD-PART",
                        "model_name": "OLD-MODEL",
                        "planned_qty": 10,
                        "estimated_qty": 10,
                        "allocated_shots": 10,
                        "cavity": 1,
                        "progress_rate": 100,
                        "status": "completed",
                    },
                    {
                        "plan_id": 103,
                        "sequence": 3,
                        "part_no": "NEXT-PART",
                        "model_name": "NEXT-MODEL",
                        "planned_qty": 50,
                        "estimated_qty": 0,
                        "allocated_shots": 0,
                        "cavity": 1,
                        "progress_rate": 0,
                        "status": "pending",
                    },
                ],
            }],
        }
        machine_shots.return_value = {
            "rows": [{
                "machine_number": 5,
                "device_code": "imm05",
                "device_counter": 20,
                "shot_count": 20,
                "recent_60m_shots": 1,
                "latest_timestamp": None,
                "is_stale": False,
            }],
        }

        snapshot = build_field_kanban_snapshot(
            target_date,
            5,
            include_quality=False,
            now=SHANGHAI_TZ.localize(datetime(2026, 8, 24, 14, 0)),
        )

        self.assertEqual(snapshot["active_plan"]["plan_id"], 101)
        self.assertEqual([row["plan_id"] for row in snapshot["queue"]], [101, 102, 103])
        self.assertEqual(snapshot["next_plan"]["plan_id"], 103)


class FieldQualitySummaryTests(TestCase):
    @patch("production.field_kanban._quality_source_payload")
    def test_field_kanban_uses_other_label_for_unclassified_quality_issue(
        self,
        quality_source,
    ):
        quality_source.return_value = {
            "items": [{
                "machine_number": 5,
                "part_prefix": "24U411B-L",
                "matching_report_count": 1,
                "reports": [{
                    "report_dt": "2026-08-18T10:24:00+08:00",
                    "section": "LQC_INJ",
                    "problem_types": [{
                        "key": "unclassified",
                        "label": {"zh": "类型未分类", "ko": "유형 미분류"},
                    }],
                    "images": ["https://cdn.example.test/other.jpg"],
                }],
            }],
        }

        result = _quality_summary(
            date(2026, 8, 24),
            5,
            "24U411B-L",
            include_quality=True,
        )

        self.assertEqual(result["issues"][0]["key"], "unclassified")
        self.assertEqual(result["issues"][0]["label"], {"zh": "其他", "ko": "기타"})

    @patch("production.field_kanban._quality_source_payload")
    def test_quality_history_requires_exact_machine_and_current_part_prefix(self, quality_source):
        quality_source.return_value = {
            "items": [
                {
                    "machine_number": 4,
                    "part_prefix": "24U411B-L",
                    "matching_report_count": 99,
                    "reports": [],
                },
                {
                    "machine_number": 5,
                    "part_prefix": "24U411B-L",
                    "matching_report_count": 1,
                    "reports": [{
                        "report_dt": "2026-08-18T10:24:00+08:00",
                        "section": "LQC_INJ",
                        "problem_types": [{
                            "key": "burr_flash",
                            "label": {"zh": "毛刺·飞边", "ko": "버·플래시"},
                        }],
                        "images": ["https://cdn.example.test/quality.jpg"],
                        "action_result": "Inspect edge",
                        "disposition": "Rework",
                    }],
                },
            ],
        }

        result = _quality_summary(
            date(2026, 8, 24),
            5,
            " 24u411b-l ",
            include_quality=True,
        )

        self.assertEqual(result["matching_report_count"], 1)
        self.assertEqual(result["match_basis"], "machine_and_part_prefix_9")
        self.assertEqual(result["issues"][0]["label"]["ko"], "버·플래시")
        self.assertEqual(result["issues"][0]["evidence_count"], 1)
        self.assertIn("과거 품질 이력", result["disclaimer"]["ko"])

    @patch("production.field_kanban._quality_source_payload")
    def test_quality_history_collects_four_unique_images_and_section_counts(self, quality_source):
        quality_source.return_value = {
            "items": [{
                "machine_number": 5,
                "part_prefix": "24U411B-L",
                "matching_report_count": 2,
                "reports": [
                    {
                        "report_dt": "2026-08-18T10:24:00+08:00",
                        "section": "IQC",
                        "problem_types": [{
                            "key": "black_dot",
                            "label": {"zh": "黑点", "ko": "흑점"},
                        }],
                        "images": ["https://cdn.example.test/a.jpg", "https://cdn.example.test/b.jpg"],
                    },
                    {
                        "report_dt": "2026-08-17T09:00:00+08:00",
                        "section": "LQC_INJ",
                        "problem_types": [
                            {"key": "black_dot", "label": {"zh": "黑点", "ko": "흑점"}},
                            {"key": "black_dot", "label": {"zh": "黑点", "ko": "흑점"}},
                        ],
                        "images": [
                            "https://cdn.example.test/b.jpg",
                            "https://cdn.example.test/c.jpg",
                            "https://cdn.example.test/d.jpg",
                            "https://cdn.example.test/e.jpg",
                        ],
                    },
                ],
            }],
        }

        result = _quality_summary(
            date(2026, 8, 24),
            5,
            "24U411B-L",
            include_quality=True,
        )

        issue = result["issues"][0]
        self.assertEqual(issue["evidence_count"], 2)
        self.assertEqual(issue["image_url"], "https://cdn.example.test/a.jpg")
        self.assertEqual(issue["image_urls"], [
            "https://cdn.example.test/a.jpg",
            "https://cdn.example.test/b.jpg",
            "https://cdn.example.test/c.jpg",
            "https://cdn.example.test/d.jpg",
        ])
        self.assertEqual(issue["section_counts"], [
            {"section": "IQC", "evidence_count": 1},
            {"section": "LQC_INJ", "evidence_count": 1},
        ])

    @patch("production.field_kanban._quality_source_payload")
    def test_mixed_defect_report_photos_are_excluded_from_representative_images(
        self,
        quality_source,
    ):
        quality_source.return_value = {
            "items": [{
                "machine_number": 5,
                "part_prefix": "24U411B-L",
                "matching_report_count": 2,
                "reports": [
                    {
                        "report_dt": "2026-08-20T08:00:00+08:00",
                        "section": "LQC_INJ",
                        "problem_types": [
                            {"key": "air_mark", "label": {"zh": "气印", "ko": "가스 마크"}},
                            {"key": "burr_flash", "label": {"zh": "毛刺·飞边", "ko": "버·플래시"}},
                        ],
                        "images": ["https://cdn.example.test/mixed-burr.jpg"],
                    },
                    {
                        "report_dt": "2026-08-19T08:00:00+08:00",
                        "section": "OQC",
                        "problem_types": [
                            {"key": "air_mark", "label": {"zh": "气印", "ko": "가스 마크"}},
                        ],
                        "images": ["https://cdn.example.test/gas-mark.jpg"],
                    },
                ],
            }],
        }

        result = _quality_summary(
            date(2026, 8, 24),
            5,
            "24U411B-L",
            include_quality=True,
        )

        issues = {issue["key"]: issue for issue in result["issues"]}
        self.assertEqual(issues["air_mark"]["evidence_count"], 2)
        self.assertEqual(
            issues["air_mark"]["image_urls"],
            ["https://cdn.example.test/gas-mark.jpg"],
        )
        self.assertEqual(
            issues["air_mark"]["image_url"],
            "https://cdn.example.test/gas-mark.jpg",
        )
        self.assertEqual(issues["burr_flash"]["evidence_count"], 1)
        self.assertEqual(issues["burr_flash"]["image_urls"], [])
        self.assertIsNone(issues["burr_flash"]["image_url"])
        self.assertNotIn(
            "https://cdn.example.test/mixed-burr.jpg",
            [
                image_url
                for issue in result["issues"]
                for image_url in issue["image_urls"]
            ],
        )


class FieldMaterialResolutionTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_part_specific_instruction_beats_model_fallback_and_drawing_is_part_only(self):
        documents = [
            _stored_document(
                "model-instruction",
                kind="work_instruction",
                model_name="MODEL-A",
                uploaded_at="2026-08-24T12:00:00+08:00",
            ),
            _stored_document(
                "part-instruction",
                kind="work_instruction",
                part_no=" part-a ",
                uploaded_at="2026-08-24T10:00:00+08:00",
            ),
            _stored_document(
                "model-drawing-must-not-match",
                kind="drawing",
                model_name="MODEL-A",
            ),
            _stored_document(
                "part-drawing",
                kind="drawing",
                part_no="PART-A",
            ),
        ]

        resolved = resolve_material_documents(
            "PART-A",
            "model-a",
            documents=documents,
        )
        model_only = resolve_material_documents(
            "PART-WITHOUT-DRAWING",
            "MODEL-A",
            documents=documents,
        )

        self.assertEqual(resolved["work_instruction"]["id"], "part-instruction")
        self.assertEqual(resolved["drawing"]["id"], "part-drawing")
        self.assertEqual(model_only["work_instruction"]["id"], "model-instruction")
        self.assertIsNone(model_only["drawing"])

    def test_last_two_part_family_sharing_is_explicit_and_exact_part_wins(self):
        documents = [
            _stored_document(
                "family-instruction",
                kind="work_instruction",
                part_no="24U411B-01",
                model_name="MODEL-A",
                match_rule="part_family_last_two",
                uploaded_at="2026-08-24T12:00:00+08:00",
            ),
            _stored_document(
                "family-drawing",
                kind="drawing",
                part_no="24U411B-01",
                model_name="MODEL-A",
                match_rule="part_family_last_two",
            ),
            _stored_document(
                "exact-source-instruction",
                kind="work_instruction",
                part_no="24U411B-01",
                model_name="MODEL-A",
                uploaded_at="2026-08-24T08:00:00+08:00",
            ),
            _stored_document(
                "exact-instruction",
                kind="work_instruction",
                part_no="24U411B-02",
                uploaded_at="2026-08-24T08:00:00+08:00",
            ),
            _stored_document(
                "legacy-exact",
                kind="drawing",
                part_no="OTHER-01",
            ),
        ]

        exact = resolve_material_documents("24U411B-02", "MODEL-A", documents=documents)
        exact_source = resolve_material_documents("24U411B-01", "MODEL-A", documents=documents)
        shared = resolve_material_documents("24U411B-03", "MODEL-A", documents=documents)
        different_model = resolve_material_documents("24U411B-03", "MODEL-B", documents=documents)
        unequal_length = resolve_material_documents("24U411B-3", "MODEL-A", documents=documents)
        unrelated = resolve_material_documents("OTHER-02", "MODEL-A", documents=documents)

        self.assertEqual(exact["work_instruction"]["id"], "exact-instruction")
        self.assertEqual(exact["work_instruction"]["match_basis"], "exact")
        self.assertEqual(exact_source["work_instruction"]["id"], "exact-source-instruction")
        self.assertEqual(shared["work_instruction"]["id"], "family-instruction")
        self.assertEqual(shared["drawing"]["id"], "family-drawing")
        self.assertEqual(shared["drawing"]["match_basis"], "part_family_last_two")
        self.assertEqual(shared["drawing"]["matched_from_part_no"], "24U411B-01")
        self.assertIsNone(different_model["work_instruction"])
        self.assertIsNone(different_model["drawing"])
        self.assertIsNone(unequal_length["drawing"])
        self.assertIsNone(unrelated["drawing"])

    def test_today_material_readiness_reports_complete_and_missing_models(self):
        target_date = date(2026, 8, 24)
        ready_plan = ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type="injection",
            machine_name="850T-1",
            part_no="PART-READY",
            model_name="MODEL-READY",
            planned_quantity=100,
            sequence=1,
        )
        missing_plan = ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type="injection",
            machine_name="650T-10",
            part_no="PART-MISSING",
            model_name="MODEL-MISSING",
            planned_quantity=200,
            sequence=1,
        )
        MouldDataSnapshot.objects.create(
            snapshot_key=FIELD_MATERIALS_SNAPSHOT_KEY,
            kind=MouldDataSnapshot.KIND_BOARD,
            instance_id="field-materials",
            payload={
                "schema_version": FIELD_MATERIALS_SCHEMA,
                "documents": [
                    _stored_document(
                        "ready-instruction",
                        kind="work_instruction",
                        model_name="MODEL-READY",
                    ),
                    _stored_document(
                        "ready-drawing",
                        kind="drawing",
                        part_no="PART-READY",
                    ),
                ],
            },
        )

        payload = build_field_material_readiness(target_date)
        rows = {row["part_no"]: row for row in payload["models"]}

        self.assertEqual(payload["summary"]["total"], 2)
        self.assertEqual(payload["summary"]["complete"], 1)
        self.assertEqual(payload["summary"]["missing_work_instruction"], 1)
        self.assertEqual(payload["summary"]["missing_drawing"], 1)
        self.assertEqual(rows["PART-READY"]["machine_numbers"], [1])
        self.assertTrue(rows["PART-READY"]["readiness"]["complete"])
        self.assertFalse(rows["PART-MISSING"]["readiness"]["complete"])
        schedules = {row["machine_number"]: row for row in payload["machine_schedules"]}
        self.assertEqual(schedules[1]["plans"][0]["part_no"], "PART-READY")
        self.assertFalse(schedules[1]["plans"][0]["is_current"])
        self.assertEqual(schedules[10]["plans"][0]["status"], "planned")
        self.assertEqual(payload["status_meta"]["source"], "not_requested")

        live_summary = {
            "latest_mes_time": None,
            "reference_time": None,
            "machine_rows": [
                {"parts": [{
                    "plan_id": ready_plan.id,
                    "status": "completed",
                    "estimated_qty": 100,
                    "progress_rate": 100,
                }]},
                {"parts": [{
                    "plan_id": missing_plan.id,
                    "status": "pending",
                    "estimated_qty": 0,
                    "progress_rate": 0,
                }]},
            ],
        }
        with patch("production.field_kanban._production_summary_payload", return_value=live_summary):
            live_payload = build_field_material_readiness(target_date, include_status=True)
        live_schedules = {row["machine_number"]: row for row in live_payload["machine_schedules"]}
        self.assertTrue(live_schedules[1]["plans"][0]["is_completed"])
        self.assertFalse(live_schedules[1]["plans"][0]["is_current"])
        self.assertTrue(live_schedules[10]["plans"][0]["is_current"])
        self.assertEqual(live_payload["status_meta"]["source"], "mes_shot_allocation")

    def test_machine_schedule_keeps_duplicate_sequence_and_lot_rows_in_stable_order(self):
        target_date = date(2026, 8, 27)
        first = ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type="injection",
            machine_name="850T-2",
            part_no="PART-SAME",
            model_name="MODEL-A",
            lot_no="LOT-1",
            planned_quantity=100,
            sequence=5,
        )
        second = ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type="injection",
            machine_name="850T-2",
            part_no="PART-SAME",
            model_name="MODEL-A",
            lot_no="LOT-2",
            planned_quantity=200,
            sequence=5,
        )

        with CaptureQueriesContext(connection) as queries:
            payload = build_field_material_readiness(target_date)
        plans = payload["machine_schedules"][0]["plans"]

        self.assertEqual([row["plan_id"] for row in plans], [first.id, second.id])
        self.assertEqual([row["lot_no"] for row in plans], ["LOT-1", "LOT-2"])
        self.assertEqual([row["display_order"] for row in plans], [1, 2])
        self.assertEqual([row["source_sequence"] for row in plans], [5, 5])
        self.assertLessEqual(len(queries), 3)


class FieldDefectCheckpointTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="imm01")
        self.target_date = date(2026, 8, 24)

    @staticmethod
    def _kanban_payload(*, allocated_shots: int, business_day_shots: int = 100) -> dict:
        plan = {
            "plan_id": 81,
            "sequence": 1,
            "part_no": "PART-A",
            "model_name": "MODEL-A",
            "allocated_shots": allocated_shots,
            "cavity": 2,
        }
        return {
            "active_plan": plan,
            "queue": [plan],
            "counters": {"business_day_shots": business_day_shots},
        }

    def test_server_calculates_piece_arithmetic_and_event_is_idempotent(self):
        with patch(
            "production.field_kanban._defect_checkpoint_context",
            return_value=self._kanban_payload(
                allocated_shots=10,
                business_day_shots=10,
            ),
        ) as build_context:
            checkpoint, created = save_defect_checkpoint(
                target_date=self.target_date,
                machine_number=1,
                event_key="defect:part-change:2026-08-24:1:100:gap",
                trigger="part_change",
                part_no="PART-A",
                items=[
                    {"code": "scratch", "quantity": 2},
                    {"code": "scratch", "quantity": 1},
                ],
                user=self.user,
            )
            duplicate, duplicate_created = save_defect_checkpoint(
                target_date=self.target_date,
                machine_number=1,
                event_key="defect:part-change:2026-08-24:1:100:gap",
                trigger="part_change",
                part_no="PART-A",
                items=[{"code": "black_dot", "quantity": 20}],
                user=self.user,
            )

        self.assertTrue(created)
        self.assertFalse(duplicate_created)
        self.assertEqual(duplicate, checkpoint)
        self.assertEqual(checkpoint["segment_shots"], 10)
        self.assertEqual(checkpoint["cavity"], 2)
        self.assertEqual(checkpoint["gross_piece_qty"], 20)
        self.assertEqual(checkpoint["defect_piece_qty"], 3)
        self.assertEqual(checkpoint["good_piece_qty"], 17)
        self.assertEqual(checkpoint["items"], [{"code": "scratch", "quantity": 3}])
        self.assertEqual(build_context.call_count, 1)

        stored = MouldDataSnapshot.objects.get(
            snapshot_key="field-defects-v1-20260824-01"
        )
        self.assertEqual(len(stored.payload["checkpoints"]), 1)

    def test_checkpoint_context_queries_only_requested_machine(self):
        for machine_number in range(1, 18):
            ProductionPlan.objects.create(
                plan_date=self.target_date,
                plan_type="injection",
                machine_name=f"850T-{machine_number}",
                part_no=f"PART-{machine_number}",
                model_name=f"MODEL-{machine_number}",
                planned_quantity=100,
                sequence=1,
            )

        with CaptureQueriesContext(connection) as queries:
            context = _defect_checkpoint_context(self.target_date, 1)

        self.assertEqual(context["active_plan"]["part_no"], "PART-1")
        self.assertLessEqual(len(queries), 15)

    def test_defect_quantity_above_server_gross_is_rejected_without_append(self):
        with patch(
            "production.field_kanban._defect_checkpoint_context",
            return_value=self._kanban_payload(
                allocated_shots=1,
                business_day_shots=1,
            ),
        ):
            with self.assertRaises(FieldKanbanError) as raised:
                save_defect_checkpoint(
                    target_date=self.target_date,
                    machine_number=1,
                    event_key="manual:2026-08-24:1:999",
                    trigger="manual",
                    part_no="PART-A",
                    items=[{"code": "scratch", "quantity": 3}],
                    user=self.user,
                )

        self.assertEqual(raised.exception.code, "defect_exceeds_gross_quantity")
        self.assertEqual(raised.exception.status_code, 409)
        self.assertFalse(
            MouldDataSnapshot.objects.filter(
                snapshot_key="field-defects-v1-20260824-01"
            ).exists()
        )

    def test_plan_id_wins_over_legacy_renumbered_sequence(self):
        first = {
            "plan_id": 81,
            "sequence": 1,
            "part_no": "PART-A",
            "model_name": "MODEL-A",
            "allocated_shots": 20,
            "cavity": 2,
        }
        requested = {
            "plan_id": 82,
            "sequence": 2,
            "part_no": "PART-A",
            "model_name": "MODEL-A",
            "allocated_shots": 10,
            "cavity": 4,
        }
        snapshot = {
            "active_plan": requested,
            "queue": [first, requested],
            "counters": {"business_day_shots": 30},
        }

        with patch(
            "production.field_kanban._defect_checkpoint_context",
            return_value=snapshot,
        ):
            checkpoint, created = save_defect_checkpoint(
                target_date=self.target_date,
                machine_number=1,
                event_key="defect:part-change:2026-08-24:1:101:gap",
                trigger="part_change",
                plan_id=82,
                part_no="PART-A",
                sequence=99,
                items=[],
                user=self.user,
            )

        self.assertTrue(created)
        self.assertEqual(checkpoint["plan_id"], 82)
        self.assertEqual(checkpoint["sequence"], 2)
        self.assertEqual(checkpoint["segment_shots"], 30)
        self.assertEqual(checkpoint["gross_piece_qty"], 120)

    def test_segment_uses_monotonic_business_day_counter_not_capped_plan_shots(self):
        payloads = [
            self._kanban_payload(allocated_shots=5, business_day_shots=60),
            self._kanban_payload(allocated_shots=5, business_day_shots=75),
            # Simulate an older concurrent observation that commits late.
            self._kanban_payload(allocated_shots=5, business_day_shots=70),
            self._kanban_payload(allocated_shots=5, business_day_shots=80),
        ]
        checkpoints = []
        with patch(
            "production.field_kanban._defect_checkpoint_context",
            side_effect=payloads,
        ):
            for index in range(4):
                checkpoint, _created = save_defect_checkpoint(
                    target_date=self.target_date,
                    machine_number=1,
                    event_key=f"manual:{self.target_date}:1:{index}",
                    trigger="manual",
                    part_no="PART-A",
                    items=[],
                    user=self.user,
                )
                checkpoints.append(checkpoint)

        self.assertEqual(
            [row["segment_shots"] for row in checkpoints],
            [60, 15, 0, 5],
        )
        self.assertEqual(checkpoints[2]["ending_business_day_shots"], 75)
        self.assertEqual(checkpoints[0]["gross_piece_qty"], 120)
        self.assertEqual(checkpoints[-1]["ending_business_day_shots"], 80)

    def test_shift_event_key_is_bound_to_date_machine_trigger_and_due_time(self):
        with patch(
            "production.field_kanban._defect_checkpoint_context",
        ) as build_context:
            with self.assertRaises(FieldKanbanError) as mismatch:
                save_defect_checkpoint(
                    target_date=self.target_date,
                    machine_number=1,
                    event_key="defect:shift:2026-08-24:2:2000",
                    trigger="shift_2000",
                    items=[],
                    user=self.user,
                    now=SHANGHAI_TZ.localize(datetime(2026, 8, 24, 19, 30)),
                )
            with self.assertRaises(FieldKanbanError) as early:
                save_defect_checkpoint(
                    target_date=self.target_date,
                    machine_number=1,
                    event_key="defect:shift:2026-08-24:1:2000",
                    trigger="shift_2000",
                    items=[],
                    user=self.user,
                    now=SHANGHAI_TZ.localize(datetime(2026, 8, 24, 19, 29, 59)),
                )

        self.assertEqual(mismatch.exception.code, "invalid_shift_event_key")
        self.assertEqual(early.exception.code, "shift_checkpoint_not_due")
        build_context.assert_not_called()

    def test_part_change_and_manual_event_keys_are_bound_to_date_and_machine(self):
        with patch(
            "production.field_kanban._defect_checkpoint_context",
        ) as build_context:
            with self.assertRaises(FieldKanbanError) as part_change_mismatch:
                save_defect_checkpoint(
                    target_date=self.target_date,
                    machine_number=1,
                    event_key="defect:part-change:2026-08-24:2:100:gap",
                    trigger="part_change",
                    items=[],
                    user=self.user,
                )
            with self.assertRaises(FieldKanbanError) as manual_mismatch:
                save_defect_checkpoint(
                    target_date=self.target_date,
                    machine_number=1,
                    event_key="manual:2026-08-23:1:100",
                    trigger="manual",
                    items=[],
                    user=self.user,
                )

        self.assertEqual(
            part_change_mismatch.exception.code,
            "invalid_part_change_event_key",
        )
        self.assertEqual(manual_mismatch.exception.code, "invalid_manual_event_key")
        build_context.assert_not_called()

    def test_valid_morning_shift_checkpoint_can_be_saved_after_rollover(self):
        with patch(
            "production.field_kanban._defect_checkpoint_context",
            return_value=self._kanban_payload(
                allocated_shots=5,
                business_day_shots=7,
            ),
        ):
            checkpoint, created = save_defect_checkpoint(
                target_date=self.target_date,
                machine_number=1,
                event_key="defect:shift:2026-08-24:1:0800",
                trigger="shift_0800",
                plan_id=81,
                part_no="PART-A",
                items=[{"code": "scratch", "quantity": 2}],
                user=self.user,
                now=SHANGHAI_TZ.localize(datetime(2026, 8, 25, 8, 1)),
            )

        self.assertTrue(created)
        self.assertEqual(checkpoint["business_date"], "2026-08-24")
        self.assertEqual(checkpoint["segment_shots"], 7)
        self.assertEqual(checkpoint["gross_piece_qty"], 14)
        self.assertEqual(checkpoint["good_piece_qty"], 12)


class FieldShiftPromptTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_shift_prompts_start_30_minutes_early_and_morning_uses_prior_business_date(self):
        target_date = date(2026, 8, 24)
        active_plan = {"part_no": "PART-A", "model_name": "MODEL-A"}

        self.assertIsNone(
            _pending_shift_prompt(
                target_date,
                1,
                active_plan,
                now=SHANGHAI_TZ.localize(datetime(2026, 8, 24, 19, 29, 59)),
            )
        )
        evening = _pending_shift_prompt(
            target_date,
            1,
            active_plan,
            now=SHANGHAI_TZ.localize(datetime(2026, 8, 24, 19, 30)),
        )
        self.assertEqual(evening["trigger"], "shift_2000")
        self.assertEqual(evening["business_date"], target_date.isoformat())
        self.assertFalse(evening["is_overdue"])

        evening_event_key = evening["event_key"]
        MouldDataSnapshot.objects.create(
            snapshot_key=_defect_snapshot_key(target_date, 1),
            kind=MouldDataSnapshot.KIND_BOARD,
            instance_id="field-defects-01",
            payload={
                "schema_version": FIELD_DEFECTS_SCHEMA,
                "business_date": target_date.isoformat(),
                "machine_number": 1,
                "checkpoints": [{"event_key": evening_event_key}],
            },
        )

        morning = _pending_shift_prompt(
            target_date,
            1,
            active_plan,
            now=SHANGHAI_TZ.localize(datetime(2026, 8, 25, 7, 30)),
        )
        self.assertEqual(morning["trigger"], "shift_0800")
        self.assertEqual(morning["business_date"], target_date.isoformat())
        self.assertEqual(morning["part_no"], "PART-A")
        self.assertFalse(morning["is_overdue"])

    def test_overdue_prompt_is_non_historical_and_requires_an_active_plan(self):
        current_date = date(2026, 8, 25)
        active_plan = {"part_no": "PART-A", "model_name": "MODEL-A"}

        overdue = _pending_shift_prompt(
            current_date,
            1,
            active_plan,
            now=SHANGHAI_TZ.localize(datetime(2026, 8, 25, 20, 45)),
        )
        self.assertEqual(overdue["trigger"], "shift_2000")
        self.assertTrue(overdue["is_overdue"])
        self.assertIsNone(
            _pending_shift_prompt(
                current_date + timedelta(days=1),
                1,
                active_plan,
                now=SHANGHAI_TZ.localize(datetime(2026, 8, 26, 8, 1)),
            )
        )
        self.assertIsNone(
            _pending_shift_prompt(
                current_date,
                1,
                None,
                now=SHANGHAI_TZ.localize(datetime(2026, 8, 25, 19, 30)),
            )
        )


class FieldKanbanPermissionTests(TestCase):
    def setUp(self):
        user_model = get_user_model()
        self.terminal = user_model.objects.create_user(username="imm05")
        self.development_viewer = user_model.objects.create_user(username="dev-viewer")
        self.development_viewer.profile.can_view_development = True
        self.development_viewer.profile.can_edit_development = False
        self.development_viewer.profile.save(
            update_fields=["can_view_development", "can_edit_development"]
        )
        self.development_editor = user_model.objects.create_user(username="dev-editor")
        self.development_editor.profile.can_view_development = True
        self.development_editor.profile.can_edit_development = True
        self.development_editor.profile.save(
            update_fields=["can_view_development", "can_edit_development"]
        )

    def _client_for(self, user):
        client = APIClient()
        client.force_authenticate(user)
        return client

    def test_field_terminal_cannot_read_another_machine(self):
        response = self._client_for(self.terminal).get(
            "/api/production/field-kanban/",
            {"date": "2026-08-24", "machine_number": 6},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "field_terminal_machine_mismatch")

    def test_snapshot_can_defer_quality_and_editor_can_save_defect(self):
        self.terminal.profile.can_edit_injection = True
        self.terminal.profile.save(update_fields=["can_edit_injection"])
        client = self._client_for(self.terminal)
        payload = FieldDefectCheckpointTests._kanban_payload(
            allocated_shots=10,
            business_day_shots=10,
        )

        with patch(
            "production.field_kanban_views.build_field_kanban_snapshot",
            return_value={"quality": {"issues": []}},
        ) as build_snapshot:
            snapshot_response = client.get(
                "/api/production/field-kanban/",
                {
                    "date": "2026-08-24",
                    "machine_number": 5,
                    "include_quality": "false",
                },
            )
        with patch(
            "production.field_kanban._defect_checkpoint_context",
            return_value=payload,
        ):
            defect_response = client.post(
                "/api/production/field-kanban/defects/",
                {
                    "business_date": "2026-08-24",
                    "machine_number": 5,
                    "event_key": "manual:2026-08-24:5:100",
                    "trigger": "manual",
                    "plan_id": 81,
                    "part_no": "PART-A",
                    "items": [{"code": "scratch", "quantity": 2}],
                },
                format="json",
            )

        self.assertEqual(snapshot_response.status_code, 200)
        self.assertFalse(build_snapshot.call_args.kwargs["include_quality"])
        self.assertEqual(defect_response.status_code, 201)
        self.assertEqual(defect_response.json()["checkpoint"]["good_piece_qty"], 18)

    def test_development_view_permission_does_not_grant_material_edit(self):
        viewer_client = self._client_for(self.development_viewer)
        with patch(
            "production.field_kanban_views.build_field_material_readiness",
            return_value={"models": [], "summary": {}},
        ):
            read_response = viewer_client.get(
                "/api/production/field-materials/",
                {"date": "2026-08-24"},
            )
        denied_response = viewer_client.post(
            "/api/production/field-materials/",
            {
                "kind": "work_instruction",
                "model_name": "MODEL-A",
                "file": SimpleUploadedFile("work.pdf", b"%PDF-1.4\n"),
            },
            format="multipart",
        )

        self.assertEqual(read_response.status_code, 200)
        self.assertEqual(denied_response.status_code, 403)

        editor_client = self._client_for(self.development_editor)
        with patch(
            "production.field_kanban_views.save_field_material",
            return_value={"id": "document-1", "ready": True},
        ) as save_material:
            allowed_response = editor_client.post(
                "/api/production/field-materials/",
                {
                    "kind": "work_instruction",
                    "model_name": "MODEL-A",
                    "match_rule": "part_family_last_two",
                    "file": SimpleUploadedFile("work.pdf", b"%PDF-1.4\n"),
                },
                format="multipart",
            )

        self.assertEqual(allowed_response.status_code, 201)
        self.assertTrue(save_material.called)
        self.assertEqual(
            save_material.call_args.kwargs["match_rule"],
            "part_family_last_two",
        )
        self.assertTrue(
            save_material.call_args.kwargs["conversion_notification_url"].endswith(
                "/api/production/field-materials/conversion-callback/"
            )
        )

    @patch("production.field_kanban_views.apply_field_material_conversion_notification")
    @patch("production.field_kanban_views.cloudinary.utils.verify_notification_signature")
    def test_cloudinary_conversion_webhook_requires_signature_and_applies_result(
        self,
        verify_signature,
        apply_notification,
    ):
        verify_signature.return_value = True
        apply_notification.return_value = {
            "id": "document-1",
            "ready": True,
            "conversion_status": "ready",
        }
        response = APIClient().post(
            "/api/production/field-materials/conversion-callback/",
            {
                "notification_type": "info",
                "info_kind": "aspose",
                "info_status": "complete",
                "public_id": "field/source.pptx",
            },
            format="json",
            HTTP_X_CLD_TIMESTAMP="1787803200",
            HTTP_X_CLD_SIGNATURE="valid-signature",
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["accepted"])
        apply_notification.assert_called_once_with(
            public_id="field/source.pptx",
            info_status="complete",
            error="",
        )

        verify_signature.return_value = False
        denied = APIClient().post(
            "/api/production/field-materials/conversion-callback/",
            {
                "notification_type": "info",
                "info_kind": "aspose",
                "info_status": "complete",
                "public_id": "field/source.pptx",
            },
            format="json",
            HTTP_X_CLD_TIMESTAMP="1787803200",
            HTTP_X_CLD_SIGNATURE="invalid-signature",
        )
        self.assertEqual(denied.status_code, 403)

    def test_profile_missing_field_writes_fail_closed(self):
        user = get_user_model().objects.create_user(username="profile-missing")
        user.profile.delete()
        user = get_user_model().objects.get(pk=user.pk)
        client = self._client_for(user)

        material_read_response = client.get(
            "/api/production/field-materials/",
            {"date": "2026-08-24"},
        )
        defect_response = client.post(
            "/api/production/field-kanban/defects/",
            {
                "business_date": "2026-08-24",
                "machine_number": 1,
                "event_key": "manual:2026-08-24:1:profile-missing",
                "trigger": "manual",
                "items": [],
            },
            format="json",
        )
        material_response = client.post(
            "/api/production/field-materials/",
            {
                "kind": "work_instruction",
                "model_name": "MODEL-A",
                "file": SimpleUploadedFile("work.pdf", b"%PDF-1.4\n"),
            },
            format="multipart",
        )

        self.assertEqual(material_read_response.status_code, 403)
        self.assertEqual(defect_response.status_code, 403)
        self.assertEqual(material_response.status_code, 403)


class FieldDowntimeConfirmationScopeTests(TestCase):
    def setUp(self):
        self.target_date = date(2026, 8, 24)
        self.terminal = get_user_model().objects.create_user(username="imm05")
        self.terminal.profile.can_edit_injection = True
        self.terminal.profile.save(update_fields=["can_edit_injection"])
        self.client = APIClient()
        self.client.force_authenticate(self.terminal)
        self.own = self._confirmation(5, minute=100)
        self.other = self._confirmation(6, minute=200)

    def _confirmation(self, machine_number: int, *, minute: int):
        start = SHANGHAI_TZ.localize(datetime(2026, 8, 24, 10, 0))
        return InjectionDowntimeConfirmation.objects.create(
            business_date=self.target_date,
            event_key=f"2026-08-24:{machine_number}:{minute}:gap",
            machine_key=str(machine_number),
            machine_label=f"MACHINE-{machine_number}",
            detected_type="mold_change",
            detected_start=start,
            detected_end=start + timedelta(minutes=15),
            duration_minutes=15,
            resolution="confirmed",
            reason_code="mold_change",
            confirmed_by=self.terminal,
        )

    def test_terminal_reads_only_its_assigned_machine_confirmations(self):
        response = self.client.get(
            "/api/production/injection-downtime-confirmations/",
            {"date": self.target_date.isoformat()},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [row["event_key"] for row in response.json()["confirmations"]],
            [self.own.event_key],
        )

    def test_terminal_cannot_confirm_or_reset_another_machine(self):
        start = SHANGHAI_TZ.localize(datetime(2026, 8, 24, 12, 0))
        confirm_response = self.client.post(
            "/api/production/injection-downtime-confirmations/",
            {
                "business_date": self.target_date.isoformat(),
                "event_key": "2026-08-24:6:300:gap",
                "machine_key": "6",
                "machine_label": "MACHINE-6",
                "detected_type": "mold_change",
                "detected_start": start.isoformat(),
                "detected_end": (start + timedelta(minutes=15)).isoformat(),
                "resolution": "confirmed",
                "reason_code": "mold_change",
                "evidence": {},
            },
            format="json",
        )
        reset_response = self.client.post(
            "/api/production/injection-downtime-confirmations/",
            {"action": "reset", "event_key": self.other.event_key},
            format="json",
        )

        self.assertEqual(confirm_response.status_code, 403)
        self.assertEqual(reset_response.status_code, 403)
        self.assertTrue(
            InjectionDowntimeConfirmation.objects.filter(pk=self.other.pk).exists()
        )

        own_reset = self.client.post(
            "/api/production/injection-downtime-confirmations/",
            {"action": "reset", "event_key": self.own.event_key},
            format="json",
        )
        self.assertEqual(own_reset.status_code, 200)
        self.assertTrue(own_reset.json()["deleted"])


class FieldMaterialUploadTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = get_user_model().objects.create_user(username="dev-editor")

    @staticmethod
    def _pptx_bytes(padding_size: int = 0) -> bytes:
        stream = BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types />")
            archive.writestr("ppt/presentation.xml", "<presentation />")
            if padding_size:
                archive.writestr("ppt/media/padding.bin", b"\0" * padding_size)
        return stream.getvalue()

    @patch("production.field_kanban.cloudinary.api.update")
    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_valid_pptx_upload_starts_automatic_preview_conversion(self, upload, update):
        upload.return_value = {
            "secure_url": "https://cdn.example.test/source.pptx",
            "public_id": "field/source.pptx",
            "resource_type": "raw",
            "bytes": 123,
        }
        source = SimpleUploadedFile(
            "../../unsafe/slides.pptx",
            self._pptx_bytes(),
            content_type=(
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            ),
        )

        document = save_field_material(
            kind="work_instruction",
            part_no="PART-A",
            model_name="MODEL-A",
            revision="B",
            source_file=source,
            preview_pdf=None,
            user=self.user,
            match_rule="part_family_last_two",
            conversion_notification_url="https://api.example.test/conversion-callback/",
        )

        self.assertEqual(document["source_format"], "pptx")
        self.assertEqual(document["source_file_name"], "slides.pptx")
        self.assertEqual(document["match_rule"], "part_family_last_two")
        self.assertNotIn("..", document["source_file_name"])
        self.assertFalse(document["ready"])
        self.assertIsNone(document["preview_url"])
        self.assertEqual(document["conversion_status"], "pending")
        self.assertEqual(document["conversion_provider"], "cloudinary_aspose")
        self.assertEqual(upload.call_count, 1)
        self.assertEqual(upload.call_args.kwargs["resource_type"], "raw")
        self.assertFalse(upload.call_args.kwargs["overwrite"])
        update.assert_called_once_with(
            "field/source.pptx",
            resource_type="raw",
            raw_convert="aspose",
            notification_url="https://api.example.test/conversion-callback/",
        )

    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_invalid_material_match_rule_is_rejected_before_upload(self, upload):
        with self.assertRaises(FieldKanbanError) as invalid_rule:
            save_field_material(
                kind="work_instruction",
                part_no="PART-A",
                model_name="MODEL-A",
                revision="",
                source_file=SimpleUploadedFile("instruction.pdf", b"%PDF-1.4\n"),
                preview_pdf=None,
                user=self.user,
                match_rule="all_parts",
            )
        with self.assertRaises(FieldKanbanError) as short_part:
            save_field_material(
                kind="drawing",
                part_no="A1",
                model_name="MODEL-A",
                revision="",
                source_file=SimpleUploadedFile("drawing.pdf", b"%PDF-1.4\n"),
                preview_pdf=None,
                user=self.user,
                match_rule="part_family_last_two",
            )
        with self.assertRaises(FieldKanbanError) as missing_model:
            save_field_material(
                kind="drawing",
                part_no="PART-01",
                model_name="",
                revision="",
                source_file=SimpleUploadedFile("drawing.pdf", b"%PDF-1.4\n"),
                preview_pdf=None,
                user=self.user,
                match_rule="part_family_last_two",
            )

        self.assertEqual(invalid_rule.exception.code, "invalid_material_match_rule")
        self.assertEqual(short_part.exception.code, "material_part_family_required")
        self.assertEqual(missing_model.exception.code, "material_part_family_model_required")
        upload.assert_not_called()

    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_shared_replacement_is_scoped_by_family_model_and_does_not_deactivate_exact(self, upload):
        upload.return_value = {
            "secure_url": "https://cdn.example.test/document.pdf",
            "public_id": "field/document",
            "resource_type": "image",
            "pages": 3,
            "bytes": 12,
        }

        def save(part_no: str, model_name: str, match_rule: str) -> dict:
            return save_field_material(
                kind="drawing",
                part_no=part_no,
                model_name=model_name,
                revision="A",
                source_file=SimpleUploadedFile(
                    f"{part_no}-{model_name}.pdf",
                    b"%PDF-1.4\n",
                ),
                preview_pdf=None,
                user=self.user,
                match_rule=match_rule,
            )

        shared_a = save("PART-01", "MODEL-A", "part_family_last_two")
        exact_a = save("PART-01", "MODEL-A", "exact")
        shared_a_replacement = save("PART-02", "MODEL-A", "part_family_last_two")
        shared_b = save("PART-03", "MODEL-B", "part_family_last_two")

        manifest = MouldDataSnapshot.objects.get(
            snapshot_key=FIELD_MATERIALS_SNAPSHOT_KEY,
        ).payload
        active_by_id = {
            row["id"]: row.get("active", True)
            for row in manifest["documents"]
        }
        self.assertFalse(active_by_id[shared_a["id"]])
        self.assertTrue(active_by_id[exact_a["id"]])
        self.assertTrue(active_by_id[shared_a_replacement["id"]])
        self.assertTrue(active_by_id[shared_b["id"]])
        self.assertEqual(shared_b["preview_resource_type"], "image")
        self.assertEqual(shared_b["page_count"], 3)
        self.assertTrue(all(call.kwargs["resource_type"] == "image" for call in upload.call_args_list))
        self.assertTrue(all(not call.kwargs["public_id"].endswith(".pdf") for call in upload.call_args_list))

    @patch("production.field_kanban.cloudinary.api.update")
    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_legacy_ppt_upload_starts_automatic_preview_conversion(self, upload, update):
        upload.return_value = {
            "secure_url": "https://cdn.example.test/source.ppt",
            "public_id": "field/source.ppt",
            "resource_type": "raw",
            "bytes": 512,
        }
        ole_header = bytearray(512)
        ole_header[:8] = bytes.fromhex("d0cf11e0a1b11ae1")
        ole_header[26:28] = (3).to_bytes(2, "little")
        ole_header[28:30] = bytes.fromhex("feff")
        ole_header[30:32] = (9).to_bytes(2, "little")
        ole_header[32:34] = (6).to_bytes(2, "little")
        source = SimpleUploadedFile(
            "instruction.ppt",
            bytes(ole_header),
            content_type="application/vnd.ms-powerpoint",
        )

        document = save_field_material(
            kind="work_instruction",
            part_no="PART-B",
            model_name="MODEL-B",
            revision="C",
            source_file=source,
            preview_pdf=None,
            user=self.user,
        )

        self.assertEqual(document["source_format"], "ppt")
        self.assertFalse(document["ready"])
        self.assertIsNone(document["preview_url"])
        self.assertEqual(document["conversion_status"], "pending")
        self.assertEqual(upload.call_count, 1)
        update.assert_called_once_with(
            "field/source.ppt",
            resource_type="raw",
            raw_convert="aspose",
        )

    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_pptx_over_conversion_limit_requires_single_pdf_upload_instead(self, upload):
        with self.assertRaises(FieldKanbanError) as too_large:
            save_field_material(
                kind="work_instruction",
                part_no="PART-L",
                model_name="MODEL-L",
                revision="A",
                source_file=SimpleUploadedFile(
                    "large.pptx",
                    self._pptx_bytes(10 * 1024 * 1024),
                ),
                preview_pdf=None,
                user=self.user,
            )

        self.assertEqual(too_large.exception.code, "office_conversion_file_too_large")
        self.assertEqual(too_large.exception.status_code, 413)
        self.assertIn("upload the PDF instead", too_large.exception.detail)
        upload.assert_not_called()

    @patch("production.field_kanban.cloudinary.api.resource")
    @patch("production.field_kanban.cloudinary.api.update")
    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_pptx_conversion_callback_makes_all_slides_ready(self, upload, update, resource):
        upload.return_value = {
            "secure_url": "https://cdn.example.test/raw/source.pptx",
            "public_id": "field/source.pptx",
            "resource_type": "raw",
            "bytes": 123,
        }
        resource.return_value = {
            "secure_url": "https://cdn.example.test/image/source.pptx.pdf",
            "public_id": "field/source.pptx",
            "resource_type": "image",
            "format": "pdf",
            "pages": 7,
            "bytes": 456,
        }
        pending = save_field_material(
            kind="work_instruction",
            part_no="PART-C",
            model_name="MODEL-C",
            revision="D",
            source_file=SimpleUploadedFile(
                "slides.pptx",
                self._pptx_bytes(),
                content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ),
            preview_pdf=None,
            user=self.user,
        )

        ready = apply_field_material_conversion_notification(
            public_id="field/source.pptx",
            info_status="complete",
        )

        self.assertEqual(pending["conversion_status"], "pending")
        self.assertIsNotNone(ready)
        self.assertTrue(ready["ready"])
        self.assertEqual(ready["conversion_status"], "ready")
        self.assertEqual(ready["preview_resource_type"], "image")
        self.assertEqual(ready["preview_format"], "pdf")
        self.assertEqual(ready["preview_url"], "https://cdn.example.test/image/source.pptx.pdf")
        self.assertEqual(ready["page_count"], 7)
        late_failure = apply_field_material_conversion_notification(
            public_id="field/source.pptx",
            info_status="failed",
            error="late duplicate failure",
        )
        self.assertIsNotNone(late_failure)
        self.assertTrue(late_failure["ready"])
        self.assertEqual(late_failure["conversion_status"], "ready")
        resource.assert_called_once_with(
            "field/source.pptx",
            resource_type="image",
            type="upload",
        )

    @patch("production.field_kanban.cloudinary.api.resource")
    @patch("production.field_kanban.cloudinary.api.update")
    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_pptx_replacement_keeps_published_document_until_conversion_succeeds(
        self,
        upload,
        update,
        resource,
    ):
        upload.side_effect = [
            {
                "secure_url": "https://cdn.example.test/image/current.pdf",
                "public_id": "field/current",
                "resource_type": "image",
                "format": "pdf",
                "pages": 2,
            },
            {
                "secure_url": "https://cdn.example.test/raw/replacement.pptx",
                "public_id": "field/replacement.pptx",
                "resource_type": "raw",
                "bytes": 123,
            },
        ]
        resource.return_value = {
            "secure_url": "https://cdn.example.test/image/replacement.pptx.pdf",
            "public_id": "field/replacement.pptx",
            "resource_type": "image",
            "format": "pdf",
            "pages": 6,
        }
        current = save_field_material(
            kind="work_instruction",
            part_no="PART-S",
            model_name="MODEL-S",
            revision="A",
            source_file=SimpleUploadedFile("current.pdf", b"%PDF-1.4\n"),
            preview_pdf=None,
            user=self.user,
        )
        pending = save_field_material(
            kind="work_instruction",
            part_no="PART-S",
            model_name="MODEL-S",
            revision="B",
            source_file=SimpleUploadedFile("replacement.pptx", self._pptx_bytes()),
            preview_pdf=None,
            user=self.user,
        )

        field_before = resolve_material_documents("PART-S", "MODEL-S")
        manifest_before = MouldDataSnapshot.objects.get(
            snapshot_key=FIELD_MATERIALS_SNAPSHOT_KEY,
        ).payload["documents"]
        management_before = resolve_material_documents(
            "PART-S",
            "MODEL-S",
            documents=manifest_before,
            include_pending_replacements=True,
        )

        self.assertEqual(field_before["work_instruction"]["id"], current["id"])
        self.assertTrue(field_before["work_instruction"]["ready"])
        self.assertEqual(management_before["work_instruction"]["id"], pending["id"])
        self.assertEqual(management_before["work_instruction"]["conversion_status"], "pending")
        resource.assert_not_called()

        converted = apply_field_material_conversion_notification(
            public_id="field/replacement.pptx",
            info_status="complete",
        )
        field_after = resolve_material_documents("PART-S", "MODEL-S")
        stored_after = {
            row["id"]: row
            for row in MouldDataSnapshot.objects.get(
                snapshot_key=FIELD_MATERIALS_SNAPSHOT_KEY,
            ).payload["documents"]
        }

        self.assertTrue(converted["ready"])
        self.assertEqual(field_after["work_instruction"]["id"], pending["id"])
        self.assertFalse(stored_after[current["id"]]["active"])
        self.assertTrue(stored_after[pending["id"]]["active"])
        self.assertFalse(stored_after[pending["id"]]["pending_replacement"])

    @patch("production.field_kanban.cloudinary.api.resource")
    @patch("production.field_kanban.cloudinary.api.update")
    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_pending_pptx_recovers_when_conversion_callback_is_missed(self, upload, update, resource):
        upload.return_value = {
            "secure_url": "https://cdn.example.test/raw/recovery.pptx",
            "public_id": "field/recovery.pptx",
            "resource_type": "raw",
            "bytes": 123,
        }
        resource.return_value = {
            "secure_url": "https://cdn.example.test/image/recovery.pptx.pdf",
            "public_id": "field/recovery.pptx",
            "resource_type": "image",
            "format": "pdf",
            "pages": 5,
        }
        save_field_material(
            kind="work_instruction",
            part_no="PART-R",
            model_name="MODEL-R",
            revision="A",
            source_file=SimpleUploadedFile("recovery.pptx", self._pptx_bytes()),
            preview_pdf=None,
            user=self.user,
        )

        build_field_material_readiness(date(2026, 8, 24))
        resolved = resolve_material_documents("PART-R", "MODEL-R")

        self.assertTrue(resolved["work_instruction"]["ready"])
        self.assertEqual(resolved["work_instruction"]["page_count"], 5)
        self.assertEqual(resolved["work_instruction"]["conversion_status"], "ready")

    @patch("production.field_kanban.cloudinary.api.update")
    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_pptx_source_is_preserved_when_automatic_conversion_cannot_start(self, upload, update):
        upload.side_effect = [
            {
                "secure_url": "https://cdn.example.test/image/current.pdf",
                "public_id": "field/current",
                "resource_type": "image",
                "format": "pdf",
                "pages": 2,
            },
            {
                "secure_url": "https://cdn.example.test/raw/source.pptx",
                "public_id": "field/source.pptx",
                "resource_type": "raw",
                "bytes": 123,
            },
        ]
        update.side_effect = RuntimeError("add-on unavailable")

        current = save_field_material(
            kind="work_instruction",
            part_no="PART-D",
            model_name="MODEL-D",
            revision="OLD",
            source_file=SimpleUploadedFile("current.pdf", b"%PDF-1.4\n"),
            preview_pdf=None,
            user=self.user,
        )

        document = save_field_material(
            kind="work_instruction",
            part_no="PART-D",
            model_name="MODEL-D",
            revision="A",
            source_file=SimpleUploadedFile("slides.pptx", self._pptx_bytes()),
            preview_pdf=None,
            user=self.user,
        )

        self.assertEqual(document["source_url"], "https://cdn.example.test/raw/source.pptx")
        self.assertEqual(document["conversion_status"], "failed")
        self.assertFalse(document["ready"])
        stored = MouldDataSnapshot.objects.get(
            snapshot_key=FIELD_MATERIALS_SNAPSHOT_KEY,
        ).payload["documents"]
        stored_by_id = {row["id"]: row for row in stored}
        self.assertEqual(stored_by_id[document["id"]]["conversion"]["status"], "failed")
        self.assertFalse(stored_by_id[document["id"]]["active"])
        self.assertTrue(stored_by_id[current["id"]]["active"])
        field_document = resolve_material_documents("PART-D", "MODEL-D")["work_instruction"]
        self.assertEqual(field_document["id"], current["id"])

    @patch("production.field_kanban.cloudinary.api.update")
    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_pptx_with_manual_pdf_preview_is_ready_without_addon(self, upload, update):
        upload.side_effect = [
            {
                "secure_url": "https://cdn.example.test/raw/source.pptx",
                "public_id": "field/source.pptx",
                "resource_type": "raw",
                "bytes": 123,
            },
            {
                "secure_url": "https://cdn.example.test/image/preview.pdf",
                "public_id": "field/preview",
                "resource_type": "image",
                "format": "pdf",
                "pages": 4,
                "bytes": 456,
            },
        ]

        document = save_field_material(
            kind="work_instruction",
            part_no="PART-E",
            model_name="MODEL-E",
            revision="A",
            source_file=SimpleUploadedFile("slides.pptx", self._pptx_bytes()),
            preview_pdf=SimpleUploadedFile("slides-preview.pdf", b"%PDF-1.4\n"),
            user=self.user,
        )

        self.assertTrue(document["ready"])
        self.assertIsNone(document["conversion_status"])
        self.assertEqual(document["page_count"], 4)
        self.assertEqual(upload.call_count, 2)
        update.assert_not_called()

    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_invalid_pptx_archive_and_spoofed_pdf_are_rejected_before_upload(self, upload):
        with self.assertRaises(FieldKanbanError) as invalid_pptx:
            save_field_material(
                kind="work_instruction",
                part_no="PART-A",
                model_name="MODEL-A",
                revision="",
                source_file=SimpleUploadedFile("slides.pptx", b"PK-not-a-zip"),
                preview_pdf=None,
                user=self.user,
            )
        with self.assertRaises(FieldKanbanError) as invalid_pdf:
            save_field_material(
                kind="drawing",
                part_no="PART-A",
                model_name="MODEL-A",
                revision="",
                source_file=SimpleUploadedFile("drawing.pdf", b"not a pdf"),
                preview_pdf=None,
                user=self.user,
            )
        with self.assertRaises(FieldKanbanError) as truncated_ppt:
            save_field_material(
                kind="work_instruction",
                part_no="PART-A",
                model_name="MODEL-A",
                revision="",
                source_file=SimpleUploadedFile(
                    "instruction.ppt",
                    bytes.fromhex("d0cf11e0a1b11ae1"),
                ),
                preview_pdf=None,
                user=self.user,
            )

        self.assertEqual(invalid_pptx.exception.code, "invalid_pptx")
        self.assertEqual(invalid_pdf.exception.code, "invalid_pdf")
        self.assertEqual(truncated_ppt.exception.code, "invalid_ppt")
        upload.assert_not_called()

    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_invalid_preview_is_rejected_before_source_upload(self, upload):
        with self.assertRaises(FieldKanbanError) as invalid_preview:
            save_field_material(
                kind="work_instruction",
                part_no="PART-A",
                model_name="MODEL-A",
                revision="",
                source_file=SimpleUploadedFile("slides.pptx", self._pptx_bytes()),
                preview_pdf=SimpleUploadedFile("preview.pdf", b"not a pdf"),
                user=self.user,
            )

        self.assertEqual(invalid_preview.exception.code, "invalid_pdf")
        upload.assert_not_called()

    @patch("production.field_kanban.cloudinary.uploader.destroy")
    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_manifest_failure_cleans_only_the_new_upload(self, upload, destroy):
        MouldDataSnapshot.objects.create(
            snapshot_key=FIELD_MATERIALS_SNAPSHOT_KEY,
            kind=MouldDataSnapshot.KIND_BOARD,
            instance_id="field-materials",
            payload={"schema_version": "unsupported", "documents": []},
        )
        upload.return_value = {
            "secure_url": "https://cdn.example.test/new.pdf",
            "public_id": "wj-field-materials/new",
            "resource_type": "image",
            "bytes": 12,
        }

        with self.assertRaises(FieldKanbanError) as invalid_manifest:
            save_field_material(
                kind="work_instruction",
                part_no="PART-A",
                model_name="MODEL-A",
                revision="A",
                source_file=SimpleUploadedFile("instruction.pdf", b"%PDF-1.4\n"),
                preview_pdf=None,
                user=self.user,
            )

        self.assertEqual(invalid_manifest.exception.code, "unsupported_material_manifest")
        destroy.assert_called_once_with(
            "wj-field-materials/new",
            resource_type="image",
            invalidate=True,
        )

    @patch("production.field_kanban.cloudinary.uploader.destroy")
    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_storage_response_without_url_cleans_the_new_upload(self, upload, destroy):
        upload.return_value = {
            "public_id": "wj-field-materials/no-url",
            "resource_type": "image",
            "bytes": 12,
        }

        with self.assertRaises(FieldKanbanError) as invalid_response:
            save_field_material(
                kind="work_instruction",
                part_no="PART-A",
                model_name="MODEL-A",
                revision="A",
                source_file=SimpleUploadedFile("instruction.pdf", b"%PDF-1.4\n"),
                preview_pdf=None,
                user=self.user,
            )

        self.assertEqual(invalid_response.exception.code, "document_storage_invalid_response")
        destroy.assert_called_once_with(
            "wj-field-materials/no-url",
            resource_type="image",
            invalidate=True,
        )

    @patch("production.field_kanban.cloudinary.uploader.destroy")
    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_upload_exception_cleans_client_generated_public_id(self, upload, destroy):
        upload.side_effect = TimeoutError("response timed out")

        with self.assertRaises(FieldKanbanError) as storage_error:
            save_field_material(
                kind="work_instruction",
                part_no="PART-A",
                model_name="MODEL-A",
                revision="A",
                source_file=SimpleUploadedFile("instruction.pdf", b"%PDF-1.4\n"),
                preview_pdf=None,
                user=self.user,
            )

        self.assertEqual(storage_error.exception.code, "document_storage_unavailable")
        destroy.assert_called_once()
        public_id = destroy.call_args.args[0]
        self.assertRegex(
            public_id,
            r"^wj-field-materials/work_instruction/\d{4}-\d{2}/[0-9a-f]{32}$",
        )
        self.assertEqual(
            destroy.call_args.kwargs,
            {"resource_type": "image", "invalidate": True},
        )
