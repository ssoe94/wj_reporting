import json
from copy import deepcopy
from datetime import datetime, timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from injection.models import InjectionMonitoringRecord
from quality.models import QualityReport

from .ai_metrics import SHANGHAI_TZ
from .overview_board import (
    _fetch_nanjing_weather,
    build_overview_board_snapshot,
    current_shanghai_business_date,
)


def _weather_result():
    weather = {
        "location": "Nanjing",
        "status": "ok",
        "is_stale": False,
        "temperature_c": 31.2,
        "relative_humidity_percent": 68.0,
        "wind_speed_mps": 2.4,
        "condition_code": "partly_cloudy",
        "symbol_code": "partlycloudy_day",
        "valid_at": "2026-08-10T04:00:00Z",
        "retrieved_at": "2026-08-10T04:00:00+00:00",
        "source": "MET Norway",
        "source_url": "https://api.met.no/weatherapi/locationforecast/2.0/compact",
        "attribution": "Weather data: MET Norway",
    }
    source = {
        "status": "ok",
        "source_latest_at": weather["valid_at"],
        "row_count": 1,
        "stale": False,
    }
    trace = {
        "source": "api.met.no Locationforecast 2.0 compact",
        "status": "mocked",
        "rows_returned": 1,
    }
    return weather, [], source, trace


def _outbound_result():
    payload = {
        "status": "ok",
        "fetched_at": "2026-08-10T12:00:00+08:00",
        "cache_status": "miss",
        "measurement_basis": {},
        "periods": {},
        "accepted_line_count": 0,
        "excluded_line_count": 0,
        "deduplicated_line_count": 0,
        "covered_order_count": 0,
        "exclusions_by_reason": {},
        "warnings": [],
    }
    source = {
        "status": "ok",
        "source_latest_at": payload["fetched_at"],
        "row_count": 0,
        "stale": False,
    }
    trace = {
        "source": "BLACKLAKE inventory outbound_order._list items[]",
        "status": "mocked",
        "rows_returned": 0,
    }
    return payload, [], source, trace


def _production_context(target_date, *, resolved=True):
    start = SHANGHAI_TZ.localize(datetime(2026, 8, 10, 8, 0))
    reference = start + timedelta(hours=4)
    part_status = "in_progress" if resolved else "completed"
    return {
        "business_date": target_date,
        "range_start": start,
        "range_end": start + timedelta(days=1),
        "reference_time": reference,
        "injection": {
            "planned_qty": 1000,
            "actual_qty": 250,
            "progress_rate": 25.0,
            "time_progress_rate": 16.7,
            "active_equipment_count": 1,
            "running_equipment_count": 1,
            "total_equipment_count": 17,
            "plan_row_count": 1,
            "monitoring_row_count": 10,
            "latest_mes_time": reference,
            "last_plan_updated_at": reference - timedelta(minutes=30),
            "machine_rows": [
                {
                    "machine_number": 3,
                    "machine": "1300T-3",
                    "machine_name": "3호기",
                    "planned_qty": 1000,
                    "actual_qty": 250,
                    "progress_rate": 25.0,
                    "gap_to_time_rate_pp": 8.3,
                    "is_running": True,
                    "recent_60m_shots": 42,
                    "parts": [
                        {
                            "part_no": " ABC 123 ",
                            "model_name": "MODEL-A",
                            "sequence": 1,
                            "status": part_status,
                            "production_group_id": "ABC123:1",
                            "production_group_complete": True,
                        }
                    ],
                }
            ],
            "part_rows": [],
        },
        "machining": {
            "planned_qty": 400,
            "actual_qty": 100,
            "progress_rate": 25.0,
            "time_progress_rate": 16.7,
            "active_equipment_count": 1,
            "running_equipment_count": 0,
            "total_equipment_count": 2,
            "plan_row_count": 1,
            "mes_row_count": 1,
            "latest_report_time": reference,
            "last_plan_updated_at": reference - timedelta(minutes=30),
            "rows": [
                {
                    "equipment_key": "LINE-1",
                    "equipment_label": "1라인",
                    "planned_qty": 400,
                    "actual_qty": 100,
                    "mes_qty": 80,
                    "manual_open_qty": 20,
                    "matched_manual_qty": 10,
                    "defect_qty": 3,
                    "status": "manual_partial",
                }
            ],
        },
    }


