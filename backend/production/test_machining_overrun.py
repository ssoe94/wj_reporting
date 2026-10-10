from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from django.test import TestCase

from .machining_reconciliation import build_machining_provision_payload
from .models import (
    MachiningManualReport,
    MachiningManualReportMatch,
    ProductionMesReportRecord,
    ProductionPlan,
)


class MachiningOverrunTests(TestCase):
    business_date = date(2026, 10, 8)
    part_no = "ABJ76756112"

    def create_plan(self, *, quantity, machine="A LINE", day_offset=0, sequence=1, lot_no=None):
        return ProductionPlan.objects.create(
            plan_date=self.business_date + timedelta(days=day_offset),
            plan_type="machining",
            machine_name=machine,
            part_no=self.part_no,
            planned_quantity=quantity,
            sequence=sequence,
            lot_no=lot_no,
        )

    def create_mes_report(self, *, quantity, detail_id=1, equipment="B"):
        return ProductionMesReportRecord.objects.create(
            report_record_detail_id=detail_id,
            business_date=self.business_date,
            plan_type="machining",
            process_code="JG",
            report_time=datetime(2026, 10, 8, 16, 28, 34, tzinfo=ZoneInfo("Asia/Shanghai")),
            equipment_name=f"{equipment} LINE",
            equipment_key=equipment,
            part_no=self.part_no,
            report_qty=quantity,
        )

    def assert_conserved_mes(self, payload, quantity):
        self.assertEqual(payload["summary"]["mes_qty"], quantity)
        self.assertEqual(sum(row["mes_qty"] for row in payload["rows"]), quantity)
        self.assertEqual(payload["summary"]["effective_actual_qty"], quantity)

    def test_overrun_stays_on_first_plan_without_crediting_other_lines_or_future_plans(self):
        current_plan = self.create_plan(quantity=535)
        other_line_plan = self.create_plan(quantity=107, machine="B LINE")
        future_plan = self.create_plan(quantity=200, day_offset=1)
        self.create_mes_report(quantity=556)

        payload = build_machining_provision_payload(self.business_date, days=2)
        rows = {row["plan_id"]: row for row in payload["rows"]}

        self.assertEqual(rows[current_plan.id]["mes_qty"], 556)
        self.assertEqual(rows[current_plan.id]["effective_actual_qty"], 556)
        self.assertEqual(rows[current_plan.id]["gap_qty"], 21)
        self.assertEqual(rows[current_plan.id]["achievement_rate"], 103.9)
        self.assertEqual(rows[other_line_plan.id]["effective_actual_qty"], 0)
        self.assertEqual(rows[future_plan.id]["effective_actual_qty"], 0)
        self.assertEqual(payload["summary"]["advance_qty"], 0)
        self.assert_conserved_mes(payload, 556)

    def test_independent_reports_sum_by_part_and_follow_plan_order_regardless_of_mes_line(self):
        # Create out of plan order, including a sequence tie resolved by ID.
        later_line = self.create_plan(quantity=50, machine="B LINE")
        later_sequence = self.create_plan(quantity=50, sequence=2)
        first_plan = self.create_plan(quantity=50, lot_no="FIRST")
        same_sequence_later_id = self.create_plan(quantity=50, lot_no="SECOND")
        self.create_mes_report(quantity=60, detail_id=1, equipment="B")
        self.create_mes_report(quantity=57, detail_id=2, equipment="D")

        payload = build_machining_provision_payload(self.business_date, days=1)
        rows = {row["plan_id"]: row for row in payload["rows"]}

        self.assertEqual(rows[first_plan.id]["mes_qty"], 117)
        self.assertEqual(rows[first_plan.id]["gap_qty"], 67)
        for plan in (later_line, later_sequence, same_sequence_later_id):
            self.assertEqual(rows[plan.id]["mes_qty"], 0)
        self.assert_conserved_mes(payload, 117)

    def test_future_only_plan_receives_full_quantity_once_as_advance(self):
        later_plan = self.create_plan(quantity=100, day_offset=2)
        first_future_plan = self.create_plan(quantity=50, day_offset=1)
        self.create_mes_report(quantity=184)

        payload = build_machining_provision_payload(self.business_date, days=3)
        rows = {row["plan_id"]: row for row in payload["rows"]}

        self.assertEqual(rows[first_future_plan.id]["mes_qty"], 184)
        self.assertEqual(rows[first_future_plan.id]["gap_qty"], 134)
        self.assertEqual(rows[later_plan.id]["mes_qty"], 0)
        self.assertEqual(payload["summary"]["advance_qty"], 184)
        self.assert_conserved_mes(payload, 184)

    def test_missing_plan_preserves_full_mes_quantity_as_unplanned(self):
        self.create_mes_report(quantity=556)

        payload = build_machining_provision_payload(self.business_date, days=1)

        self.assertEqual(len(payload["rows"]), 1)
        row = payload["rows"][0]
        self.assertIsNone(row["plan_id"])
        self.assertEqual(row["status"], "unplanned_mes")
        self.assertEqual(row["planned_qty"], 0)
        self.assertEqual(row["mes_qty"], 556)
        self.assertEqual(payload["summary"]["advance_qty"], 0)
        self.assert_conserved_mes(payload, 556)

    def test_blank_mes_material_does_not_credit_model_only_plan(self):
        self.part_no = ""
        plan = self.create_plan(quantity=400)
        plan.model_name = "汽车外部行李箱"
        plan.save(update_fields=["model_name"])
        record = self.create_mes_report(quantity=17)
        record.material_name = plan.model_name
        record.save(update_fields=["material_name"])

        payload = build_machining_provision_payload(self.business_date, days=1)

        self.assertEqual(len(payload["rows"]), 2)
        plan_row = next(row for row in payload["rows"] if row["plan_id"] == plan.id)
        self.assertEqual(plan_row["part_no"], "")
        self.assertEqual(plan_row["model_name"], plan.model_name)
        self.assertEqual(plan_row["planned_qty"], 400)
        self.assertEqual(plan_row["direct_mes_qty"], 0)
        self.assertEqual(plan_row["mes_qty"], 0)
        self.assertEqual(plan_row["effective_actual_qty"], 0)
        unplanned_row = next(row for row in payload["rows"] if row["status"] == "unplanned_mes")
        self.assertIsNone(unplanned_row["plan_id"])
        self.assertEqual(unplanned_row["part_no"], "")
        self.assertEqual(unplanned_row["mes_qty"], 17)
        self.assertEqual(unplanned_row["effective_actual_qty"], 17)
        self.assertEqual(payload["summary"]["total_planned"], 400)
        self.assert_conserved_mes(payload, 17)

    def test_matched_manual_quantity_is_counted_once_with_uncapped_remaining_mes(self):
        plan = self.create_plan(quantity=535)
        self.create_plan(quantity=107, machine="B LINE")
        record = self.create_mes_report(quantity=556)
        manual = MachiningManualReport.objects.create(
            business_date=self.business_date,
            plan_date=plan.plan_date,
            plan=plan,
            plan_identity_hash="",
            machine_name=plan.machine_name,
            equipment_key="A",
            part_no=plan.part_no,
            sequence=plan.sequence,
            planned_qty_at_report=535,
            good_qty=100,
            total_reported_qty=100,
            credit_business_date=self.business_date,
            status="matched",
        )
        MachiningManualReportMatch.objects.create(
            manual_report=manual,
            mes_report_record=record,
            matched_qty=100,
            match_confidence="exact",
        )

        payload = build_machining_provision_payload(self.business_date, days=1)
        row = next(row for row in payload["rows"] if row["plan_id"] == plan.id)

        self.assertEqual(row["direct_mes_qty"], 456)
        self.assertEqual(row["matched_manual_qty"], 100)
        self.assertEqual(row["manual_open_qty"], 0)
        self.assertEqual(row["mes_qty"], 556)
        self.assertEqual(row["gap_qty"], 21)
        self.assertEqual(payload["summary"]["manual_matched_qty"], 100)
        self.assert_conserved_mes(payload, 556)
