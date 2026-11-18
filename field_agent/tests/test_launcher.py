from contextlib import closing
import json
from pathlib import Path
import sqlite3
from time import monotonic, sleep
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch
from tempfile import TemporaryDirectory

from field_agent.launcher import (
    Companion, Launcher, Layout, Monitor, Process, Rect, Window, _arguments,
    browser_size, companion_args, load_layout, placement, prepare_layout, read_launch_status,
    save_layout, select_monitor,
)
from field_agent.ledger import Ledger
from field_agent.protocol import timestamp
from field_agent.runtime import Runtime
from field_agent.tests.test_uploader import FakeTransport
from field_agent.launcher_win32 import (
    SW_RESTORE, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOZORDER, WindowsDesktop,
)


AGENT = r"C:\Release\python.exe"
BROWSER = r"C:\Browser\chrome.exe"
VISION = r"C:\Test Test\pythonw.exe"
WORK = r"C:\Fixture & Vision"
MAIN = Monitor("DISPLAY1", Rect(0, 0, 1920, 1040), primary=True)
SECOND = Monitor("DISPLAY2", Rect(-1600, 50, 1600, 1000), 120)


class SimulatedDesktop:
    def __init__(self):
        self.calls = []
        self.placed = []
        self.focused = []
        self.minimized = []
        self.window_tags = {}
        self.apps = {}
        self.shown = []
        self.services = {}
        self.shortcuts = []
        self.screen = [MAIN, SECOND]
        self.tick = 0
        self.no_window = False
        self.next_pid = 204
        self.unavailable = False
        self.fail_on_position = False

    def browser(self):
        return None if self.unavailable else BROWSER

    def monitors(self):
        return self.screen

    def identify(self, pid):
        return self.apps.get(pid)

    def windows(self):
        return tuple(self.shown)

    def has_process(self, path):
        return any(item.exe == path for item in self.apps.values())

    def spawn(self, args, cwd):
        self.calls.append((args.copy(), str(cwd)))
        pid = self.next_pid
        self.next_pid += 1
        self.apps[pid] = Process(pid, 100000 + pid, args[0])
        if args[0] == AGENT:
            self.services[8769] = {"station_id": "SYNTH", "agent_version": "test"}
        elif "app.py" in args:
            self.services[8724] = {"history": [], "videos": []}
        elif not self.no_window:
            if args[0] == BROWSER:
                title = "现场代理" if any(item.endswith(":8769") for item in args) else "后盖试装记录"
            elif "capture_cell" in args:
                title = "WJ VISION | 质量检验室拍摄单元"
            else:
                title = "WJ Vision | 컨베이어 배치 검사"
            self.shown.append(Window(pid + 2000, pid, title))
        return pid

    def place(self, handle, rect):
        if self.fail_on_position:
            raise OSError
        self.placed.append((handle, rect))

    def focus(self, handle):
        self.focused.append(handle)

    def minimize(self, handle):
        self.minimized.append(handle)

    def mark(self, handle, tag):
        self.window_tags[handle] = tag

    def is_marked(self, handle, tag):
        return self.window_tags.get(handle) == tag

    def shortcut(self, runner, args, cwd, language):
        self.shortcuts.append((runner, args, str(cwd), language))
        return True

    def probe(self, port, predicate):
        return predicate(self.services[port]) if port in self.services else False

    def listening(self, port):
        return port in self.services

    def now(self):
        return self.tick

    def wait(self, delay):
        self.tick += delay


