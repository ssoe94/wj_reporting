"""Low-frequency current process measurements, used from the uploader only."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
from time import monotonic, process_time


def _windows_rss():
    import ctypes
    from ctypes import wintypes

    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("page_faults", wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in (
                "peak_working_set", "working_set", "peak_paged_pool", "paged_pool",
                "peak_nonpaged_pool", "nonpaged_pool", "pagefile", "peak_pagefile",
            )
        ]

    process = ctypes.windll.kernel32.GetCurrentProcess
    process.restype = wintypes.HANDLE
    get_info = ctypes.windll.psapi.GetProcessMemoryInfo
    get_info.argtypes = (wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD)
    get_info.restype = wintypes.BOOL
    data = Counters()
    data.cb = ctypes.sizeof(data)
    return data.working_set if get_info(process(), ctypes.byref(data), data.cb) else None


def current_rss():
    try:
        if sys.platform == "win32":
            return _windows_rss()
        if sys.platform.startswith("linux"):
            return int(Path("/proc/self/statm").read_text().split()[1]) * os.sysconf("SC_PAGE_SIZE")
        if sys.platform == "darwin":
            result = subprocess.run(["/bin/ps", "-o", "rss=", "-p", str(os.getpid())],
                                    check=True, capture_output=True, text=True, timeout=1)
            return int(result.stdout.strip()) * 1024
    except (OSError, ValueError, AttributeError, IndexError, subprocess.SubprocessError):
        pass
    return None


class Resources:
    def __init__(self, ledger_path, every=60):
        self.path = Path(ledger_path)
        self.every = every
        self.last_time = monotonic()
        self.last_cpu = process_time()
        self.last = None

    def snapshot(self):
        at = monotonic()
        if self.last is not None and at - self.last_time < self.every:
            return dict(self.last)
        cpu = process_time()
        elapsed = at - self.last_time
        self.last = {
            "cpu_pct": "{:.2f}".format(100 * (cpu - self.last_cpu) / elapsed) if elapsed >= 1 else None,
            "rss_bytes": current_rss(),
            "disk_free_bytes": None,
            "ledger_bytes": None,
        }
        try:
            self.last["disk_free_bytes"] = shutil.disk_usage(self.path.parent).free
            self.last["ledger_bytes"] = sum(_size(path) for path in (
                self.path, Path(str(self.path) + "-wal"), Path(str(self.path) + "-shm"),
            ))
        except OSError:
            pass
        self.last_time, self.last_cpu = at, cpu
        return dict(self.last)


def _size(path):
    try:
        return path.stat().st_size
    except FileNotFoundError:
        return 0
