"""Line-oriented fake device and optional serial adapter."""

from queue import Empty, Full, Queue


MAX_FRAME_BYTES = 1024


class FakeLineDevice:
    def __init__(self, max_queue=64):
        self._frames = Queue(maxsize=max_queue)

    def feed(self, frame):
        if not isinstance(frame, bytes) or len(frame) > MAX_FRAME_BYTES:
            raise ValueError("Expected a bounded line of bytes")
        # No silent drops. A non-blocking producer can handle Full and report it.
        self._frames.put_nowait(frame)

    def read_line(self):
        try:
            return self._frames.get(timeout=0.25)
        except Empty:
            return None


class SerialLineDevice:
    def __init__(self, port, baudrate=9600):
        try:
            import serial
        except ImportError as exc:
            raise RuntimeError("Serial input needs pyserial; fake input is available") from exc
        self._serial = serial.Serial(port, baudrate=baudrate, timeout=0.25)
        self._discard_partial = False

    def read_line(self):
        frame = self._serial.read_until(b"\n", size=MAX_FRAME_BYTES + 1)
        if not frame:
            return None
        complete = frame.endswith(b"\n")
        discarded = self._discard_partial or not complete or len(frame) > MAX_FRAME_BYTES
        self._discard_partial = not complete
        return None if discarded else frame

    def close(self):
        self._serial.close()


class FakeBarcodeApp:
    """Exercise a shared commit without adopting any field judgement rules."""

    def __init__(self, ledger, version):
        self.ledger = ledger
        self.version = version
        with ledger.transaction() as conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS demo_scans (
                id INTEGER PRIMARY KEY, barcode TEXT NOT NULL, recorded_at TEXT NOT NULL
            )""")

    def record(self, frame, occurred_at):
        value = frame.decode("utf-8").rstrip("\r\n")
        if not value or len(value.encode("utf-8")) > 256:
            raise ValueError("Invalid demo input")
        with self.ledger.transaction() as conn:
            job = conn.execute("INSERT INTO demo_scans(barcode, recorded_at) VALUES(?,?)",
                               (value, occurred_at)).lastrowid
            event = {
                "occurred_at": occurred_at, "app": "barcode", "type": "scan.recorded",
                "app_version": self.version, "agent_version": self.version, "config_version": "demo-v1",
                "mode": "test", "result": "ok", "reason": "scan_match", "status_raw": "demo",
                "barcode": value, "device": "A", "ref": {"attempt_id": "demo-" + str(job)},
            }
            return self.ledger.append(conn, event)