class PlacementTests(TestCase):
    def test_split_uses_physical_work_area_and_odd_width_without_gap(self):
        work = Rect(-1920, 71, 1919, 967)
        self.assertEqual(placement(Layout("split"), work),
                         (Rect(-1920, 71, 959, 967), Rect(-961, 71, 960, 967)))
        self.assertEqual(placement(Layout("split", "right"), work),
                         (Rect(-961, 71, 960, 967), Rect(-1920, 71, 959, 967)))

    def test_full_and_on_demand_agent_use_only_chosen_rectangle(self):
        layout = Layout("companion_full", "right")
        self.assertEqual(placement(layout, MAIN.work), (None, MAIN.work))
        self.assertEqual(placement(layout, MAIN.work, show_agent=True), (Rect(960, 0, 960, 1040), None))
        self.assertEqual(placement(Layout("agent_only"), MAIN.work), (MAIN.work, None))
        layout = Layout("agent_only", agent_size="half")
        self.assertEqual(placement(layout, MAIN.work), (Rect(0, 0, 960, 1040), None))

    def test_secondary_monitor_and_125_percent_browser_hint(self):
        self.assertEqual(select_monitor([SECOND, MAIN], "DISPLAY2"), (SECOND, False))
        self.assertEqual(select_monitor([SECOND, MAIN], "primary"), (MAIN, False))
        self.assertEqual(select_monitor([SECOND, MAIN], "DISPLAY8"), (MAIN, True))
        left, _ = placement(Layout("split"), SECOND.work)
        self.assertEqual(left, Rect(-1600, 50, 800, 1000))
        self.assertEqual(browser_size(left, SECOND.dpi), (640, 800))
        self.assertEqual(browser_size(Rect(0, 0, 960, 1000), 120), (768, 800))

    def test_native_position_passes_signed_coordinates_and_does_not_raise_z_order(self):
        desktop = WindowsDesktop.__new__(WindowsDesktop)
        desktop.exists = Mock(return_value=True)
        desktop.minimized = Mock(return_value=False)
        desktop.maximized = Mock(return_value=True)
        desktop.show = Mock()
        desktop.set_position = Mock(return_value=True)
        rect = Rect(-965, 19, 955, 1001)
        desktop.bounds = Mock(return_value=rect)
        desktop.window_dpi = Mock(return_value=120)
        desktop.place(1234, rect)
        desktop.show.assert_called_once_with(1234, SW_RESTORE)
        desktop.set_position.assert_called_once_with(1234, None, -965, 19, 955, 1001,
                                                     SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)


    def test_native_position_failure_when_window_is_minimum_size_clamped(self):
        desktop = WindowsDesktop.__new__(WindowsDesktop)
        desktop.exists = Mock(return_value=True)
        desktop.minimized = desktop.maximized = Mock(return_value=False)
        desktop.set_position = Mock(return_value=True)
        desktop.bounds = Mock(return_value=Rect(960, 0, 1040, 1040))
        desktop.window_dpi = Mock(return_value=120)
        with patch("field_agent.launcher_win32.monotonic", side_effect=[0, 1.1]):
            with self.assertRaisesRegex(OSError, "did not fit"):
                desktop.place(1234, Rect(960, 0, 960, 1040))


