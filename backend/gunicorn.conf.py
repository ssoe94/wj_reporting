"""Recycle web workers before retained memory reaches the instance limit."""

import ctypes
import os
import sys
from threading import Lock

from config.heavy_request_log import format_rss, read_rss_mib


max_requests = 5000
max_requests_jitter = 500


def _rss_limit():
    try:
        limit = int(os.environ.get("WJ_WORKER_RECYCLE_RSS_MIB", "360"))
    except ValueError:
        return 360
    return limit if limit >= 0 else 360


def _configure_arenas():
    if sys.platform != "linux":
        return "unsupported_platform", None
    if "MALLOC_ARENA_MAX" in os.environ:
        return "environment", None
    if os.environ.get("WJ_MALLOC_ARENA_MAX") == "0":
        return "disabled", None
    try:
        libc = ctypes.CDLL(None)
        if not hasattr(libc, "gnu_get_libc_version"):
            return "not_glibc", None
        mallopt = getattr(libc, "mallopt", None)
        if mallopt is None:
            return "mallopt_unavailable", None
        mallopt.argtypes = (ctypes.c_int, ctypes.c_int)
        mallopt.restype = ctypes.c_int
        result = mallopt(-8, 2)  # glibc M_ARENA_MAX
        return ("applied" if result == 1 else "rejected"), result
    except (OSError, TypeError, ValueError):
        return "mallopt_unavailable", None


_RSS_LIMIT_MIB = _rss_limit()
_ARENA_STATUS, _ARENA_RETURN = _configure_arenas()


def on_starting(server):
    server.log.info(
        "worker_memory_policy recycle_rss_mib=%d max_requests=%d max_requests_jitter=%d "
        "arena_status=%s mallopt_return=%s",
        _RSS_LIMIT_MIB, server.cfg.max_requests, server.cfg.max_requests_jitter,
        _ARENA_STATUS, "" if _ARENA_RETURN is None else _ARENA_RETURN,
    )


def post_fork(server, worker):
    worker._wj_memory_lock = Lock()
    worker._wj_completed_requests = 0
    worker._wj_recycle_reason = None
    worker.log.info("worker_memory_start pid=%d rss_mib=%s", worker.pid, format_rss(read_rss_mib()))


def post_request(worker, req, environ, resp):
    rss = read_rss_mib() if _RSS_LIMIT_MIB else None
    with worker._wj_memory_lock:
        worker._wj_completed_requests += 1
        completed = worker._wj_completed_requests
        if not worker.alive or completed < 20 or rss is None or rss <= _RSS_LIMIT_MIB:
            return
        worker._wj_recycle_reason = "rss"
        worker.alive = False
    worker.log.info(
        "worker_memory_recycle pid=%d rss_mib=%s limit_mib=%d requests=%d reason=rss",
        worker.pid, format_rss(rss), _RSS_LIMIT_MIB, completed,
    )


def worker_exit(server, worker):
    reason = getattr(worker, "_wj_recycle_reason", None)
    if reason is None:
        reason = "max_requests" if worker.nr >= worker.max_requests else "other"
    worker.log.info(
        "worker_memory_exit pid=%d rss_mib=%s requests=%d reason=%s",
        worker.pid, format_rss(read_rss_mib()), getattr(worker, "_wj_completed_requests", 0), reason,
    )
