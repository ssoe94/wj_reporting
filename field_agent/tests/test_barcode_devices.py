from collections import deque
import sys
from threading import Lock
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from field_agent.barcode_devices import BarcodeDevices, FrameDecoder, discover_scanners


class FakeBarcodeBackend:
    """Synthetic hot-plug and byte reads at the same boundary as pyserial."""

    def __init__(self):
        self._lock = Lock()
        self._ports = {}
        self._open_ports = set()
        self.open_attempts = []
        self.busy = set()

    def attach(self, port, location, serial_number="", usb_id=(0x26F1, 0xD001)):
        info = SimpleNamespace(device=port, vid=usb_id[0], pid=usb_id[1], location=location,
                               serial_number=serial_number, chunks=deque())
        with self._lock:
            self._ports[port] = info
        return next(iter(discover_scanners([info])), None)

    def detach(self, port):
        with self._lock:
            del self._ports[port]

    def feed(self, port, data):
        with self._lock:
            self._ports[port].chunks.append(data)

    def list_ports(self):
        with self._lock:
            return list(self._ports.values())

    def open(self, port):
        with self._lock:
            self.open_attempts.append(port)
            if port in self._open_ports:
                raise AssertionError("The same COM was opened twice")
            if port in self.busy or port not in self._ports:
                raise OSError("Serial handle unavailable")
            info = self._ports[port]
            self._open_ports.add(port)

        def read(size):
            with self._lock:
                if self._ports.get(port) is not info:
                    raise OSError("Disconnected scanner")
                if not info.chunks:
                    return b""
                raw = info.chunks.popleft()
                if len(raw) > size:
                    info.chunks.appendleft(raw[size:])
                return raw[:size]

        def close():
            with self._lock:
                self._open_ports.remove(port)

        return SimpleNamespace(read=read, close=close)


class FrameDecoderTests(unittest.TestCase):
    def test_delimiters_split_utf8_and_legacy_normalization(self):
        frame = FrameDecoder()
        self.assertEqual(frame.feed(b" \x00\t#SYNTH-", 0), [])
        self.assertEqual(frame.feed(b"CO\x00DE\x00 \r", 0.1), [("scan", "SYNTH-CODE")])
        self.assertEqual(frame.feed(b"\nSYNTH-B\nSYNTH-C\r\r\n", 0.2),
                         [("scan", "SYNTH-B"), ("scan", "SYNTH-C")])
        payload = "합성".encode("utf-8")
        self.assertEqual(frame.feed(payload[:1], 0.3), [])
        self.assertEqual(frame.feed(payload[1:] + b"\n", 0.4), [("scan", "합성")])
        self.assertEqual(frame.feed(b"\n\x00 \t# \x00\r", 0.5), [])

    def test_suffixless_frames_finish_on_idle_including_before_new_burst(self):
        frame = FrameDecoder()
        full = "SYNTH-A-1234567890123"
        long = "SYNTH-B-12345678901234"
        self.assertEqual(frame.feed(full.encode(), 0), [])
        self.assertEqual(frame.expire(0.39), [])
        self.assertEqual(frame.expire(0.4), [("scan", full)])
        self.assertEqual(frame.expire(0.5), [])
        self.assertEqual(frame.feed(long.encode(), 1.0), [])
        self.assertEqual(frame.feed(b"SYNTH-C\n", 1.5),
                         [("scan", long), ("scan", "SYNTH-C")])

    def test_idle_short_fragment_counts_as_partial_while_terminated_short_frame_goes_to_rules(self):
        frame = FrameDecoder()
        self.assertEqual(frame.feed(b"SHORT", 0), [])
        self.assertEqual(frame.expire(0.4), [("error", "partial")])
        self.assertEqual(frame.feed(b"SHORT\r", 0.5), [("scan", "SHORT")])

    def test_max_is_raw_byte_limit_and_corrupted_frames_are_discarded(self):
        frame = FrameDecoder()
        self.assertEqual(frame.feed(b"X" * 256 + b"\n", 0), [("scan", "X" * 256)])
        self.assertEqual(frame.feed(b"X" * 200, 0.1), [])
        self.assertEqual(frame.feed(b"X" * 1000, 0.2), [])
        self.assertEqual(frame.feed(b"\n\xff\rSYNTH-A\r", 0.3),
                         [("error", "oversize"), ("error", "decode"), ("scan", "SYNTH-A")])
        self.assertEqual(frame.feed(b"\xe9" + b"\n", 0.4), [("error", "decode")])
        self.assertEqual(frame.feed(b"X" * 257, 0.5), [])
        self.assertEqual(frame.expire(1.0), [("error", "oversize")])

    def test_interrupted_utf8_or_unterminated_frames_count_once_as_partial(self):
        frame = FrameDecoder()
        self.assertEqual(frame.disconnect(), [])
        self.assertEqual(frame.feed(b"SYNTH-\xe9", 0), [])
        self.assertEqual(frame.disconnect(), [("error", "partial")])
        self.assertEqual(frame.disconnect(), [])
        self.assertEqual(frame.feed(b"FRESH\r", 0.1), [("scan", "FRESH")])
        self.assertEqual(frame.feed(b"X" * 257, 0.2), [])
        self.assertEqual(frame.disconnect(), [("error", "oversize")])