class LaunchTests(TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.desktop = SimulatedDesktop()

    def install(self, profile, kind=None, **kwargs):
        layout = Layout(profile=profile, companion=Companion(kind, VISION, WORK) if kind else None, **kwargs)
        save_layout(self.root, layout)
        return layout

    def run_launcher(self, layout, **kwargs):
        self.assertEqual(load_layout(self.root), layout)
        args = kwargs.pop("agent_args", ())
        shortcut_args = kwargs.pop("shortcut_args", None)
        launcher = Launcher(self.root, layout, self.desktop, AGENT, "SYNTH", "zh", args,
                            shortcut_args=shortcut_args, probe=self.desktop.probe, listening=self.desktop.listening,
                            clock=self.desktop.now, wait=self.desktop.wait, timeout=0.4)
        return launcher.run(**kwargs)

    def test_split_starts_agent_first_places_two_windows_and_does_not_duplicate(self):
        layout = self.install("split", "capture_cell", agent_side="right", monitor="DISPLAY2")
        self.assertTrue(self.run_launcher(layout))
        args = [entry[0] for entry in self.desktop.calls]
        self.assertEqual([entry[0] for entry in args], [AGENT, BROWSER, VISION])
        self.assertIn("--window-size=640,800", args[1])
        self.assertEqual(args[2], [VISION, "-m", "capture_cell", "--connect", "--lang", "zh_CN"])
        self.assertEqual(self.desktop.calls[-1][1], WORK)
        self.assertEqual([bounds for _, bounds in self.desktop.placed],
                         [Rect(-800, 50, 800, 1000), Rect(-1600, 50, 800, 1000)])
        self.assertTrue(self.run_launcher(layout))
        self.assertEqual(len(self.desktop.calls), 3)
        self.assertEqual(len(self.desktop.focused), 2)
        self.assertEqual(read_launch_status(self.root),
                         {"profile": "split", "companion": "ready", "code": None})

    def test_companion_full_opens_only_vision_window_and_preserves_app_flags_in_shortcut(self):
        layout = self.install("companion_full", "backcover_v49")
        cmd, runtime_args, shortcut_args = _arguments(["--data-dir", str(self.root), "--app-config", str(self.root / "w.json"),
                                                       "--app-kind", "weigh"])
        self.assertTrue(self.run_launcher(layout, agent_args=runtime_args, shortcut_args=shortcut_args))
        calls = [entry[0] for entry in self.desktop.calls]
        self.assertEqual([entry[0] for entry in calls], [AGENT, VISION, BROWSER])
        self.assertEqual(calls[0][-2:], ["--weigh-config", str(cmd.app_config.resolve())])
        self.assertEqual(calls[1], [VISION, "app.py", "--no-browser"])
        self.assertIn("--app=http://127.0.0.1:8724", calls[2])
        self.assertEqual([bounds for _, bounds in self.desktop.placed], [MAIN.work])
        args = self.desktop.shortcuts[0][1]
        self.assertIn("--show-agent", args)
        self.assertEqual(args[-4:], ["--app-kind", "weigh", "--app-config", str(cmd.app_config.resolve())])
        self.assertTrue(self.run_launcher(layout, show_agent=True))
        self.assertIn("--app=http://127.0.0.1:8769", self.desktop.calls[-1][0])
        self.assertEqual(self.desktop.placed[-1][1], Rect(0, 0, 960, 1040))
        self.assertEqual(read_launch_status(self.root)["companion"], "ready")

    def test_normal_companion_full_rerun_minimizes_only_owned_agent_window(self):
        layout = self.install("companion_full", "backcover_v49")
        self.assertTrue(self.run_launcher(layout))
        self.assertTrue(self.run_launcher(layout, show_agent=True))
        owned = self.desktop.shown[-1]
        self.desktop.apps[611] = Process(611, 5, BROWSER)
        self.desktop.shown.append(Window(644, 611, owned.title))
        self.assertTrue(self.run_launcher(layout))
        self.assertEqual(self.desktop.minimized, [owned.handle])
        self.assertEqual(len(self.desktop.calls), 4)

    def test_unrelated_listener_never_spawns_a_second_backcover(self):
        layout = self.install("companion_full", "backcover_v49")
        self.desktop.services[8724] = {"history": []}
        self.assertTrue(self.run_launcher(layout))
        self.assertEqual([entry[0][0] for entry in self.desktop.calls], [AGENT])
        self.assertEqual(read_launch_status(self.root),
                         {"profile": "companion_full", "companion": "failed", "code": "companion_start_failed"})

    def test_external_native_existing_window_requires_process_match(self):
        layout = self.install("split", "capture_cell")
        self.desktop.apps[100] = Process(100, 27, VISION)
        self.desktop.shown.append(Window(200, 100, "WJ VISION | 质量检验室拍摄单元"))
        self.assertTrue(self.run_launcher(layout))
        self.assertEqual([entry[0][0] for entry in self.desktop.calls], [AGENT, BROWSER])
        self.assertEqual(self.desktop.placed[-1], (200, Rect(960, 0, 960, 1040)))

    def test_changed_companion_keeps_running_original_process(self):
        layout = self.install("companion_full", "batch_inspection")
        self.assertTrue(self.run_launcher(layout))
        new = self.install("split", "capture_cell")
        self.assertTrue(self.run_launcher(new))
        self.assertEqual(len(self.desktop.calls), 3)
        self.assertEqual(read_launch_status(self.root)["code"], "companion_conflict")

    def test_stale_record_does_not_reuse_pid(self):
        layout = self.install("split", "capture_cell")
        self.assertTrue(self.run_launcher(layout))
        pid = 206
        self.desktop.apps[pid] = Process(pid, 17, r"C:\Other\unrelated.exe")
        self.desktop.shown = [item for item in self.desktop.shown if item.pid != pid]
        self.assertTrue(self.run_launcher(layout))
        self.assertEqual(self.desktop.calls[-1][0][0], VISION)
        self.assertEqual(read_launch_status(self.root)["companion"], "ready")

    def test_layout_validates_before_write_and_public_state_filters_paths(self):
        target = self.root / "incoming.json"
        target.write_text(json.dumps({"profile": "split", "agent_side": "right", "monitor": "DISPLAY2",
                                      "companion": {"kind": "capture_cell", "python": VISION, "work_dir": WORK}}))
        layout = prepare_layout(target)
        save_layout(self.root, layout)
        self.assertEqual(load_layout(self.root), layout)
        target.write_text(json.dumps({"profile": "split", "companion": {"kind": "capture_cell",
                                                                       "python": "python.exe", "work_dir": WORK}}))
        with self.assertRaises(ValueError):
            prepare_layout(target)
        self.assertEqual(load_layout(self.root), layout)
        (self.root / "launcher-status.json").write_text(json.dumps({
            "profile": "split", "companion": "failed", "code": "browser_unavailable",
            "path": VISION, "pid": 9912,
        }))
        self.assertEqual(read_launch_status(self.root),
                         {"profile": "split", "companion": "failed", "code": "browser_unavailable"})

    def test_only_supported_vision_launch_flags(self):
        self.assertEqual(companion_args(Companion("backcover_v49", VISION, WORK), "zh"),
                         [VISION, "app.py", "--no-browser"])
        self.assertEqual(companion_args(Companion("capture_cell", VISION, WORK), "ko"),
                         [VISION, "-m", "capture_cell", "--connect", "--lang", "ko"])
        self.assertEqual(companion_args(Companion("batch_inspection", VISION, WORK), "zh"),
                         [VISION, "-m", "batch_inspection", "--connect"])

    def test_real_spawn_adapter_passes_arrays_with_shell_disabled(self):
        program = self.root / "With Space & Symbol.exe"
        program.touch()
        with patch("field_agent.launcher_win32.subprocess.Popen", return_value=SimpleNamespace(pid=81)) as popen:
            args = [str(program), "-m", "capture_cell", "--lang", "zh_CN"]
            self.assertEqual(WindowsDesktop.spawn(args, self.root), 81)
        self.assertEqual(popen.call_args.args[0], args)
        self.assertIs(popen.call_args.kwargs["shell"], False)
        self.assertEqual(popen.call_args.kwargs["cwd"], str(self.root))

    def test_companion_full_real_runtime_collects_and_sends_without_agent_browser(self):
        layout = self.install("companion_full", "backcover_v49")
        source = self.root / "fixture.db"
        with closing(sqlite3.connect(source)) as conn, conn:
            conn.execute("""CREATE TABLE barcodes(id INTEGER PRIMARY KEY, time TEXT, scanner TEXT,
                barcode TEXT, status TEXT, product_size TEXT, product_group TEXT)""")
            conn.execute("INSERT INTO barcodes VALUES(?,?,?,?,?,?,?)",
                         (1, timestamp()[:19].replace("T", " "), "A", "SYNTH-ABC", "ok", "", ""))
        ledger = Ledger(self.root / "ledger.sqlite3", "SYNTH")
        self.addCleanup(ledger.close)
        transport = FakeTransport()
        runtime = Runtime(ledger, transport, port=0, legacy_barcode_db=source)
        self.addCleanup(runtime.stop)
        original_spawn = self.desktop.spawn

        def process_start(args, cwd):
            if args[0] == AGENT:
                runtime.start()
            return original_spawn(args, cwd)

        self.desktop.spawn = process_start
        self.assertTrue(self.run_launcher(layout, agent_args=("--legacy-barcode-db", str(source))))
        limit = monotonic() + 4
        while monotonic() < limit:
            if transport.requests_for("heartbeat") and transport.requests_for("ingest"):
                break
            sleep(0.025)
        heartbeats = [json.loads(body) for body in transport.requests_for("heartbeat")]
        sent = [evt for body in transport.requests_for("ingest") for evt in json.loads(body)["events"]]
        self.assertTrue(heartbeats)
        self.assertTrue(any(evt["type"] == "scan.recorded" and evt["barcode"] == "SYNTH-ABC" for evt in sent))
        self.assertFalse(any("--app=http://127.0.0.1:8769" in args for args, _ in self.desktop.calls))

    def test_late_companion_failure_preserves_agent_browser(self):
        layout = self.install("split", "capture_cell")
        spawn = self.desktop.spawn

        def no_companion_window(args, cwd):
            self.desktop.no_window = "capture_cell" in args
            return spawn(args, cwd)

        self.desktop.spawn = no_companion_window
        self.assertTrue(self.run_launcher(layout))
        self.assertEqual(len(self.desktop.focused), 1)
        self.assertEqual(self.desktop.tick, 0.4)
        self.assertEqual(read_launch_status(self.root)["code"], "companion_window_missing")


    def test_jig_and_uv_install_only_as_full_screen(self):
        target = self.root / "incoming.json"
        for kind in ("backcover_v49", "batch_inspection"):
            with self.subTest(kind=kind):
                raw = {"profile": "split", "companion": {"kind": kind, "python": VISION, "work_dir": WORK}}
                target.write_text(json.dumps(raw))
                with self.assertRaisesRegex(ValueError, "companion_full"):
                    prepare_layout(target)
                target.write_text(json.dumps(dict(raw, profile="companion_full")))
                self.assertEqual(prepare_layout(target).profile, "companion_full")
        layout = self.install("companion_full", "batch_inspection")
        self.assertTrue(self.run_launcher(layout))
        self.assertEqual([entry[0][0] for entry in self.desktop.calls], [AGENT, VISION])
        self.assertEqual([bounds for _, bounds in self.desktop.placed], [MAIN.work])

    def test_current_uv_minimum_does_not_move_oversize_companion_on_small_display(self):
        self.desktop.screen = [Monitor("DISPLAY1", Rect(0, 0, 960, 1040), primary=True)]
        layout = self.install("companion_full", "batch_inspection")
        self.assertTrue(self.run_launcher(layout))
        self.assertEqual(len(self.desktop.shown), 1)
        self.assertEqual(self.desktop.placed, [])
        self.assertEqual(read_launch_status(self.root)["code"], "companion_position_failed")