def _activity_context(target_date, *, machine_numbers=(3,), stale=False):
    start = SHANGHAI_TZ.localize(datetime(2026, 8, 10, 8, 0))
    reference = start + timedelta(hours=4)
    return {
        "business_date": target_date,
        "business_range_start": start,
        "business_range_end": start + timedelta(days=1),
        "window_start": reference - timedelta(minutes=60),
        "window_end": reference,
        "lookback_minutes": 60,
        "latest_mes_time": reference,
        "is_stale": stale,
        "rows": [
            {
                "machine_number": machine_number,
                "machine": f"M-{machine_number}",
                "machine_name": f"{machine_number}호기",
                "shot_count": 42,
            }
            for machine_number in machine_numbers
        ],
        "monitoring_row_count": len(machine_numbers) * 2,
    }


class OverviewBoardQualityContractTests(TestCase):
    def setUp(self):
        self.target_date = datetime(2026, 8, 10).date()
        self.reference = SHANGHAI_TZ.localize(datetime(2026, 8, 10, 12, 0))
        weather_patcher = patch(
            "production.overview_board._build_weather",
            return_value=_weather_result(),
        )
        weather_patcher.start()
        self.addCleanup(weather_patcher.stop)
        outbound_patcher = patch(
            "production.overview_board.get_outbound_performance",
            return_value=_outbound_result(),
        )
        outbound_patcher.start()
        self.addCleanup(outbound_patcher.stop)

    def test_quality_feed_uses_exact_full_part_and_90_day_history_only(self):
        QualityReport.objects.create(
            report_dt=self.reference - timedelta(days=10),
            section="LQC_INJ",
            model="MODEL-A",
            part_no="ABC123",
            judgement="NG",
            defect_rate="99.9%",
            phenomenon="플래시",
            disposition="파팅면 확인",
        )
        QualityReport.objects.create(
            report_dt=self.reference - timedelta(days=5),
            section="LQC_INJ",
            model="MODEL-A",
            part_no="ABC123-X",
            judgement="NG",
            phenomenon="접두사만 같은 품번",
        )
        QualityReport.objects.create(
            report_dt=self.reference - timedelta(days=91),
            section="LQC_INJ",
            model="MODEL-A",
            part_no="ABC123",
            judgement="NG",
            phenomenon="90일 이전 이력",
        )

        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=_production_context(self.target_date),
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        self.assertEqual(snapshot["quality"]["resolved_machine_count"], 1)
        part = snapshot["quality"]["items"][0]["parts"][0]
        self.assertEqual(part["match_type"], "exact_normalized_full_part_no")
        self.assertEqual(part["historical_report_count"], 1)
        self.assertEqual(part["top_phenomena"], [{"phenomenon": "플래시", "report_count": 1}])
        self.assertNotIn("defect_rate", json.dumps(snapshot["quality"], ensure_ascii=False))
        self.assertIn("현재 불량 발생을 의미하지 않습니다", snapshot["quality"]["disclaimer"])

    def test_active_machine_without_in_progress_allocation_is_not_guessed(self):
        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=_production_context(self.target_date, resolved=False),
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        self.assertEqual(snapshot["quality"]["items"], [])
        self.assertEqual(snapshot["quality"]["unresolved_machines"][0]["machine_number"], 3)
        self.assertIn("quality_current_part_unresolved:3", snapshot["warnings"])

    def test_quality_summary_counts_shared_source_report_once(self):
        QualityReport.objects.create(
            report_dt=self.reference - timedelta(days=10),
            section="LQC_INJ",
            model="MODEL-A",
            part_no="ABC123",
            judgement="NG",
            phenomenon="플래시",
        )
        context = _production_context(self.target_date)
        second_machine = deepcopy(context["injection"]["machine_rows"][0])
        second_machine.update({
            "machine_number": 8,
            "machine": "850T-8",
            "machine_name": "8호기",
        })
        context["injection"]["machine_rows"].append(second_machine)

        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=context,
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        self.assertEqual(len(snapshot["quality"]["items"]), 2)
        self.assertEqual(snapshot["quality"]["matched_historical_report_count"], 1)
        self.assertTrue(all(item["historical_report_count"] == 1 for item in snapshot["quality"]["items"]))

    def test_legacy_machining_source_has_assembly_conveyor_display_semantics(self):
        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=_production_context(self.target_date),
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="zh")

        assembly = snapshot["processes"]["assembly"]
        self.assertEqual(assembly["source_process"], "machining")
        self.assertEqual(assembly["display_semantics"], "assembly_conveyor")
        self.assertEqual(assembly["title"], "组装生产")
        self.assertEqual(assembly["forecast_completion_rate"], 149.7)

    def test_energy_counter_delta_preserves_decimal_kwh(self):
        start = SHANGHAI_TZ.localize(datetime(2026, 8, 10, 8, 0))
        for offset, value in [(-1, 100.0), (10, 100.75), (20, 102.5)]:
            InjectionMonitoringRecord.objects.create(
                machine_name="3호기",
                device_code="energy-machine-3",
                timestamp=start + timedelta(minutes=offset),
                power_kwh=value,
            )

        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=_production_context(self.target_date),
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        self.assertEqual(snapshot["energy"]["usage_kwh"], 2.5)

    def test_energy_counter_ignores_negative_missing_sentinel(self):
        start = SHANGHAI_TZ.localize(datetime(2026, 8, 10, 8, 0))
        for offset, value in [(-1, 100.0), (10, -1.0), (70, 101.25)]:
            InjectionMonitoringRecord.objects.create(
                machine_name="3호기",
                device_code="energy-machine-3",
                timestamp=start + timedelta(minutes=offset),
                power_kwh=value,
            )

        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=_production_context(self.target_date),
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        self.assertEqual(snapshot["energy"]["usage_kwh"], 1.25)
        self.assertLess(max(
            point["usage_kwh"] or 0
            for point in snapshot["energy"]["hourly_trend"]
        ), 10)

    def test_energy_trend_and_efficiency_use_paired_hourly_counters(self):
        reference = SHANGHAI_TZ.localize(datetime(2026, 8, 10, 12, 0))
        first_sample = reference - timedelta(hours=49) + timedelta(minutes=10)
        for index in range(49):
            InjectionMonitoringRecord.objects.create(
                machine_name="3호기",
                device_code="energy-trend-machine-3",
                timestamp=first_sample + timedelta(hours=index),
                power_kwh=100 + index * 10,
                capacity=1000 + index * 100,
            )

        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=_production_context(self.target_date),
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        energy = snapshot["energy"]
        self.assertEqual(energy["usage_kwh"], 40.0)
        self.assertEqual(energy["total_shots"], 400)
        self.assertEqual(energy["energy_per_1000_shots_kwh"], 100.0)
        self.assertEqual(energy["efficiency_metered_machine_count"], 1)
        self.assertEqual(len(energy["hourly_trend"]), 24)
        self.assertTrue(all(point["usage_kwh"] == 10.0 for point in energy["hourly_trend"]))
        self.assertTrue(all(point["ma_8h_kwh"] == 10.0 for point in energy["hourly_trend"]))
        self.assertTrue(all(point["ma_12h_kwh"] == 10.0 for point in energy["hourly_trend"]))
        self.assertTrue(all(point["ma_24h_kwh"] == 10.0 for point in energy["hourly_trend"]))

    def test_attention_threshold_is_strictly_more_than_five_points_behind(self):
        at_threshold = _production_context(self.target_date)
        at_threshold["injection"]["machine_rows"][0]["gap_to_time_rate_pp"] = -5.0
        behind = deepcopy(at_threshold)
        behind["injection"]["machine_rows"][0]["gap_to_time_rate_pp"] = -5.1

        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=at_threshold,
        ):
            threshold_snapshot = build_overview_board_snapshot(self.target_date, language="ko")
        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=behind,
        ):
            behind_snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        self.assertFalse(any(item["process"] == "injection" for item in threshold_snapshot["attention"]))
        self.assertTrue(any(item["process"] == "injection" for item in behind_snapshot["attention"]))

    def test_business_date_rolls_over_at_shanghai_0800(self):
        before_start = SHANGHAI_TZ.localize(datetime(2026, 8, 10, 7, 59))
        at_start = SHANGHAI_TZ.localize(datetime(2026, 8, 10, 8, 0))

        self.assertEqual(current_shanghai_business_date(before_start), datetime(2026, 8, 9).date())
        self.assertEqual(current_shanghai_business_date(at_start), datetime(2026, 8, 10).date())

    def test_process_contract_compares_completion_with_elapsed_time(self):
        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=_production_context(self.target_date),
        ), patch(
            "production.overview_board.get_injection_active_machine_context",
            return_value=_activity_context(self.target_date),
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        injection = snapshot["processes"]["injection"]
        self.assertEqual(injection["completion_rate"], 25.0)
        self.assertEqual(injection["time_progress_rate"], 16.7)
        self.assertEqual(injection["completion_vs_time_gap_pp"], 8.3)
        self.assertEqual(injection["expected_qty_by_time"], 167)
        self.assertEqual(injection["gap_to_time_qty"], 83)
        self.assertEqual(injection["pace_index_percent"], 149.7)
        self.assertEqual(injection["pace_status"], "ahead")
        self.assertEqual(injection["remaining_qty"], 750)
        self.assertEqual(injection["remaining_business_minutes"], 1200)
        self.assertEqual(injection["required_qty_per_hour"], 37.5)

        assembly = snapshot["processes"]["assembly"]
        self.assertEqual(assembly["completion_vs_time_gap_pp"], 8.3)
        self.assertEqual(assembly["expected_qty_by_time"], 67)
        self.assertEqual(assembly["gap_to_time_qty"], 33)
        self.assertEqual(assembly["required_qty_per_hour"], 15.0)
        self.assertEqual(assembly["reporting_mix"]["mes_confirmed_qty"], 80)
        self.assertEqual(assembly["reporting_mix"]["manual_open_qty"], 20)
        self.assertEqual(assembly["reporting_mix"]["manual_open_share_percent"], 20.0)
        self.assertEqual(assembly["reporting_mix"]["reported_defect_qty"], 3)
        self.assertEqual(assembly["reporting_mix"]["status_counts"], {"manual_partial": 1})
        self.assertIn("awaiting MES reconciliation", assembly["calculation_basis"])

    def test_injection_equipment_summary_uses_all_machine_activity_and_keeps_oee_nullable(self):
        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=_production_context(self.target_date),
        ), patch(
            "production.overview_board.get_injection_active_machine_context",
            return_value=_activity_context(self.target_date, machine_numbers=(3, 8)),
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        summary = snapshot["equipment"]["injection_summary"]
        self.assertEqual(summary["total_equipment_count"], 17)
        self.assertEqual(summary["planned_equipment_count"], 1)
        self.assertEqual(summary["running_equipment_count"], 2)
        self.assertEqual(summary["scheduled_running_equipment_count"], 1)
        self.assertEqual(summary["unplanned_active_equipment_count"], 1)
        self.assertEqual(summary["operating_rate_percent"], 11.8)
        self.assertEqual(summary["scheduled_operating_rate_percent"], 100.0)
        self.assertEqual(summary["pace_counts"]["ahead"], 1)
        self.assertEqual(summary["bottleneck_machine"]["machine_number"], 3)

        oee = summary["oee"]
        self.assertIsNone(oee["value_percent"])
        self.assertEqual(oee["status"], "not_calculable_missing_verified_factors")
        self.assertEqual(oee["available_factor_count"], 0)
        self.assertEqual(oee["factors"]["availability"]["status"], "proxy_only")
        self.assertEqual(oee["factors"]["availability"]["proxy_value_percent"], 11.8)
        self.assertEqual(oee["factors"]["quality"]["status"], "unavailable")
        self.assertIn("historical quality reports are excluded", oee["factors"]["quality"]["reason"])

    def test_injection_machine_feed_includes_resolved_product_and_active_machine_without_plan(self):
        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=_production_context(self.target_date),
        ), patch(
            "production.overview_board.get_injection_active_machine_context",
            return_value=_activity_context(self.target_date, machine_numbers=(3, 8)),
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        machines = snapshot["equipment"]["injection"]
        self.assertEqual([row["machine_number"] for row in machines], [3, 8])

        resolved = machines[0]
        self.assertEqual(resolved["production_state"], "running_resolved")
        self.assertEqual(resolved["current_part_resolution"]["status"], "resolved")
        self.assertEqual(resolved["current_parts"], [{"part_no": "ABC 123", "model_name": "MODEL-A"}])
        self.assertEqual(resolved["planned_qty"], 1000)
        self.assertEqual(resolved["actual_qty"], 250)
        self.assertEqual(resolved["completion_rate"], 25.0)
        self.assertEqual(resolved["time_progress_rate"], 16.7)
        self.assertEqual(resolved["gap_to_time_rate_pp"], 8.3)
        self.assertEqual(resolved["source_status"], "ok")
        self.assertEqual(resolved["activity_window_minutes"], 60)

        unplanned = machines[1]
        self.assertEqual(unplanned["machine_name"], "M-8")
        self.assertEqual(unplanned["monitoring_name"], "8호기")
        self.assertFalse(unplanned["has_plan"])
        self.assertTrue(unplanned["is_running"])
        self.assertEqual(unplanned["production_state"], "running_without_plan")
        self.assertEqual(unplanned["current_part_resolution"]["status"], "unresolved")
        self.assertEqual(
            unplanned["current_part_resolution"]["reason"],
            "production_plan_missing_for_recently_active_machine",
        )
        self.assertEqual(unplanned["current_parts"], [])
        self.assertEqual(unplanned["recent_60m_shots"], 42)
        self.assertEqual(unplanned["recent_60m_avg_ct_sec"], 85.7)
        # Shots are not silently converted to pieces without a resolved cavity.
        self.assertEqual(unplanned["actual_qty"], 0)

    def test_injection_machine_feed_never_guesses_completed_plan_as_current(self):
        running_unresolved = _production_context(self.target_date, resolved=False)
        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=running_unresolved,
        ), patch(
            "production.overview_board.get_injection_active_machine_context",
            return_value=_activity_context(self.target_date),
        ):
            running_snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        running = running_snapshot["equipment"]["injection"][0]
        self.assertEqual(running["production_state"], "running_part_unresolved")
        self.assertEqual(running["current_part_resolution"]["status"], "unresolved")
        self.assertEqual(running["current_parts"], [])

        stopped_context = _production_context(self.target_date, resolved=False)
        stopped_context["injection"]["machine_rows"][0].update({
            "is_running": False,
            "recent_60m_shots": 0,
            "recent_60m_avg_ct_sec": None,
        })
        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=stopped_context,
        ), patch(
            "production.overview_board.get_injection_active_machine_context",
            return_value=_activity_context(self.target_date, machine_numbers=()),
        ):
            stopped_snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        stopped = stopped_snapshot["equipment"]["injection"][0]
        self.assertEqual(stopped["production_state"], "planned_stopped")
        self.assertEqual(stopped["current_part_resolution"]["status"], "not_applicable")
        self.assertEqual(stopped["current_parts"], [])

    def test_injection_machine_feed_keeps_in_progress_model_without_recent_activity(self):
        context = _production_context(self.target_date)
        context["injection"]["machine_rows"][0].update({
            "is_running": False,
            "recent_60m_shots": 0,
            "recent_60m_avg_ct_sec": None,
        })
        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=context,
        ), patch(
            "production.overview_board.get_injection_active_machine_context",
            return_value=_activity_context(self.target_date, machine_numbers=()),
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        stopped = snapshot["equipment"]["injection"][0]
        self.assertEqual(stopped["production_state"], "planned_stopped")
        self.assertFalse(stopped["is_running"])
        self.assertEqual(stopped["current_parts"], [{"part_no": "ABC 123", "model_name": "MODEL-A"}])
        self.assertEqual(stopped["current_part_resolution"]["status"], "resolved")
        self.assertEqual(
            stopped["current_part_resolution"]["method"],
            "in_progress_plan_sequence_cavity_allocation",
        )

    def test_injection_machine_feed_uses_in_progress_model_when_part_number_is_missing(self):
        context = _production_context(self.target_date)
        part = context["injection"]["machine_rows"][0]["parts"][0]
        part.update({
            "part_no": "-",
            "model_name": "汽车外部行李箱",
        })
        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=context,
        ), patch(
            "production.overview_board.get_injection_active_machine_context",
            return_value=_activity_context(self.target_date),
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        machine = snapshot["equipment"]["injection"][0]
        self.assertEqual(machine["production_state"], "running_resolved")
        self.assertEqual(machine["current_parts"], [{"part_no": "-", "model_name": "汽车外部行李箱"}])
        # Quality matching remains fail-closed without an exact part number.
        self.assertEqual(snapshot["quality"]["resolved_machine_count"], 0)
        self.assertIn("quality_current_part_unresolved:3", snapshot["warnings"])

    def test_injection_machine_feed_uses_first_pending_plan_group_for_display_only(self):
        context = _production_context(self.target_date)
        first = context["injection"]["machine_rows"][0]["parts"][0]
        first.update({
            "status": "pending",
            "sequence": 1,
            "part_no": "NEXT-001",
            "model_name": "NEXT-MODEL",
            "production_group_id": "NEXT:1",
        })
        context["injection"]["machine_rows"][0]["parts"].append({
            "status": "pending",
            "sequence": 2,
            "part_no": "LATER-002",
            "model_name": "LATER-MODEL",
            "production_group_id": "LATER:2",
        })
        context["injection"]["machine_rows"][0].update({
            "actual_qty": 0,
            "progress_rate": 0,
            "is_running": False,
            "recent_60m_shots": 0,
        })
        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=context,
        ), patch(
            "production.overview_board.get_injection_active_machine_context",
            return_value=_activity_context(self.target_date, machine_numbers=()),
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        machine = snapshot["equipment"]["injection"][0]
        self.assertEqual(machine["production_state"], "planned_waiting")
        self.assertEqual(machine["current_parts"], [{"part_no": "NEXT-001", "model_name": "NEXT-MODEL"}])
        self.assertEqual(machine["current_part_resolution"]["status"], "planned")
        self.assertEqual(
            machine["current_part_resolution"]["method"],
            "first_pending_plan_group_same_as_injection_board",
        )
        # Pending plan display candidates must never enter historical quality matching.
        self.assertEqual(snapshot["quality"]["items"], [])

    def test_oee_is_calculated_only_when_all_three_factors_are_explicitly_source_backed(self):
        context = _production_context(self.target_date)
        context["injection"]["oee_factors"] = {
            "availability": {
                "value_percent": 80,
                "source_backed": True,
                "source": "verified-runtime-source",
            },
            "performance": {
                "value_percent": 90,
                "source_backed": True,
                "source": "verified-cycle-source",
            },
            "quality": {
                "value_percent": 95,
                "source_backed": True,
                "source": "verified-current-yield-source",
            },
        }
        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=context,
        ), patch(
            "production.overview_board.get_injection_active_machine_context",
            return_value=_activity_context(self.target_date),
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        oee = snapshot["equipment"]["injection_summary"]["oee"]
        self.assertEqual(oee["value_percent"], 68.4)
        self.assertEqual(oee["status"], "calculated_verified_factors")
        self.assertEqual(oee["available_factor_count"], 3)
        self.assertTrue(all(factor["status"] == "verified" for factor in oee["factors"].values()))

    def test_stale_activity_source_does_not_publish_zero_as_operating_rate(self):
        with patch(
            "production.overview_board.get_daily_production_context",
            return_value=_production_context(self.target_date),
        ), patch(
            "production.overview_board.get_injection_active_machine_context",
            return_value=_activity_context(self.target_date, machine_numbers=(), stale=True),
        ):
            snapshot = build_overview_board_snapshot(self.target_date, language="ko")

        summary = snapshot["equipment"]["injection_summary"]
        self.assertFalse(summary["activity_metrics_available"])
        self.assertIsNone(summary["operating_rate_percent"])
        self.assertIsNone(summary["scheduled_operating_rate_percent"])
        self.assertEqual(summary["oee"]["factors"]["availability"]["status"], "unavailable")


class OverviewBoardWeatherTests(TestCase):
    def test_met_norway_payload_is_normalized_for_nanjing_header(self):
        payload = {
            "properties": {
                "timeseries": [
                    {
                        "time": "2026-08-10T04:00:00Z",
                        "data": {
                            "instant": {
                                "details": {
                                    "air_temperature": 31.2,
                                    "relative_humidity": 68.0,
                                    "wind_speed": 2.4,
                                }
                            },
                            "next_1_hours": {
                                "summary": {"symbol_code": "partlycloudy_day"}
                            },
                        },
                    }
                ]
            }
        }

        class FakeResponse:
            headers = {
                "Expires": "Mon, 10 Aug 2026 04:30:00 GMT",
                "Content-Encoding": "identity",
            }

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps(payload).encode("utf-8")

        now = datetime.fromisoformat("2026-08-10T04:05:00+00:00")
        with patch("production.overview_board.timezone.now", return_value=now), patch(
            "production.overview_board.urlopen",
            return_value=FakeResponse(),
        ) as mocked_open:
            weather, cache_seconds = _fetch_nanjing_weather()

        request = mocked_open.call_args.args[0]
        self.assertIn("wj-reporting.onrender.com", request.get_header("User-agent"))
        self.assertIn("lat=32.0603", request.full_url)
        self.assertEqual(weather["condition_code"], "partly_cloudy")
        self.assertEqual(weather["temperature_c"], 31.2)
        self.assertEqual(weather["relative_humidity_percent"], 68.0)
        self.assertEqual(weather["wind_speed_mps"], 2.4)
        self.assertEqual(cache_seconds, 25 * 60)


class OverviewBoardEndpointTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = get_user_model().objects.create_user(
            username="overview-viewer",
            password="test-password",
        )

    def test_endpoint_is_public_read_only(self):
        payload = {
            "schema_version": "overview-board.v1",
            "language": "ko",
            "business_date": "2026-08-10",
        }
        with patch("production.views.build_overview_board_snapshot", return_value=payload):
            response = self.client.get(
                "/api/production/overview-board/",
                {"date": "2026-08-10"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), payload)
        self.assertIn("no-store", response["Cache-Control"])

    def test_endpoint_validates_date_and_passes_language(self):
        self.client.force_authenticate(self.user)
        invalid = self.client.get("/api/production/overview-board/", {"date": "2026-99-99"})
        self.assertEqual(invalid.status_code, 400)

        payload = {
            "schema_version": "overview-board.v1",
            "language": "zh",
            "business_date": "2026-08-10",
        }
        with patch("production.views.build_overview_board_snapshot", return_value=payload) as build:
            response = self.client.get(
                "/api/production/overview-board/",
                {"date": "2026-08-10", "lang": "zh"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), payload)
        self.assertIn("no-store", response["Cache-Control"])
        build.assert_called_once_with(datetime(2026, 8, 10).date(), language="zh")
