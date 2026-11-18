from queue import Empty, Queue
import threading
import time
from types import SimpleNamespace
import unittest

from field_agent.weigh.scanner_io import FrameDecoder, ScannerService, detect_scanner_ports, port_identity, resolve_scanner_ports


def port(device, vid=0x26F1, pid=0xD001, serial_number="", location=""):
    return SimpleNamespace(device=device, vid=vid, pid=pid, serial_number=serial_number,
                           location=location, manufacturer="Scanner", product="USB Scanner")


def until(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("Condition did not become true")


class FakeSerial:
    def __init__(self):
        self.input = Queue()
        self.closed = False
        self.read_thread = None
        self.close_thread = None

    def read(self, size):
        self.read_thread = threading.get_ident()
        try:
            item = self.input.get(timeout=0.01)
        except Empty:
            return b""
        if isinstance(item, Exception):
            raise item
        return item

    def close(self):
        self.closed = True
        self.close_thread = threading.get_ident()


class FrameDecoderTests(unittest.TestCase):
    def test_chunk_boundaries_and_cr_lf_do_not_duplicate(self):
        decoder = FrameDecoder()
        self.assertEqual(decoder.feed(b"#TST10000", 0), [])
        frames = decoder.feed(b"001SYN69E0001\r\nSECOND\nTHIRD\r", 0.1)
        self.assertEqual([frame["barcode"] for frame in frames], ["TST10000001SYN69E0001", "SECOND", "THIRD"])
        self.assertEqual(decoder.expire(1), [])

    def test_idle_flushes_once_and_reports_boundary(self):
        decoder = FrameDecoder(idle_seconds=0.4)
        decoder.feed(b"TST10000001SYN69E0001", 0)
        self.assertEqual(decoder.expire(0.3), [])
        frames = decoder.expire(0.5)
        self.assertEqual(frames[0]["framing"], "idle_timeout")
        self.assertEqual(decoder.expire(1), [])

    def test_stale_fragment_not_joined_to_next_scan(self):
        decoder = FrameDecoder()
        decoder.feed(b"FIRST", 0)
        frames = decoder.feed(b"SECOND\r", 1)
        self.assertEqual([frame["barcode"] for frame in frames], ["FIRST", "SECOND"])

    def test_oversized_input_never_becomes_truncated_barcode(self):
        decoder = FrameDecoder(max_frame_bytes=21)
        self.assertEqual(decoder.feed(b"X" * 100000, 0), [])
        self.assertEqual(len(decoder.buffer), 21)
        frames = decoder.feed(b"\rOK\r", 0.1)
        self.assertEqual(frames[0]["reason"], "frame_too_long")
        self.assertEqual(frames[0]["frame_byte_count"], 100000)
        self.assertTrue(frames[0]["raw_truncated"])
        self.assertEqual(len(bytes.fromhex(frames[0]["raw_hex"])), 21)
        self.assertEqual(frames[1]["barcode"], "OK")

    def test_idle_overflow_recovers(self):
        decoder = FrameDecoder(max_frame_bytes=21)
        decoder.feed(b"X" * 22, 0)
        self.assertEqual(decoder.expire(1)[0]["reason"], "frame_too_long")
        self.assertEqual(decoder.feed(b"OK\n", 2)[0]["barcode"], "OK")

    def test_invalid_bytes_are_observed_not_silently_deleted(self):
        decoder = FrameDecoder()
        frames = decoder.feed(b"ABC\xffDEF\rAB\x01CD\r", 0)
        self.assertEqual([frame["reason"] for frame in frames], ["non_ascii", "invalid_control"])
        self.assertTrue(all(frame["type"] == "frame_error" for frame in frames))

    def test_prefix_and_outer_padding_match_handoff(self):
        frames = FrameDecoder().feed(b"\x00 \t#TST10000001SYN69E0001\t\x00\r", 0)
        self.assertEqual(frames[0]["barcode"], "TST10000001SYN69E0001")

    def test_partial_connection_loss_is_error_not_scan(self):
        decoder = FrameDecoder()
        decoder.feed(b"TST100", 0)
        frames = decoder.disconnect()
        self.assertEqual(frames[0]["reason"], "incomplete_disconnect")
        self.assertEqual(decoder.feed(b"NEW\r", 0.1)[0]["barcode"], "NEW")
        self.assertEqual(decoder.disconnect(), [])


class PortResolutionTests(unittest.TestCase):
    def test_discovery_rejects_scale_tower_and_unknown_devices(self):
        ports = [port("COM9", 0x067B, 0x2303), port("COM10", 0x1A86, 0x7523),
                 port("COM3", 0x9999, 0x1111), port("COM20"), port("COM2")]
        self.assertEqual([item.device for item in detect_scanner_ports(ports)], ["COM2", "COM20"])
        self.assertEqual([item.device for item in detect_scanner_ports(ports, ["com2"])], ["COM20"])

    def test_known_scale_tower_cannot_be_explicitly_selected(self):
        config = {"ports": {"A": "COM9", "B": "COM10"}}
        self.assertEqual(resolve_scanner_ports(config, [port("COM9", 0x067B, 1), port("COM10", 0x1A86, 0x7523)]), {"A": "", "B": "", "W": ""})

    def test_one_fresh_scanner_assigns_a_two_require_choice(self):
        self.assertEqual(resolve_scanner_ports({"auto_detect": True}, [port("COM5")]), {"A": "COM5", "B": "", "W": ""})
        self.assertEqual(resolve_scanner_ports({"auto_detect": True}, [port("COM5"), port("COM6")]), {"A": "", "B": "", "W": ""})

    def test_auto_assignment_only_when_enabled(self):
        self.assertEqual(resolve_scanner_ports({}, [port("COM5")]), {"A": "", "B": "", "W": ""})

    def test_unique_remaining_port_fills_other_explicit_lane(self):
        config = {"ports": {"B": "COM6"}, "auto_detect": True}
        self.assertEqual(resolve_scanner_ports(config, [port("COM5"), port("COM6")]), {"A": "COM5", "B": "COM6", "W": ""})

    def test_usb_serial_follows_com_renumbering(self):
        config = {"ports": {"A": "COM5", "B": "COM6"}, "identities": {
            "A": port_identity(port("COM5", serial_number="FIRST")),
            "B": port_identity(port("COM6", serial_number="SECOND"))}}
        self.assertEqual(resolve_scanner_ports(config, [port("COM6", serial_number="FIRST"), port("COM5", serial_number="SECOND")]), {"A": "COM6", "B": "COM5", "W": ""})

    def test_generic_serial_uses_usb_location(self):
        identity = port_identity(port("COM5", serial_number="000000", location="1-2"))
        self.assertNotIn("serial_number", identity)
        config = {"ports": {"A": "COM5"}, "identities": {"A": identity}}
        self.assertEqual(resolve_scanner_ports(config, [port("COM7", location="1-2"), port("COM5", location="1-3")])["A"], "COM7")

    def test_missing_identity_never_steals_reused_com(self):
        config = {"ports": {"A": "COM5"}, "identities": {"A": {"serial_number": "FIRST"}}, "auto_detect": True}
        self.assertEqual(resolve_scanner_ports(config, [port("COM5", serial_number="OTHER")])["A"], "")

    def test_duplicate_explicit_ports_cannot_open_both_lanes(self):
        result = resolve_scanner_ports({"ports": {"A": "COM5", "B": "COM5"}}, [port("COM5")])
        self.assertEqual(result, {"A": "COM5", "B": "", "W": ""})

    def test_ambiguous_stable_identity_does_not_fall_back(self):
        config = {"ports": {"A": "COM5"}, "identities": {"A": {"serial_number": "SAME"}}}
        self.assertEqual(resolve_scanner_ports(config, [port("COM5", serial_number="SAME"), port("COM6", serial_number="SAME")])["A"], "")


class ScannerServiceTests(unittest.TestCase):
    def setUp(self):
        self.handles = []
        self.calls = []
        self.ports = [port("COM5", serial_number="FIRST")]

        def factory(**kwargs):
            handle = FakeSerial()
            self.calls.append(kwargs)
            self.handles.append(handle)
            return handle

        self.service = ScannerService({"ports": {"A": "COM5"}, "retry_seconds": 0.1},
                                      serial_factory=factory, port_provider=lambda: list(self.ports))

    def tearDown(self):
        self.assertTrue(self.service.stop())

    def open(self):
        self.service.start()
        until(lambda: self.service.snapshots()["A"]["port_open"])
        return self.handles[-1]

    def test_constructor_never_touches_hardware(self):
        self.assertEqual(self.calls, [])
        self.assertEqual(self.service.snapshots()["A"]["state"], "stopped")

    def test_open_is_not_verified_scan_idle_does_not_reset(self):
        self.open()
        time.sleep(0.15)
        state = self.service.snapshots()["A"]
        self.assertEqual(state["state"], "open")
        self.assertFalse(state["verified_scan"])
        self.assertEqual(state["bytes_received"], 0)
        self.assertIsNone(state["last_receive_at"])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0], {"port": "COM5", "baudrate": 9600, "bytesize": 8, "parity": "N", "stopbits": 1, "timeout": 0.1})

    def test_raw_receive_separate_from_complete_scan_and_tk_drain(self):
        handle = self.open()
        handle.input.put(b"TST100")
        until(lambda: self.service.snapshots()["A"]["bytes_received"] == 6)
        snapshot = self.service.snapshots()["A"]
        self.assertIsNotNone(snapshot["last_receive_at"])
        self.assertFalse(snapshot["verified_scan"])
        handle.input.put(b"00001SYN69E0001\r\n")
        until(lambda: self.service.snapshots()["A"]["scan_count"] == 1)
        snapshot = self.service.snapshots()["A"]
        self.assertTrue(snapshot["verified_scan"])
        self.assertEqual(snapshot["identity"]["serial_number"], "FIRST")
        frames = [event for event in self.service.drain_events() if event["type"] == "scan"]
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["lane"], "A")
        self.assertEqual(frames[0]["barcode"], "TST10000001SYN69E0001")
        self.assertEqual(frames[0]["bytes_received"], 23)

    def test_worker_queues_every_scan_without_gui_callback(self):
        handle = self.open()
        handle.input.put(b"ONE\r" * 100)
        until(lambda: self.service.snapshots()["A"]["scan_count"] == 100)
        events = self.service.drain_events(limit=500)
        self.assertEqual(sum(event["type"] == "scan" for event in events), 100)
        self.assertEqual(self.service.drain_events(), [])

    def test_partial_disconnect_is_auditable_and_reconnect_not_spliced(self):
        handle = self.open()
        handle.input.put(b"PARTIAL")
        handle.input.put(OSError("USB disconnected"))
        until(lambda: len(self.handles) == 2 and self.service.snapshots()["A"]["port_open"])
        self.assertTrue(handle.closed)
        self.assertEqual(handle.read_thread, handle.close_thread)
        self.handles[1].input.put(b"NEW\r")
        until(lambda: self.service.snapshots()["A"]["scan_count"] == 1)
        events = self.service.drain_events()
        self.assertEqual([event["barcode"] for event in events if event["type"] == "scan"], ["NEW"])
        self.assertEqual([event["reason"] for event in events if event["type"] == "frame_error"], ["incomplete_disconnect"])

    def test_verified_scan_resets_on_new_connection_but_totals_survive(self):
        handle = self.open()
        handle.input.put(b"OK\r")
        until(lambda: self.service.snapshots()["A"]["verified_scan"])
        handle.input.put(OSError("disconnected"))
        until(lambda: len(self.handles) == 2 and self.service.snapshots()["A"]["port_open"])
        snapshot = self.service.snapshots()["A"]
        self.assertFalse(snapshot["verified_scan"])
        self.assertEqual(snapshot["scan_count"], 1)
        self.assertIsNotNone(snapshot["last_scan_at"])

    def test_live_config_change_owned_close_and_no_port_sharing(self):
        old = self.open()
        self.ports.append(port("COM6", serial_number="SECOND"))
        self.service.configure({"ports": {"A": "COM6", "B": "COM5"}, "retry_seconds": 0.1})
        until(lambda: self.service.snapshots()["A"]["port"] == "COM6" and self.service.snapshots()["A"]["port_open"]
              and self.service.snapshots()["B"]["port_open"])
        self.assertTrue(old.closed)
        self.assertEqual(old.read_thread, old.close_thread)
        self.assertEqual(self.service.snapshots()["B"]["port"], "COM5")

    def test_disabled_service_does_not_open(self):
        self.service.configure({"enabled": False, "ports": {"A": "COM5"}})
        self.service.start()
        until(lambda: self.service.snapshots()["A"]["state"] == "paused")
        self.assertEqual(self.calls, [])

    def test_discovery_returns_only_observed_identity(self):
        detected = self.service.detected_ports()
        self.assertEqual(detected[0]["serial_number"], "FIRST")
        self.assertEqual(self.calls, [])

    def test_enumeration_failure_does_not_blindly_open_configured_port(self):
        def fail():
            raise OSError("no inventory")
        self.service._port_provider = fail
        self.service.start()
        until(lambda: self.service.snapshots()["A"]["state"] == "retrying")
        self.assertEqual(self.calls, [])

    def test_two_new_scanners_wait_for_operator_lane_selection(self):
        self.ports.append(port("COM6"))
        self.service.configure({"auto_detect": True})
        self.service.start()
        until(lambda: self.service.snapshots()["A"]["message"] == "lane_selection_required")
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