class ScannerDiscoveryTests(unittest.TestCase):
    def test_supported_usb_ids_and_unambiguous_identity_only(self):
        backend = FakeBarcodeBackend()
        a = backend.attach("COM9", "SYNTH-A", "DUPLICATE")
        b = backend.attach("COM3", "SYNTH-B", "DUPLICATE")
        c = backend.attach("COM6", None, "SYNTH-UNIQUE-SERIAL")
        backend.attach("COM7", None, "000000")
        backend.attach("COM20", "SYNTH-X", usb_id=(0x067B, 0x2303))
        backend.attach("COM8", "SYNTH-Y", usb_id=(0x0483, 0x0115))
        backend.attach("COM21", "SYNTH-DUPLICATE-LOCATION")
        backend.attach("COM22", "SYNTH-DUPLICATE-LOCATION")
        backend.attach("COM25", None, "SYNTH-DUPLICATE-SERIAL")
        backend.attach("COM26", None, "SYNTH-DUPLICATE-SERIAL")

        discovered = discover_scanners(backend.list_ports())
        self.assertEqual({key: value.port for key, value in discovered.items()},
                         {a: "COM9", b: "COM3", c: "COM6"})


class BarcodeDeviceTests(unittest.TestCase):
    def setUp(self):
        self.backend = FakeBarcodeBackend()
        self.assigned = {}
        self.now = 0.0
        self.inputs = []
        self.statuses = []
        self.errors = []
        self.app = SimpleNamespace(
            receive=lambda lane, value, *, identity: self.inputs.append((lane, value, identity)),
            device_status=lambda lane, state, port, *, identity: self.statuses.append((lane, state, port, identity)),
            frame_error=lambda lane, reason, *, identity: self.errors.append((lane, reason, identity)),
        )
        self.devices = BarcodeDevices(self.app, self.assigned.copy, self.backend, clock=lambda: self.now)

    def test_connected_does_not_imply_actual_frame_and_reads_keep_lane(self):
        a = self.backend.attach("COM5", "SYNTH-A")
        b = self.backend.attach("COM1", "SYNTH-B")
        self.devices.poll()
        self.assertEqual(self.backend.open_attempts, [])
        self.assertEqual(self.devices.ports(), [{"id": a, "port": "COM5", "location": "SYNTH-A"},
                                               {"id": b, "port": "COM1", "location": "SYNTH-B"}])
        self.assigned.update(A=a, B=b)
        self.devices.poll()
        self.assertEqual(self.statuses[-2:], [("A", "connected", "COM5", a), ("B", "connected", "COM1", b)])
        self.assertEqual(self.inputs, [])

        self.backend.feed("COM5", b"\xff\n")
        self.backend.feed("COM1", b"#SYNTH-B\r")
        self.devices.poll()
        self.assertEqual(self.errors, [("A", "decode", a)])
        self.assertEqual(self.inputs, [("B", "SYNTH-B", b)])
        suffixless = "SYNTH-A-1234567890123"
        self.backend.feed("COM5", suffixless.encode())
        self.devices.poll()
        self.assertEqual(self.inputs, [("B", "SYNTH-B", b)])
        self.now = 0.4
        self.devices.poll()
        self.assertEqual(self.inputs, [("B", "SYNTH-B", b), ("A", suffixless, a)])

    def test_assignment_never_opens_com_from_stale_discovery(self):
        old = self.backend.attach("COM5", "SYNTH-OLD")
        self.devices.poll()
        self.assertEqual(self.devices.ports()[0]["id"], old)
        self.backend.detach("COM5")
        new = self.backend.attach("COM5", "SYNTH-NEW")
        self.backend.feed("COM5", b"WRONG-LANE\n")
        self.assigned["A"] = old
        self.now = 0.1
        self.devices.poll()
        self.assertEqual(self.devices.ports()[0]["id"], new)
        self.assertEqual(self.backend.open_attempts, [])
        self.assertEqual(self.inputs, [])
        self.assertIn(("A", "disconnected", "", old), self.statuses)

    def test_com_change_follows_location_and_never_accepts_reused_com(self):
        original = self.assigned["A"] = self.backend.attach("COM5", "SYNTH-A")
        self.devices.poll()
        self.backend.feed("COM5", b"ABANDONED-")
        self.devices.poll()

        self.backend.detach("COM5")
        self.backend.attach("COM5", "DIFFERENT-SCANNER")
        replacement = self.backend.attach("COM17", "SYNTH-A")
        self.assertEqual(replacement, self.assigned["A"])
        self.backend.feed("COM5", b"WRONG-LANE\n")
        self.now = 0.1
        self.devices.poll()
        self.assertEqual(self.statuses[-1], ("A", "fault", "COM5", original))
        self.assertEqual(self.errors, [("A", "partial", original)])
        self.assertEqual(self.inputs, [])

        self.now = 2.0
        self.devices.poll()
        self.assertEqual(self.backend.open_attempts, ["COM5", "COM17"])
        self.assertEqual(self.statuses[-1], ("A", "connected", "COM17", original))
        self.assertEqual(self.inputs, [])
        self.backend.feed("COM17", b"FRESH\n")
        self.devices.poll()
        self.assertEqual(self.inputs, [("A", "FRESH", original)])

    def test_busy_port_retries_at_two_seconds_and_swap_releases_both_handles(self):
        a = self.backend.attach("COM5", "SYNTH-A")
        b = self.backend.attach("COM1", "SYNTH-B")
        self.assigned.update(A=a, B=b)
        self.backend.busy.add("COM5")
        self.devices.poll()
        self.assertIn(("A", "fault", "COM5", a), self.statuses)
        self.backend.busy.clear()
        self.now = 1.99
        self.devices.poll()
        self.assertEqual(self.backend.open_attempts, ["COM5", "COM1"])
        self.now = 2.0
        self.devices.poll()
        self.assertEqual(self.backend.open_attempts, ["COM5", "COM1", "COM5"])

        self.assigned.update(A=b, B=a)
        self.devices.poll()
        self.assertEqual(self.backend.open_attempts, ["COM5", "COM1", "COM5", "COM1", "COM5"])
        self.backend.feed("COM1", b"SYNTH-NEW-A\n")
        self.backend.feed("COM5", b"SYNTH-NEW-B\r")
        self.devices.poll()
        self.assertEqual(self.inputs, [("A", "SYNTH-NEW-A", b), ("B", "SYNTH-NEW-B", a)])

    def test_assignment_changed_while_read_was_in_flight(self):
        old = self.backend.attach("COM5", "SYNTH-OLD-A")
        new = self.backend.attach("COM1", "SYNTH-NEW-A")
        self.assigned["A"] = old
        self.backend.feed("COM5", b"OLD-EVIDENCE\n")
        open_port = self.backend.open

        def open_and_reassign(port):
            connection = open_port(port)
            read = connection.read

            def read_with_reassignment(size):
                data = read(size)
                self.assigned["A"] = new
                return data

            connection.read = read_with_reassignment
            return connection

        with patch.object(self.backend, "open", side_effect=open_and_reassign):
            self.devices.poll()
        self.assertEqual(self.inputs, [])
        self.assertIn(("A", "disconnected", "", new), self.statuses)

        self.backend.feed("COM1", b"NEW-EVIDENCE\n")
        self.devices.poll()
        self.assertEqual(self.inputs, [("A", "NEW-EVIDENCE", new)])

    def test_pyserial_unavailable_is_a_disconnected_state(self):
        devices = BarcodeDevices(self.app, self.assigned.copy)
        with patch.dict(sys.modules, {"serial.tools": None}):
            devices.poll()
        self.assertEqual(devices.ports(), [])
        self.assertEqual(self.statuses, [("A", "disconnected", "", None), ("B", "disconnected", "", None)])
