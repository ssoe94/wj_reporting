"""Observe selected Django requests without recording request data."""

import logging
import os
import sys
from threading import Lock
from time import perf_counter


_LOG = logging.getLogger("gunicorn.error")
_ROUTES = {
    ("GET", "/api/injection/production-matrix/"): "production_matrix",
    ("GET", "/api/injection/parts/"): "part_list",
    ("GET", "/api/production/overview-board/"): "overview_board",
    ("POST", "/api/ai/jobs/enqueue-periodic/"): "ai_periodic_enqueue",
}
_MIB = 1024 * 1024


def read_rss_mib():
    if sys.platform != "linux":
        return None
    try:
        with open("/proc/self/statm", encoding="ascii") as statm:
            resident_pages = int(statm.readline().split()[1])
        return resident_pages * os.sysconf("SC_PAGE_SIZE") / _MIB
    except (OSError, IndexError, ValueError):
        return None


def format_rss(rss):
    return "" if rss is None else f"{rss:.2f}"


def _should_log(before, after, elapsed):
    return (
        elapsed >= 3
        or (after is not None and after >= 320)
        or (before is not None and after is not None and after - before >= 8)
    )


def _response_bytes(response):
    length = response.get("Content-Length")
    if length is not None and length.isascii() and length.isdecimal():
        return length
    if response.streaming:
        return ""
    return len(response.content)


class PeriodicEnqueueStageLog:
    """Collect five fixed stage samples without affecting enqueue behavior."""

    _STAGES = ("hourly", "quality_summary", "translations", "quality_audit", "deep_analysis")

    def __init__(self):
        self._samples = []
        self._enabled = False
        try:
            self._started_at = perf_counter()
            self._previous_at = self._started_at
            self._before = read_rss_mib()
            self._enabled = True
        except Exception:
            pass

    def record(self, stage):
        if not self._enabled:
            return
        try:
            if stage != self._STAGES[len(self._samples)]:
                self._enabled = False
                return
            ended_at = perf_counter()
            rss = read_rss_mib()
            self._samples.append(((ended_at - self._previous_at) * 1000, rss))
            self._previous_at = ended_at
        except Exception:
            self._enabled = False

    def finish(self):
        if not self._enabled or len(self._samples) != len(self._STAGES):
            return
        self._enabled = False
        try:
            elapsed_ms = (self._previous_at - self._started_at) * 1000
            after = self._samples[-1][1]
            rss_increased = (
                self._before is not None
                and after is not None
                and after - self._before >= 16
            )
            if elapsed_ms < 1000 and not rss_increased:
                return
            values = []
            for elapsed, rss in self._samples:
                values.extend((elapsed, format_rss(rss)))
            _LOG.info(
                "ai_periodic_enqueue_stages hourly_elapsed_ms=%.1f hourly_rss_mib=%s "
                "quality_summary_elapsed_ms=%.1f quality_summary_rss_mib=%s "
                "translations_elapsed_ms=%.1f translations_rss_mib=%s "
                "quality_audit_elapsed_ms=%.1f quality_audit_rss_mib=%s "
                "deep_analysis_elapsed_ms=%.1f deep_analysis_rss_mib=%s "
                "elapsed_ms=%.1f rss_before_mib=%s rss_after_mib=%s",
                *values, elapsed_ms, format_rss(self._before), format_rss(after),
            )
        except Exception:
            pass


class HeavyRequestLogMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response
        self._lock = Lock()
        self._inflight = 0

    def __call__(self, request):
        method = request.method
        route = _ROUTES.get((method, request.path))
        if route is None:
            return self.get_response(request)
        try:
            before = read_rss_mib()
            started_at = perf_counter()
            with self._lock:
                self._inflight += 1
                inflight = self._inflight
        except Exception:
            return self.get_response(request)

        try:
            response = self.get_response(request)
        finally:
            with self._lock:
                self._inflight -= 1

        try:
            elapsed = perf_counter() - started_at
            after = read_rss_mib()
            if _should_log(before, after, elapsed):
                _LOG.info(
                    "heavy_request route=%s method=%s status=%s dt_ms=%.1f rss_before_mib=%s "
                    "rss_after_mib=%s inflight=%d bytes=%s pid=%d",
                    route, method, response.status_code, elapsed * 1000,
                    format_rss(before), format_rss(after), inflight, _response_bytes(response), os.getpid(),
                )
        except Exception:
            # A failed sample or log write cannot change the application response.
            pass
        return response
