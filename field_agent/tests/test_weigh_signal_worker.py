import threading
import time
import unittest
from unittest.mock import MagicMock, patch

from field_agent.weigh.signal_worker import SignalWorker
from field_agent.weigh.hardware_io import HardwareError


class SignalWorkerTests(unittest.TestCase):
    def make_worker(self, device=None):
        device = device or MagicMock()
        with patch("field_agent.weigh.signal_worker.create_signal", return_value=device) as factory:
            worker = SignalWorker({"light_mode": "virtual"})
        factory.assert_called_once_with({"light_mode": "virtual"})
        self.addCleanup(worker.close)
        return worker, device

    def test_construction_sends_no_command_and_close_releases_once(self):
        worker, device = self.make_worker()
        device.set_state.assert_not_called()
        self.assertTrue(worker.close())
        self.assertTrue(worker.close())
        device.set_state.assert_not_called()
        device.close.assert_called_once()

    def test_repeated_ui_refresh_does_not_restart_buzzer(self):
        sent = threading.Event()
        worker, device = self.make_worker()
        device.set_state.side_effect = lambda *args: sent.set()
        self.assertTrue(worker.set_state("red", "ng"))
        self.assertTrue(sent.wait(1))
        for _ in range(50):
            self.assertFalse(worker.set_state("red", "ng"))
            self.assertFalse(worker.set_state("red", "off"))
        self.assertTrue(worker.close())
        device.set_state.assert_called_once_with("red", "ng")

    def test_new_load_transition_can_play_the_same_alarm_again(self):
        sent = threading.Event()
        worker, device = self.make_worker()
        device.set_state.side_effect = lambda *args: sent.set()
        for state in (("red", "ng"), ("yellow", "off"), ("red", "ng")):
            sent.clear()
            self.assertTrue(worker.set_state(*state))
            self.assertTrue(sent.wait(1))
        worker.close()
        self.assertEqual([call.args for call in device.set_state.call_args_list],
                         [("red", "ng"), ("yellow", "off"), ("red", "ng")])

    def test_slow_device_keeps_only_latest_pending_state(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        calls = []
        def send(*command):
            calls.append(command)
            if len(calls) == 1:
                entered.set()
                release.wait(2)
            else:
                finished.set()
        device = MagicMock()
        device.set_state.side_effect = send
        worker, _ = self.make_worker(device)
        self.addCleanup(release.set)
        worker.set_state("yellow")
        self.assertTrue(entered.wait(1))
        for _ in range(100):
            worker.set_state("green", "ok")
            worker.set_state("red", "ng")
        worker.set_state("off")
        release.set()
        self.assertTrue(finished.wait(1))
        worker.close()
        self.assertEqual(calls, [("yellow", "off"), ("off", "off")])

    def test_error_latches_and_fifty_more_ticks_cannot_retry(self):
        device = MagicMock()
        device.set_state.side_effect = OSError("USB disconnected")
        worker, _ = self.make_worker(device)
        worker.set_state("yellow")
        worker.thread.join(timeout=1)
        self.assertFalse(worker.thread.is_alive())
        self.assertIn("USB disconnected", worker.error)
        for _ in range(50):
            self.assertFalse(worker.set_state("red", "ng"))
            self.assertFalse(worker.set_state("yellow"))
        device.set_state.assert_called_once_with("yellow", "off")
        device.close.assert_called_once()

    def test_close_discards_pending_alarm_and_releases_after_inflight_write(self):
        entered, release = threading.Event(), threading.Event()
        def send(*command):
            entered.set()
            release.wait(2)
        device = MagicMock()
        device.set_state.side_effect = send
        worker, _ = self.make_worker(device)
        self.addCleanup(release.set)
        worker.set_state("yellow")
        self.assertTrue(entered.wait(1))
        worker.set_state("red", "ng")
        self.assertFalse(worker.close(timeout=0))
        self.assertFalse(worker.set_state("green", "ok"))
        release.set()
        self.assertTrue(worker.close())
        device.set_state.assert_called_once_with("yellow", "off")
        device.close.assert_called_once()

    def test_close_failure_is_reported_without_replacing_first_error(self):
        device = MagicMock()
        device.set_state.side_effect = OSError("original write failure")
        device.close.side_effect = OSError("close failed")
        worker, _ = self.make_worker(device)
        worker.set_state("red", "ng")
        worker.thread.join(timeout=1)
        self.assertEqual(worker.error, "original write failure")
        worker.close()
        device.close.assert_called_once()

    def test_hardware_error_code_and_details_survive_worker_for_diagnostics(self):
        device = MagicMock()
        failure = HardwareError("SIGNAL_OPEN_FAILED", "Access denied")
        failure.details = {"port": "COM8", "reason": "Access denied"}
        device.set_state.side_effect = failure
        device.close.side_effect = OSError("secondary close error")
        worker, _ = self.make_worker(device)
        worker.set_state("yellow")
        worker.thread.join(timeout=1)
        self.assertEqual(worker.error_code, "SIGNAL_OPEN_FAILED")
        self.assertEqual(worker.error_details, failure.details)
        self.assertIn("Access denied", worker.error)

    def test_ack_recovery_clears_structured_error(self):
        failure = HardwareError("SIGNAL_NOT_FOUND", "USB missing")
        failure.details = {"port": "COM8"}
        released = threading.Event()
        device = MagicMock(supports_reconnect=True)
        calls = []
        def send(*command):
            calls.append(command)
            if len(calls) == 1:
                raise failure
            released.wait(1)
        device.set_state.side_effect = send
        with patch("field_agent.weigh.signal_worker.RECONNECT_INITIAL_SECONDS", .02):
            worker, _ = self.make_worker(device)
        self.addCleanup(released.set)
        worker.set_state("yellow")
        self.wait_for_error(worker)
        self.assertEqual(worker.error_code, "SIGNAL_NOT_FOUND")
        released.set()
        self.wait_for_error(worker, present=False)
        self.assertIsNone(worker.error_code)
        self.assertEqual(worker.error_details, {})

    def test_close_alone_reports_failure_to_turn_hardware_off(self):
        device = MagicMock()
        device.close.side_effect = OSError("all-off send failed")
        worker, _ = self.make_worker(device)
        self.assertTrue(worker.close())
        self.assertEqual(worker.error, "all-off send failed")

    def wait_for_error(self, worker, present=True):
        with worker._condition:
            self.assertTrue(worker._condition.wait_for(
                lambda: (worker.error is not None) == present, timeout=1))

    def test_reconnect_latest_color_without_replaying_buzzer_clears_error_only_after_ack(self):
        recovering, release = threading.Event(), threading.Event()
        calls = []
        def send(*command):
            calls.append(command)
            if len(calls) == 1:
                raise OSError("USB disconnected")
            recovering.set()
            release.wait(1)
        device = MagicMock(supports_reconnect=True)
        device.set_state.side_effect = send
        with patch("field_agent.weigh.signal_worker.RECONNECT_INITIAL_SECONDS", 0.05):
            worker, _ = self.make_worker(device)
        self.addCleanup(release.set)
        worker.set_state("red", "ng")
        self.wait_for_error(worker)
        for _ in range(50):
            worker.set_state("red", "ng")
        worker.set_state("green", "ok")
        self.assertTrue(recovering.wait(1))
        self.assertEqual(worker.error, "USB disconnected")
        self.assertEqual(calls, [("red", "ng"), ("green", "off")])
        release.set()
        self.wait_for_error(worker, present=False)
        self.assertFalse(worker.set_state("green", "ok"))
        worker.close()
        self.assertEqual(len(calls), 2)

    def test_reconnect_occurs_without_another_ui_update(self):
        reconnected = threading.Event()
        device = MagicMock(supports_reconnect=True)
        attempts = []
        def send(*command):
            attempts.append(command)
            if len(attempts) == 1:
                raise PermissionError("stale USB handle")
            reconnected.set()
        device.set_state.side_effect = send
        with patch("field_agent.weigh.signal_worker.RECONNECT_INITIAL_SECONDS", 0.02):
            worker, _ = self.make_worker(device)
        worker.set_state("yellow")
        self.assertTrue(reconnected.wait(1))
        self.wait_for_error(worker, present=False)
        worker.close()
        self.assertEqual(attempts, [("yellow", "off"), ("yellow", "off")])

    def test_failed_reconnect_has_capped_backoff_not_ui_tick_retry(self):
        fourth_attempt = threading.Event()
        device = MagicMock(supports_reconnect=True)
        times = []
        def send(*command):
            times.append(time.monotonic())
            if len(times) == 4:
                fourth_attempt.set()
            raise OSError("still disconnected")
        device.set_state.side_effect = send
        with patch("field_agent.weigh.signal_worker.RECONNECT_INITIAL_SECONDS", 0.03), \
                patch("field_agent.weigh.signal_worker.RECONNECT_MAX_SECONDS", 0.06):
            worker, _ = self.make_worker(device)
            worker.set_state("yellow")
            self.wait_for_error(worker)
            for _ in range(50):
                worker.set_state("red", "ng")
                worker.set_state("yellow")
            self.assertEqual(len(times), 1)
            self.assertTrue(fourth_attempt.wait(1))
            worker.close()
        self.assertEqual(len(times), 4)
        for interval, minimum in zip([b - a for a, b in zip(times, times[1:])],
                                     (0.025, 0.055, 0.055)):
            self.assertGreaterEqual(interval, minimum)
        self.assertEqual(worker.error, "still disconnected")

    def test_close_during_reconnect_wait_cancels_reopen(self):
        device = MagicMock(supports_reconnect=True)
        device.set_state.side_effect = OSError("disconnected")
        worker, _ = self.make_worker(device)
        worker.set_state("red", "ng")
        self.wait_for_error(worker)
        self.assertTrue(worker.close())
        self.assertFalse(worker.set_state("green", "ok"))
        device.set_state.assert_called_once_with("red", "ng")
        device.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
