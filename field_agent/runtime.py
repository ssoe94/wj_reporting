"""Keep the device path independent of network, backup and browser work."""

from threading import Event, Lock, Thread
from time import monotonic
import sqlite3

from . import __version__
from .backup import Backup, DEFAULT_MIN_FREE
from .devices import FakeBarcodeApp, FakeLineDevice
from .local_ui import LocalUI
from .protocol import timestamp
from .resources import Resources
from .uploader import Uploader


class Runtime:
    def __init__(self, ledger, transport, *, demo=False, port=None, backup_idle=60,
                 backup_keep=30, min_free_bytes=DEFAULT_MIN_FREE):
        self.ledger = ledger
        self.station_id = ledger.station_id
        self._halt = Event()
        self._lock = Lock()
        self._threads = []
        self._last_activity = monotonic()
        self._last_work_at = None
        self._last_input_at = None
        self._device_error = None
        self._coverage = "known"
        self._committed = 0
        self.port = port
        self.local_ui = None
        self.device = FakeLineDevice() if demo else None
        self.app = FakeBarcodeApp(ledger, __version__) if demo else None
        self.resources = Resources(ledger.path)
        self.backup = Backup(
            ledger, ledger.path.parent / "backup", keep=backup_keep,
            min_free_bytes=min_free_bytes, idle_seconds=backup_idle,
            transition=self._backup_changed,
        )
        self.uploader = Uploader(ledger, transport, self._heartbeat_snapshot)
        self.minimum_free = min_free_bytes

    def _backup_changed(self):
        self.uploader.wake(state_changed=True)

    @property
    def committed(self):
        with self._lock:
            return self._committed

    def _app_devices(self):
        if self.app is None:
            return [], []
        with self._lock:
            fault = self._device_error is not None
            apps = [{
                "app": "barcode", "version": __version__, "mode": "test",
                "state": "fault" if fault else "running", "last_work_at": self._last_work_at,
            }]
            devices = [{
                "app": "barcode", "device": "A", "state": "fault" if fault else "connected",
                "last_input_at": self._last_input_at,
            }]
        return apps, devices

    def _heartbeat_snapshot(self):
        apps, devices = self._app_devices()
        resources = self.resources.snapshot()
        disk_free = resources["disk_free_bytes"]
        backup_low = self.backup.status()["reason"] == "disk_low"
        with self._lock:
            write_pressure = self._device_error == "ledger_full"
            coverage = self._coverage
        state = backup_low or write_pressure or (disk_free is not None and disk_free < self.minimum_free)
        return {
            "agent_version": __version__, "apps": apps, "devices": devices, "resources": resources,
            "storage_pressure": state, "coverage": coverage,
        }

    def snapshot(self):
        """Local UI interface. No credentials, device calls, DB, disk or HTTP."""
        apps, devices = self._app_devices()
        with self._lock:
            device_error = self._device_error
        return {
            "station_id": self.station_id, "agent_version": __version__, "apps": apps, "devices": devices,
            "outbox": self.uploader.status(), "clock_offset_seconds": self.uploader.clock_offset_seconds,
            "heartbeat_error": self.uploader.heartbeat_error, "backup": self.backup.status(),
            "device_error": device_error,
        }

    def _read_device(self):
        while not self._halt.is_set():
            frame = self.device.read_line()
            if frame is None:
                continue
            moment = timestamp()
            with self._lock:
                self._last_input_at = moment
                self._last_activity = monotonic()
            error = None
            try:
                self.app.record(frame, moment)
            except (UnicodeError, ValueError):
                error = "invalid_demo_frame"
            except sqlite3.Error as exc:
                error = "ledger_full" if getattr(exc, "sqlite_errorcode", None) == sqlite3.SQLITE_FULL else "ledger_write_failed"
            with self._lock:
                changed = self._device_error != error
                self._device_error = error
                if error is None:
                    self._last_work_at = moment
                    self._committed += 1
                else:
                    self._coverage = "partial"
            # The thread receives no completion callbacks from uploader or backup.
            if error is None or changed:
                self.uploader.wake(state_changed=changed)

    def _run_backup(self):
        while not self._halt.is_set():
            with self._lock:
                idle_for = monotonic() - self._last_activity
            self.backup.due(idle_for, self._halt)
            self._halt.wait(5)

    def start(self):
        if self.port is not None:
            self.local_ui = LocalUI(self.snapshot, port=self.port).start()
        targets = [("field-upload", lambda: self.uploader.run(self._halt)), ("field-backup", self._run_backup)]
        if self.app is not None:
            targets.append(("field-fake-scanner", self._read_device))
        for name, target in targets:
            thread = Thread(name=name, target=target, daemon=True)
            thread.start()
            self._threads.append(thread)
        return self

    def stop(self):
        self._halt.set()
        self.uploader.wake()
        if self.local_ui is not None:
            self.local_ui.stop()
        for thread in self._threads:
            thread.join(10)
        if any(thread.is_alive() for thread in self._threads):
            raise RuntimeError("A station worker did not stop")
