import importlib.util
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, mock_open, patch

from django.http import HttpResponse, StreamingHttpResponse
from django.test import RequestFactory
from django.urls import resolve

from config import heavy_request_log


# A configuration file import on Linux would otherwise change this test
# process's allocator for tests that run afterward.
spec = importlib.util.spec_from_file_location("worker_memory_config", Path(__file__).parents[1] / "gunicorn.conf.py")
gunicorn_config = importlib.util.module_from_spec(spec)
with patch.dict(os.environ, {"WJ_MALLOC_ARENA_MAX": "0"}):
    spec.loader.exec_module(gunicorn_config)


class WorkerMemoryPolicyTests(TestCase):
    def setUp(self):
        self.worker = SimpleNamespace(pid=123, nr=0, max_requests=5500, alive=True, log=Mock())
        self.rss = self.enterContext(patch.object(gunicorn_config, "read_rss_mib", return_value=359))
        gunicorn_config.post_fork(None, self.worker)
        self.enterContext(patch.object(gunicorn_config, "_RSS_LIMIT_MIB", 360))

    def complete_request(self):
        self.worker.nr += 1
        gunicorn_config.post_request(self.worker, None, {}, None)

    def test_high_rss_requires_twenty_completed_requests(self):
        self.rss.return_value = 361
        for _ in range(19):
            self.complete_request()
        self.assertTrue(self.worker.alive)
        self.complete_request()
        self.assertFalse(self.worker.alive)
        self.complete_request()
        events = [call.args for call in self.worker.log.info.call_args_list]
        self.assertEqual(sum("worker_memory_recycle" in event[0] for event in events), 1)
        gunicorn_config.worker_exit(None, self.worker)
        self.assertEqual(self.worker.log.info.call_args.args[1:], (123, "361.00", 21, "rss"))

    def test_below_or_equal_to_threshold_and_missing_rss_are_ignored(self):
        for rss in (359, 360, None):
            with self.subTest(rss=rss):
                self.rss.return_value = rss
                for _ in range(20):
                    self.complete_request()
                self.assertTrue(self.worker.alive)

    def test_zero_disables_sampling_and_recycling(self):
        with patch.dict(os.environ, {"WJ_WORKER_RECYCLE_RSS_MIB": "0"}):
            self.assertEqual(gunicorn_config._rss_limit(), 0)
        self.rss.reset_mock()
        with patch.object(gunicorn_config, "_RSS_LIMIT_MIB", 0):
            for _ in range(20):
                self.complete_request()
        self.rss.assert_not_called()
        self.assertTrue(self.worker.alive)

    def test_gunicorn_request_cap_keeps_its_exit_reason(self):
        self.worker.nr = self.worker.max_requests
        self.worker.alive = False
        self.rss.return_value = 380
        self.complete_request()
        gunicorn_config.worker_exit(None, self.worker)
        self.assertEqual(self.worker.log.info.call_args.args[-1], "max_requests")

    def test_linux_statm_resident_pages_and_nonlinux(self):
        with (
            patch.object(heavy_request_log.sys, "platform", "linux"),
            patch("builtins.open", mock_open(read_data="500 256 10 9 0 200 0\n")),
            patch.object(heavy_request_log.os, "sysconf", return_value=4096),
        ):
            self.assertEqual(heavy_request_log.read_rss_mib(), 1)
        with (
            patch.object(heavy_request_log.sys, "platform", "darwin"),
            patch("builtins.open") as statm,
        ):
            self.assertIsNone(heavy_request_log.read_rss_mib())
            statm.assert_not_called()


class AllocatorPolicyTests(TestCase):
    def setUp(self):
        self.libc = SimpleNamespace(gnu_get_libc_version=Mock(), mallopt=Mock(return_value=1))
        self.open_libc = self.enterContext(patch.object(gunicorn_config.ctypes, "CDLL", return_value=self.libc))
        self.enterContext(patch.object(gunicorn_config.sys, "platform", "linux"))
        self.enterContext(patch.dict(os.environ, {}, clear=True))

    def test_existing_environment_keeps_control(self):
        os.environ["MALLOC_ARENA_MAX"] = "4"
        self.assertEqual(gunicorn_config._configure_arenas(), ("environment", None))
        self.open_libc.assert_not_called()

    def test_opt_out_does_not_load_libc(self):
        os.environ["WJ_MALLOC_ARENA_MAX"] = "0"
        self.assertEqual(gunicorn_config._configure_arenas(), ("disabled", None))
        self.open_libc.assert_not_called()

    def test_missing_mallopt_and_nonglibc_are_skipped(self):
        del self.libc.mallopt
        self.assertEqual(gunicorn_config._configure_arenas(), ("mallopt_unavailable", None))
        del self.libc.gnu_get_libc_version
        self.assertEqual(gunicorn_config._configure_arenas(), ("not_glibc", None))

    def test_glibc_sets_hard_arena_limit_and_reports_return_code(self):
        self.assertEqual(gunicorn_config._configure_arenas(), ("applied", 1))
        self.libc.mallopt.assert_called_once_with(-8, 2)
        self.libc.mallopt.return_value = 0
        self.assertEqual(gunicorn_config._configure_arenas(), ("rejected", 0))


