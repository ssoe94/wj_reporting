import ast
import os
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from config import heavy_request_log


class PeriodicEnqueueStageLogTests(TestCase):
    def run_stages(self):
        recorder = heavy_request_log.PeriodicEnqueueStageLog()
        for stage in recorder._STAGES:
            recorder.record(stage)
        recorder.finish()
        recorder.finish()

    def test_thresholds_and_fixed_stage_fields(self):
        for elapsed, before, after in ((1.0, None, None), (0.5, 100, 116)):
            with (
                self.subTest(elapsed=elapsed, before=before, after=after),
                patch.object(heavy_request_log, "perf_counter", side_effect=[0, 0.1, 0.2, 0.3, 0.4, elapsed]),
                patch.object(heavy_request_log, "read_rss_mib", side_effect=[before, 101, 102, 103, 104, after]),
                self.assertLogs("gunicorn.error") as logs,
            ):
                self.run_stages()
            self.assertEqual(len(logs.output), 1)
            self.assertIn("ai_periodic_enqueue_stages", logs.output[0])
            for stage in heavy_request_log.PeriodicEnqueueStageLog._STAGES:
                self.assertIn(f"{stage}_elapsed_ms=", logs.output[0])
                self.assertIn(f"{stage}_rss_mib=", logs.output[0])
            self.assertIn("hourly_elapsed_ms=100.0 hourly_rss_mib=101.00", logs.output[0])

    def test_fast_low_rss_change_is_quiet(self):
        with (
            patch.object(heavy_request_log, "perf_counter", side_effect=[0, 0.1, 0.2, 0.3, 0.4, 0.999]),
            patch.object(heavy_request_log, "read_rss_mib", side_effect=[100, 101, 102, 103, 104, 115.999]),
            self.assertNoLogs("gunicorn.error"),
        ):
            self.run_stages()

    def test_measurement_and_log_failures_are_ignored(self):
        for name in ("perf_counter", "read_rss_mib"):
            for failed_at in range(6):
                values = list(range(6))
                values[failed_at] = RuntimeError("SYNTHETIC-measurement-failure")
                with self.subTest(name=name, failed_at=failed_at), patch.object(heavy_request_log, name, side_effect=values):
                    self.run_stages()
        with (
            patch.object(heavy_request_log, "perf_counter", side_effect=range(6)),
            patch.object(heavy_request_log, "read_rss_mib", return_value=None),
            patch.object(heavy_request_log._LOG, "info", side_effect=RuntimeError("SYNTHETIC-log-failure")),
        ):
            self.run_stages()

    def test_incomplete_or_unknown_stage_sequence_is_quiet(self):
        with (
            patch.object(heavy_request_log, "perf_counter", side_effect=range(6)),
            patch.object(heavy_request_log, "read_rss_mib", return_value=400),
            self.assertNoLogs("gunicorn.error"),
        ):
            recorder = heavy_request_log.PeriodicEnqueueStageLog()
            recorder.record("SYNTHETIC-sensitive-label")
            recorder.finish()


class PeriodicAuditSettingTests(TestCase):
    def test_effective_environment_assignment_without_loading_project_settings(self):
        # Evaluate only the owning assignment, avoiding settings imports and .env reads.
        source = Path(__file__).with_name("settings.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        assignment = next(
            node for node in tree.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "QUALITY_AUDIT_PERIODIC_SCAN_ENABLED" for target in node.targets)
        )
        code = compile(ast.Module(body=[assignment], type_ignores=[]), "settings.py", "exec")
        for value, expected in ((None, True), ("", True), ("0", False), (" FALSE ", False), ("Off", False),
                                ("1", True), ("true", True), ("on", True), ("no", True), ("unexpected", True)):
            with self.subTest(value=value), patch.dict(os.environ, {}, clear=True):
                if value is not None:
                    os.environ["QUALITY_AUDIT_PERIODIC_SCAN_ENABLED"] = value
                namespace = {"os": os}
                exec(code, namespace)
                self.assertIs(namespace["QUALITY_AUDIT_PERIODIC_SCAN_ENABLED"], expected)
