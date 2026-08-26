from __future__ import annotations

from datetime import date, datetime, timedelta
from io import BytesIO
from unittest.mock import patch
import zipfile

import pytz
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from rest_framework.test import APIClient

from injection.models import InjectionMonitoringRecord, MouldDataSnapshot

from .field_kanban import (
    FIELD_DEFECTS_SCHEMA,
    FIELD_MATERIALS_SCHEMA,
    FIELD_MATERIALS_SNAPSHOT_KEY,
    FieldKanbanError,
    _defect_snapshot_key,
    _pending_shift_prompt,
    _quality_summary,
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
        "source": source,
        "preview": source if ready else None,
        "active": True,
        "uploaded_at": uploaded_at,
        "uploaded_by": "developer",
    }


class FieldKanbanSnapshotTests(TestCase):
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


class FieldQualitySummaryTests(TestCase):
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


class FieldMaterialResolutionTests(TestCase):
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

    def test_today_material_readiness_reports_complete_and_missing_models(self):
        target_date = date(2026, 8, 24)
        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type="injection",
            machine_name="850T-1",
            part_no="PART-READY",
            model_name="MODEL-READY",
            planned_quantity=100,
            sequence=1,
        )
        ProductionPlan.objects.create(
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
            "production.field_kanban.build_field_kanban_snapshot",
            return_value=self._kanban_payload(
                allocated_shots=10,
                business_day_shots=10,
            ),
        ) as build_snapshot:
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
        self.assertEqual(build_snapshot.call_count, 1)

        stored = MouldDataSnapshot.objects.get(
            snapshot_key="field-defects-v1-20260824-01"
        )
        self.assertEqual(len(stored.payload["checkpoints"]), 1)

    def test_defect_quantity_above_server_gross_is_rejected_without_append(self):
        with patch(
            "production.field_kanban.build_field_kanban_snapshot",
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
            "production.field_kanban.build_field_kanban_snapshot",
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
            "production.field_kanban.build_field_kanban_snapshot",
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
            "production.field_kanban.build_field_kanban_snapshot",
        ) as build_snapshot:
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
        build_snapshot.assert_not_called()

    def test_part_change_and_manual_event_keys_are_bound_to_date_and_machine(self):
        with patch(
            "production.field_kanban.build_field_kanban_snapshot",
        ) as build_snapshot:
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
        build_snapshot.assert_not_called()

    def test_valid_morning_shift_checkpoint_can_be_saved_after_rollover(self):
        with patch(
            "production.field_kanban.build_field_kanban_snapshot",
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

    def test_morning_prompt_survives_0800_rollover_until_prior_day_is_completed(self):
        previous_date = date(2026, 8, 24)
        current_date = date(2026, 8, 25)
        plan = ProductionPlan.objects.create(
            plan_date=previous_date,
            plan_type="injection",
            machine_name="850T-1",
            part_no="PART-PRIOR",
            model_name="MODEL-PRIOR",
            planned_quantity=100,
            sequence=0,
        )
        now = SHANGHAI_TZ.localize(datetime(2026, 8, 25, 8, 1))

        overdue = _pending_shift_prompt(current_date, 1, None, now=now)

        self.assertEqual(overdue["business_date"], previous_date.isoformat())
        self.assertEqual(overdue["event_key"], "defect:shift:2026-08-24:1:0800")
        self.assertEqual(overdue["trigger"], "shift_0800")
        self.assertTrue(overdue["is_overdue"])
        self.assertEqual(overdue["plan_id"], plan.pk)
        self.assertEqual(overdue["part_no"], "PART-PRIOR")

        MouldDataSnapshot.objects.create(
            snapshot_key=_defect_snapshot_key(previous_date, 1),
            kind=MouldDataSnapshot.KIND_BOARD,
            instance_id="field-defects-01",
            payload={
                "schema_version": FIELD_DEFECTS_SCHEMA,
                "business_date": previous_date.isoformat(),
                "machine_number": 1,
                "checkpoints": [{"event_key": overdue["event_key"]}],
            },
        )

        self.assertIsNone(_pending_shift_prompt(current_date, 1, None, now=now))


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
                    "file": SimpleUploadedFile("work.pdf", b"%PDF-1.4\n"),
                },
                format="multipart",
            )

        self.assertEqual(allowed_response.status_code, 201)
        self.assertTrue(save_material.called)

    def test_profile_missing_field_writes_fail_closed(self):
        user = get_user_model().objects.create_user(username="profile-missing")
        user.profile.delete()
        user = get_user_model().objects.get(pk=user.pk)
        client = self._client_for(user)

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
        self.user = get_user_model().objects.create_user(username="dev-editor")

    @staticmethod
    def _pptx_bytes() -> bytes:
        stream = BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types />")
            archive.writestr("ppt/presentation.xml", "<presentation />")
        return stream.getvalue()

    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_valid_pptx_upload_is_path_safe_and_not_ready_without_pdf_preview(self, upload):
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
        )

        self.assertEqual(document["source_format"], "pptx")
        self.assertEqual(document["source_file_name"], "slides.pptx")
        self.assertNotIn("..", document["source_file_name"])
        self.assertFalse(document["ready"])
        self.assertIsNone(document["preview_url"])
        self.assertEqual(upload.call_count, 1)
        self.assertEqual(upload.call_args.kwargs["resource_type"], "raw")
        self.assertFalse(upload.call_args.kwargs["overwrite"])

    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_legacy_ppt_upload_is_not_ready_without_pdf_preview(self, upload):
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
        self.assertEqual(upload.call_count, 1)

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
            "public_id": "wj-field-materials/new.pdf",
            "resource_type": "raw",
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
            "wj-field-materials/new.pdf",
            resource_type="raw",
            invalidate=True,
        )

    @patch("production.field_kanban.cloudinary.uploader.destroy")
    @patch("production.field_kanban.cloudinary.uploader.upload")
    def test_storage_response_without_url_cleans_the_new_upload(self, upload, destroy):
        upload.return_value = {
            "public_id": "wj-field-materials/no-url.pdf",
            "resource_type": "raw",
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
            "wj-field-materials/no-url.pdf",
            resource_type="raw",
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
            r"^wj-field-materials/work_instruction/\d{4}-\d{2}/[0-9a-f]{32}\.pdf$",
        )
        self.assertEqual(
            destroy.call_args.kwargs,
            {"resource_type": "raw", "invalidate": True},
        )
