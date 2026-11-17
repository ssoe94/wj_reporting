"""Loading bounds, periodic switch and fail-open metrics for audit scans."""
from datetime import datetime, timedelta, timezone as datetime_timezone
from unittest.mock import patch

from django.core.cache import cache
from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext

from ai_core.models import AiJob
from ai_core.quality_report_audit import QUALITY_REPORT_AUDIT_MODE, QUALITY_REPORT_AUDIT_TRIGGER
from quality import classification_audit as audit
from quality.models import QualityReport


class QualityAuditScanLoadingTests(TestCase):
    def setUp(self):
        cache.clear()
        # Epoch-minute remainder 1 for the two-page log threshold fixture.
        self.now = datetime(2026, 11, 18, 8, 1, tzinfo=datetime_timezone.utc)
        self.fixed_time = patch("quality.classification_audit.timezone.now", return_value=self.now)
        self.fixed_time.start()
        self.addCleanup(self.fixed_time.stop)

    def report(self):
        return QualityReport.objects.create(
            report_dt=self.now, section="SYNTHETIC-INJ",
            model="SYNTHETIC-model", part_no="SYNTHETIC-part",
            phenomenon="SYNTHETIC surface", action_result="SYNTHETIC action",
        )

    def job(self, report):
        payload, revision = audit.build_quality_report_audit_input(report)
        return AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE, status=AiJob.STATUS_COMPLETED,
            scope={"report_id": report.pk, "source_revision": revision,
                   "mode": QUALITY_REPORT_AUDIT_MODE, "trigger": QUALITY_REPORT_AUDIT_TRIGGER},
            input_payload=payload, result_payload={"available": True},
        )

    @override_settings(QUALITY_AUDIT_PERIODIC_SCAN_ENABLED=False)
    def test_disabled_periodic_has_no_database_queries(self):
        with self.assertNumQueries(0):
            value = audit.enqueue_stale_quality_report_audits(bounded_scan=True)
        self.assertEqual(value, {
            "created_count": 0, "created_job_ids": [], "examined_count": 0,
            "total_report_count": None, "eligible_count": 0, "remaining_count": 0,
            "skipped_reason": "periodic_scan_disabled", "backlog_count": 0,
            "backlog_limit": 10,
        })

    @override_settings(QUALITY_AUDIT_PERIODIC_SCAN_ENABLED=False)
    def test_manual_paths_work_with_periodic_disabled(self):
        for kwargs in ({"report_ids": None}, {"report_ids": []}):
            with self.subTest(kwargs=kwargs):
                self.assertEqual(audit.enqueue_stale_quality_report_audits(**kwargs), {
                    "created_count": 0, "created_job_ids": [], "examined_count": 0,
                    "total_report_count": 0, "eligible_count": 0, "remaining_count": 0,
                })
        for bounded in (False, True):
            with self.subTest(bounded=bounded):
                report = self.report()
                value = audit.enqueue_stale_quality_report_audits(
                    report_ids=[report.pk], bounded_scan=bounded,
                )
                self.assertEqual(value["created_count"], 1)

    @override_settings(QUALITY_AUDIT_PERIODIC_SCAN_ENABLED=True)
    def test_enabled_periodic_runs(self):
        report = self.report()
        value = audit.enqueue_stale_quality_report_audits(bounded_scan=True)
        self.assertEqual(value["created_count"], 1)
        self.assertEqual(AiJob.objects.get(pk=value["created_job_ids"][0]).scope["report_id"], report.pk)

    def test_metadata_stream_omits_inputs_and_loads_one_latest_result(self):
        report = self.report()
        for _ in range(30):
            self.job(report)
        with CaptureQueriesContext(connection) as queries:
            value = audit.enqueue_stale_quality_report_audits()
        self.assertEqual(value["created_count"], 0)
        selects = [row["sql"] for row in queries if 'SELECT' in row["sql"] and 'ai_core_aijob' in row["sql"]]
        self.assertTrue(selects)
        self.assertTrue(all('"input_payload"' not in sql for sql in selects))
        result_reads = [sql for sql in selects if '"result_payload"' in sql]
        self.assertEqual(len(result_reads), 1)
        metadata = [sql for sql in selects if '"scope"' in sql and '"status"' in sql and '"updated_at"' in sql]
        self.assertEqual(len(metadata), 1)
        self.assertNotIn('"result_payload"', metadata[0])

    def test_taxonomy_only_built_for_created_jobs(self):
        for _ in range(8):
            self.report()
        with patch.object(audit, "taxonomy_candidates", wraps=audit.taxonomy_candidates) as taxonomy:
            first = audit.enqueue_stale_quality_report_audits(limit=2)
        self.assertEqual(first["eligible_count"], 8)
        self.assertEqual(taxonomy.call_count, 2)
        AiJob.objects.update(status=AiJob.STATUS_COMPLETED, result_payload={"available": True})
        with patch.object(audit, "taxonomy_candidates", wraps=audit.taxonomy_candidates) as taxonomy:
            second = audit.enqueue_stale_quality_report_audits(limit=1)
        self.assertEqual(second["eligible_count"], 6)
        self.assertEqual(taxonomy.call_count, 1)

    def test_log_has_only_fixed_labels_and_selected_counts(self):
        report = self.report()
        for _ in range(4):
            self.job(report)
        with patch.object(audit, "read_rss_mib", side_effect=[100.0, 101.0]), \
                patch.object(audit, "perf_counter", side_effect=[1.0, 1.5]), \
                self.assertLogs("gunicorn.error", level="INFO") as lines:
            audit.enqueue_stale_quality_report_audits(bounded_scan=True)
        self.assertEqual(len(lines.output), 1)
        text = lines.output[0]
        for expected in ("quality_audit_scan", "page_index=0", "page_count=1",
                         "reports=1", "job_rows=4", "completed_payloads=1",
                         "eligible=0", "created=0", "elapsed_ms=500.0",
                         "rss_before_mib=100.00", "rss_after_mib=101.00"):
            self.assertIn(expected, text)
        self.assertNotIn("SYNTHETIC", text)
        self.assertNotIn("report_id=", text)

    def test_nonzero_page_thresholds_and_quiet_fast_scan(self):
        reports = [self.report() for _ in range(101)]
        self.job(reports[0])  # Oldest ID is the one row on page 1.
        for seconds, increase, should_log in (
            (0.5, 1, False), (1.0, 1, True), (0.5, 16, True),
        ):
            with self.subTest(seconds=seconds, increase=increase), \
                    patch.object(audit, "perf_counter", side_effect=[1.0, 1.0 + seconds]), \
                    patch.object(audit, "read_rss_mib", side_effect=[100, 100 + increase]), \
                    patch.object(audit._SCAN_LOG, "info") as log:
                audit.enqueue_stale_quality_report_audits(bounded_scan=True)
            self.assertEqual(log.call_count, int(should_log))

    def test_metrics_failures_do_not_change_creation_or_exceptions(self):
        for target in ("read_rss_mib", "perf_counter", "_SCAN_LOG.info"):
            with self.subTest(target=target):
                report = self.report()
                with patch("quality.classification_audit." + target, side_effect=RuntimeError("SYNTHETIC-metrics")):
                    value = audit.enqueue_stale_quality_report_audits(report_ids=[report.pk])
                self.assertEqual(value["created_count"], 1)
        with patch.object(audit, "read_rss_mib", side_effect=RuntimeError("SYNTHETIC-metrics")), \
                patch.object(audit, "_build_quality_report_audit_base", side_effect=ValueError("SYNTHETIC-business")):
            with self.assertRaisesMessage(ValueError, "SYNTHETIC-business"):
                audit.enqueue_stale_quality_report_audits(report_ids=[report.pk])
