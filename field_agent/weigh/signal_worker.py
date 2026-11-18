"""Latest-state USB signalling on a worker thread; never block the scale UI."""
import threading
import time

from .hardware_io import create_signal


RECONNECT_INITIAL_SECONDS = 1.0
RECONNECT_MAX_SECONDS = 8.0


class SignalWorker:
    """One pending state, one bounded hardware buzzer pattern per transition.

    Adapter construction is lazy and performs no device I/O. Adapters that
    explicitly support reconnect restore the latest color with bounded backoff,
    without replaying a previous buzzer. Other adapters latch failures. All
    device calls and final all-off/handle release occur on this worker thread.
    """

    def __init__(self, settings=None, *, device=None):
        self.device = device if device is not None else create_signal(settings or {})
        self._recoverable = getattr(self.device, "supports_reconnect", False) is True
        self.error = None
        self.error_code = None
        self.error_details = {}
        self.last_color = None
        self.closed = False
        self._last_command = None
        self._pending = None
        self._condition = threading.Condition()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def set_state(self, color, buzzer="off"):
        command = (color, buzzer)
        with self._condition:
            if self.closed or (self.error is not None and not self._recoverable):
                return False
            # Routine UI refresh must not stop/restart a finite buzzer pattern.
            if command == self._last_command or (color == self.last_color and buzzer == "off"):
                return False
            self.last_color = color
            self._last_command = command
            # While disconnected, retain desired light changes but consume
            # buzzer events. Old alarms must not sound later on reconnection.
            self._pending = (color, "off") if self.error is not None else command
            self._condition.notify()
            return True

    def _run(self):
        retry_at = None
        retry_delay = RECONNECT_INITIAL_SECONDS
        try:
            while True:
                with self._condition:
                    while not self.closed:
                        if retry_at is not None:
                            remaining = retry_at - time.monotonic()
                            if remaining > 0:
                                # UI updates wake this wait, but do not bypass
                                # the reconnect deadline or restart its timer.
                                self._condition.wait(remaining)
                                continue
                            command = (self.last_color, "off")
                            self._pending = None
                            retry_at = None
                            break
                        if self._pending is not None:
                            command, self._pending = self._pending, None
                            break
                        self._condition.wait()
                    if self.closed:
                        break
                try:
                    self.device.set_state(*command)
                except Exception as exc:
                    with self._condition:
                        self.error = str(exc) or type(exc).__name__
                        self.error_code = getattr(exc, "code", None)
                        self.error_details = dict(getattr(exc, "details", {}))
                        self._pending = None
                        if self._recoverable:
                            retry_at = time.monotonic() + retry_delay
                            retry_delay = min(retry_delay * 2, RECONNECT_MAX_SECONDS)
                        self._condition.notify_all()
                    if not self._recoverable:
                        break
                else:
                    # K50L only returns after each exact command echo has been
                    # checked. Merely finding or reopening COM is insufficient.
                    with self._condition:
                        self.error = None
                        self.error_code = None
                        self.error_details = {}
                        self._condition.notify_all()
                    retry_delay = RECONNECT_INITIAL_SECONDS
        finally:
            try:
                self.device.close()
            except Exception as exc:
                # Preserve the failure that first stopped signalling.
                with self._condition:
                    if self.error is None:
                        self.error = str(exc) or type(exc).__name__
                        self.error_code = getattr(exc, "code", None)
                        self.error_details = dict(getattr(exc, "details", {}))

    def close(self, timeout=1.0):
        with self._condition:
            self.closed = True
            self._pending = None
            self._condition.notify()
        if threading.current_thread() is not self.thread:
            self.thread.join(timeout=timeout)
        # A blocked OS write cannot safely be closed from a second thread. The
        # worker sends all-off/releases its handle immediately after it returns.
        return not self.thread.is_alive()