class HeavyRequestLogTests(TestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.response = HttpResponse("SYNTHETIC", status=202)
        self.middleware = heavy_request_log.HeavyRequestLogMiddleware(lambda request: self.response)

    def test_target_paths_are_exact_and_use_the_registered_api_prefix(self):
        for method, path in heavy_request_log._ROUTES:
            self.assertIsNotNone(resolve(path))
        with patch.object(heavy_request_log, "read_rss_mib") as read:
            for method, path in (
                ("get", "/api/health/"),
                ("get", "/api/injection/parts/SYNTHETIC-PART/standard-cycle-time/"),
                ("post", "/api/injection/parts/"),
                ("get", "/api/ai/jobs/enqueue-periodic/"),
            ):
                request = getattr(self.factory, method)(path)
                self.assertIs(self.middleware(request), self.response)
            read.assert_not_called()

    def test_exact_thresholds_independently_enable_logging(self):
        request = self.factory.get("/api/injection/parts/?search=SYNTHETIC-SECRET", HTTP_AUTHORIZATION="SYNTHETIC-AUTH")
        for before, after, elapsed in ((150, 158, 0.1), (320, 320, 0.1), (None, None, 3)):
            with (
                self.subTest(before=before, after=after, elapsed=elapsed),
                patch.object(heavy_request_log, "read_rss_mib", side_effect=[before, after]),
                patch.object(heavy_request_log, "perf_counter", side_effect=[0, elapsed]),
                self.assertLogs("gunicorn.error") as logs,
            ):
                self.assertIs(self.middleware(request), self.response)
                self.assertRegex(logs.output[0], r"heavy_request route=part_list method=GET status=202 .*inflight=1 bytes=9 pid=\d+")
                self.assertNotIn("search", logs.output[0])
                self.assertNotIn("SYNTHETIC", logs.output[0])

    def test_no_logging_when_all_thresholds_are_below(self):
        with (
            patch.object(heavy_request_log, "read_rss_mib", side_effect=[300, 307.99]),
            patch.object(heavy_request_log, "perf_counter", side_effect=[0, 2.99]),
            self.assertNoLogs("gunicorn.error"),
        ):
            self.middleware(self.factory.get("/api/production/overview-board/"))

    def test_measurement_exception_keeps_the_same_response(self):
        for readings in ([RuntimeError], [100, RuntimeError]):
            with (
                self.subTest(readings=readings),
                patch.object(heavy_request_log, "read_rss_mib", side_effect=readings),
            ):
                self.assertIs(self.middleware(self.factory.get("/api/injection/production-matrix/")), self.response)

    def test_streamed_response_is_not_consumed(self):
        content = iter([b"SYNTHETIC"])
        response = StreamingHttpResponse(content)
        middleware = heavy_request_log.HeavyRequestLogMiddleware(lambda request: response)
        with patch.object(heavy_request_log, "read_rss_mib", return_value=335), self.assertLogs("gunicorn.error") as logs:
            self.assertIs(middleware(self.factory.post("/api/ai/jobs/enqueue-periodic/")), response)
        self.assertIn("bytes= pid=", logs.output[0])
        self.assertEqual(list(response.streaming_content), [b"SYNTHETIC"])

    def test_inflight_counts_overlapping_targets(self):
        first_started = Event()
        finish_first = Event()

        def view(request):
            if request.path == "/api/injection/parts/":
                first_started.set()
                if not finish_first.wait(5):
                    raise TimeoutError("SYNTHETIC overlapping request timed out")
            return self.response

        middleware = heavy_request_log.HeavyRequestLogMiddleware(view)
        with (
            patch.object(heavy_request_log, "read_rss_mib", return_value=335),
            self.assertLogs("gunicorn.error") as logs,
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            first = executor.submit(middleware, self.factory.get("/api/injection/parts/"))
            try:
                self.assertTrue(first_started.wait(5))
                second = executor.submit(middleware, self.factory.get("/api/production/overview-board/"))
                self.assertIs(second.result(timeout=5), self.response)
            finally:
                finish_first.set()
            self.assertIs(first.result(timeout=5), self.response)
        self.assertRegex(logs.output[0], r"route=overview_board .*inflight=2")
        self.assertRegex(logs.output[1], r"route=part_list .*inflight=1")
