from contextlib import ExitStack
from datetime import date
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.test import SimpleTestCase, override_settings
from rest_framework.test import APIRequestFactory

from config import heavy_request_log
from .views import AiWorkerPeriodicEnqueueView


@override_settings(AI_WORKER_TOKEN="SYNTHETIC-worker-token")
class PeriodicEnqueueStageViewTests(SimpleTestCase):
    def setUp(self):
        self.events = []
        self.mocks = {}
        self.stack = self.enterContext(ExitStack())
        self.stack.enter_context(patch("ai_core.views.PRODUCTION_AI_MODEL_IDS", ()))
        self.stack.enter_context(patch("ai_core.views.current_business_scope", side_effect=lambda: self.hourly_scope()))
        self.stack.enter_context(patch("ai_core.views.AiJobResultSerializer", return_value=Mock(data=[])))
        targets = {
            "quality_summary": "ai_core.views.enqueue_daily_quality_summary",
            "translations": "quality.action_result_translation.enqueue_missing_translations",
            "quality_audit": "quality.classification_audit.enqueue_stale_quality_report_audits",
            "deep_analysis": "ai_core.views.enqueue_daily_deep_analysis",
        }
        for stage, target in targets.items():
            self.mocks[stage] = self.stack.enter_context(patch(target, side_effect=self.result_for(stage)))

    def hourly_scope(self):
        self.events.append("hourly")
        return date(2026, 1, 1), "SYNTHETIC-hour"

    def result_for(self, stage):
        def result(*args, **kwargs):
            self.events.append(stage)
            return {"created_count": 0}
        return result

    def request(self, payload=None):
        request = APIRequestFactory().post(
            "/api/ai/jobs/enqueue-periodic/", payload or {}, format="json",
            HTTP_X_AI_WORKER_TOKEN="SYNTHETIC-worker-token",
        )
        return AiWorkerPeriodicEnqueueView.as_view()(request)

    def test_stage_order_response_and_fixed_log(self):
        with (
            patch.object(heavy_request_log, "perf_counter", side_effect=[0, 0.1, 0.2, 0.3, 0.4, 1]),
            patch.object(heavy_request_log, "read_rss_mib", side_effect=[100, 101, 102, 103, 104, 105]),
            self.assertLogs("gunicorn.error") as logs,
        ):
            response = self.request()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {
            "schedule_slot": "SYNTHETIC-hour", "created_count": 0, "jobs": [],
            "quality_summary": {"created_count": 0, "job": None},
            "quality_report_audit": {"created_count": 0}, "deep_analysis": {"created_count": 0},
        })
        self.assertEqual(self.events, list(heavy_request_log.PeriodicEnqueueStageLog._STAGES))
        self.mocks["quality_audit"].assert_called_once_with(bounded_scan=True)
        self.assertEqual(len(logs.output), 1)
        self.assertNotIn("SYNTHETIC", logs.output[0])

    def test_restricted_deep_branch_does_not_start_stage_sampler(self):
        with patch("ai_core.views.PeriodicEnqueueStageLog") as sampler:
            response = self.request({"job_types": ["deep_analysis"], "languages": ["zh"]})
        self.assertEqual(response.data, {"created_count": 0, "deep_analysis": {"created_count": 0}})
        self.assertEqual(self.events, ["deep_analysis"])
        self.mocks["deep_analysis"].assert_called_once_with(languages=("zh",))
        sampler.assert_not_called()

    def test_sampler_failures_keep_successful_response(self):
        with patch.object(heavy_request_log, "read_rss_mib", side_effect=RuntimeError("SYNTHETIC-rss-failure")):
            response = self.request()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.events, list(heavy_request_log.PeriodicEnqueueStageLog._STAGES))

    def test_business_exception_keeps_identity_and_stops_following_stages(self):
        failure = RuntimeError("SYNTHETIC-business-failure")
        self.mocks["quality_audit"].side_effect = failure
        with patch.object(heavy_request_log, "read_rss_mib", side_effect=RuntimeError("SYNTHETIC-rss-failure")):
            with self.assertRaises(RuntimeError) as raised:
                AiWorkerPeriodicEnqueueView().post(SimpleNamespace(data={}))
        self.assertIs(raised.exception, failure)
        self.mocks["deep_analysis"].assert_not_called()

    def test_deep_failure_preserves_existing_successful_fallback_and_stage_sample(self):
        self.mocks["deep_analysis"].side_effect = RuntimeError("SYNTHETIC-deep-failure")
        with (
            patch("ai_core.views.logger.exception") as exception_log,
            patch.object(heavy_request_log, "perf_counter", side_effect=range(6)),
            patch.object(heavy_request_log, "read_rss_mib", return_value=None),
            self.assertLogs("gunicorn.error") as logs,
        ):
            response = self.request()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["deep_analysis"], {"error": "RuntimeError: SYNTHETIC-deep-failure"})
        exception_log.assert_called_once_with("Daily deep analysis enqueue failed")
        self.assertIn("deep_analysis_elapsed_ms=", logs.output[0])
