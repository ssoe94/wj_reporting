"""Place one field station and its selected companion on a Windows desktop."""

import argparse
from dataclasses import asdict, dataclass
from hashlib import sha256
import json
from pathlib import Path, PureWindowsPath
import re
import socket
import sys
from time import monotonic, sleep
from urllib.error import URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener

from .config import LanguagePreferences, _atomic_file, _limited_read, _stored_config
from .protocol import encode


_LAYOUT = "window-layout.json"
_STATUS = "launcher-status.json"
_PROCESSES = "launcher-processes.json"
_AGENT_PORT = 8769
_BACKCOVER_PORT = 8724
_PROFILES = ("split", "companion_full", "agent_only")
_COMPANIONS = ("backcover_v49", "capture_cell", "batch_inspection")
_FULL_SCREEN_COMPANIONS = {"backcover_v49", "batch_inspection"}
_STATES = ("none", "waiting", "ready", "failed")
_CODES = ("monitor_defaulted", "companion_start_failed", "companion_window_missing",
          "companion_position_failed", "companion_conflict", "browser_unavailable")
_MONITOR = re.compile(r"[A-Z0-9_-]{1,32}", re.ASCII)
_BROWSER_TITLES = {
    "agent_window": {"현장 에이전트", "现场代理"},
    "companion_window": {"백커버 작업 확인", "后盖试装记录"},
}
_BROWSER_SUFFIXES = (" - Google Chrome", " - Microsoft Edge")
_NATIVE_TITLES = {
    "capture_cell": {"WJ VISION | 품질 검사실 촬영 셀", "WJ VISION | 质量检验室拍摄单元"},
    "batch_inspection": {"WJ Vision | 컨베이어 배치 검사"},
}


@dataclass(frozen=True)
class Companion:
    kind: str
    python: str
    work_dir: str


@dataclass(frozen=True)
class Layout:
    profile: str = "agent_only"
    agent_side: str = "left"
    agent_size: str = "full"
    monitor: str = "primary"
    companion: Companion = None


@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class Monitor:
    name: str
    work: Rect
    dpi: int = 96
    primary: bool = False


@dataclass(frozen=True)
class Process:
    pid: int
    started: int
    exe: str


@dataclass(frozen=True)
class Window:
    handle: int
    pid: int
    title: str


def _local_path(value, *, exe=False):
    if not isinstance(value, str) or not value or len(value) > 512 or not value.isprintable() or '"' in value:
        raise ValueError("Invalid launcher path")
    path = PureWindowsPath(value)
    if not path.is_absolute() or not re.fullmatch(r"[A-Za-z]:", path.drive) or ".." in path.parts:
        raise ValueError("Launcher paths must be absolute Windows drive paths")
    if exe and path.suffix.lower() != ".exe":
        raise ValueError("Companion executable must end in .exe")
    return str(path)


def _parse_layout(data):
    if not isinstance(data, dict) or set(data) - {"profile", "agent_side", "agent_size", "monitor", "companion"}:
        raise ValueError("Invalid launcher settings")
    profile = data.get("profile", "agent_only")
    side = data.get("agent_side", "left")
    size = data.get("agent_size", "full")
    monitor = data.get("monitor", "primary")
    if (profile not in _PROFILES or side not in ("left", "right") or size not in ("full", "half")
            or not isinstance(monitor, str) or (monitor != "primary" and not _MONITOR.fullmatch(monitor))):
        raise ValueError("Invalid launcher profile, side, size or display name")
    companion = data.get("companion")
    if profile == "agent_only":
        if companion is not None:
            raise ValueError("agent_only does not start a companion")
    else:
        if (not isinstance(companion, dict) or set(companion) != {"kind", "python", "work_dir"}
                or companion.get("kind") not in _COMPANIONS):
            raise ValueError("Select a supported companion")
        if companion["kind"] in _FULL_SCREEN_COMPANIONS and profile != "companion_full":
            raise ValueError("The jig and UV inspection apps require companion_full")
        companion = Companion(companion["kind"], _local_path(companion["python"], exe=True),
                              _local_path(companion["work_dir"]))
    return Layout(profile, side, size, monitor, companion)


def prepare_layout(path):
    """Read and validate an installation layout before any config is written."""
    return _parse_layout(json.loads(_limited_read(path, 4096).decode("utf-8-sig")))


def load_layout(data_dir):
    try:
        return prepare_layout(Path(data_dir) / _LAYOUT)
    except FileNotFoundError:
        return Layout()


def save_layout(data_dir, prepared):
    """Save a prepared layout independently of connection credentials."""
    root = Path(data_dir)
    _atomic_file(root / _LAYOUT, encode(asdict(prepared)))
    (root / _STATUS).unlink(missing_ok=True)


def read_launch_status(data_dir):
    """Return only local UI status codes, without a device identity or path."""
    root = Path(data_dir)
    try:
        profile = load_layout(root).profile
    except (OSError, ValueError):
        profile = "agent_only"
    result = {"profile": profile, "companion": "none", "code": None}
    if profile == "agent_only":
        return result
    result["companion"] = "waiting"
    try:
        status = json.loads(_limited_read(root / _STATUS, 512).decode("utf-8"))
        if (isinstance(status, dict) and status.get("profile") == profile
                and status.get("companion") in _STATES and status.get("code") in (None,) + _CODES):
            result["companion"], result["code"] = status["companion"], status["code"]
    except (OSError, ValueError):
        pass
    return result


def select_monitor(monitors, name):
    primary = next((item for item in monitors if item.primary), None)
    if primary is None:
        raise ValueError("No primary display")
    if name == "primary":
        return primary, False
    selected = next((item for item in monitors if item.name == name), None)
    return (selected, False) if selected is not None else (primary, True)


def placement(layout, work, *, show_agent=False):
    """Calculate physical Win32 outer bounds from the chosen monitor's work area."""
    if work.width < 2 or work.height < 1:
        raise ValueError("Invalid display work area")
    half = work.width // 2
    left = Rect(work.x, work.y, half, work.height)
    right = Rect(work.x + half, work.y, work.width - half, work.height)
    agent, other = (left, right) if layout.agent_side == "left" else (right, left)
    if show_agent:
        return (work if layout.profile == "agent_only" and layout.agent_size == "full" else agent), None
    if layout.profile == "companion_full":
        return None, work
    if layout.profile == "agent_only":
        return (work if layout.agent_size == "full" else agent), None
    return agent, other


def browser_size(rect, dpi):
    """Chromium size hint in device-independent pixels. Win32 settles final bounds."""
    if dpi <= 0:
        raise ValueError("Invalid screen DPI")
    return max(1, round(rect.width * 96 / dpi)), max(1, round(rect.height * 96 / dpi))


def _identity_path(path):
    return str(PureWindowsPath(str(path))).casefold()


def _matches(process, executable):
    return process is not None and _identity_path(process.exe) == _identity_path(executable)


def companion_args(companion, language):
    if companion.kind == "backcover_v49":
        return [companion.python, "app.py", "--no-browser"]
    args = [companion.python, "-m", companion.kind, "--connect"]
    if companion.kind == "capture_cell":
        args += ["--lang", "zh_CN" if language == "zh" else "ko"]
    return args


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _probe(port, predicate):
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    try:
        with opener.open("http://127.0.0.1:{}/api/status".format(port), timeout=0.3) as response:
            body = response.read(512 * 1024 + 1)
            if len(body) <= 512 * 1024:
                data = json.loads(body.decode("utf-8"))
                return isinstance(data, dict) and predicate(data)
    except (OSError, URLError, ValueError):
        pass
    return False


def _listening(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


class Launcher:
    """Injected desktop and probes isolate subprocess and Win32 effects from tests."""

    def __init__(self, root, layout, desktop, runner, station, language, agent_args=(), *,
                 shortcut_args=None, probe=_probe, listening=_listening, clock=monotonic, wait=sleep, timeout=12):
        self.root = Path(root)
        self.layout = layout
        self.desktop = desktop
        self.runner = str(runner)
        self.station = station
        self.language = language
        self.agent_args = tuple(agent_args)
        self.shortcut_args = tuple(shortcut_args if shortcut_args is not None else agent_args)
        self.probe, self.listening = probe, listening
        self.now, self.wait, self.timeout = clock, wait, timeout
        self.launch_file = self.root / _PROCESSES
        self.records = self._read_records()
        self.tag = sha256(_identity_path(self.root).encode()).hexdigest()[:24]
        self.cwd = Path(__file__).resolve().parents[1]
        self.monitor_fallback = False

    def _read_records(self):
        try:
            data = json.loads(_limited_read(self.launch_file, 8192).decode("utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save_process(self, role, process, key):
        self.records[role] = {"pid": process.pid, "started": process.started, "exe": process.exe, "key": key}
        _atomic_file(self.launch_file, encode(self.records))

    def _process(self, role):
        record = self.records.get(role)
        if (not isinstance(record, dict) or type(record.get("pid")) is not int
                or record["pid"] <= 0 or type(record.get("started")) is not int
                or not isinstance(record.get("exe"), str) or not isinstance(record.get("key"), str)):
            return None, None
        current = self.desktop.identify(record["pid"])
        if _matches(current, record["exe"]) and current.started == record["started"]:
            return current, record["key"]
        return None, None

    def _until(self, check):
        deadline = self.now() + self.timeout
        while True:
            result = check()
            if result or self.now() >= deadline:
                return result
            self.wait(min(0.2, max(0, deadline - self.now())))

    def _start(self, role, args, cwd, key):
        pid = self.desktop.spawn(args, cwd)
        process = self.desktop.identify(pid)
        if _matches(process, args[0]):
            self._save_process(role, process, key)
        return process if _matches(process, args[0]) else None

    def _agent_ready(self):
        def station_status(data):
            return data.get("station_id") == self.station and bool(data.get("agent_version"))

        if self.probe(_AGENT_PORT, station_status):
            return True
        if not self.listening(_AGENT_PORT) and self._process("agent_process")[0] is None:
            self._start("agent_process", [self.runner, "-m", "field_agent", "run", "--data-dir", str(self.root),
                        "--port", str(_AGENT_PORT), *self.agent_args], self.cwd, "agent")
        return bool(self._until(lambda: self.probe(_AGENT_PORT, station_status)))

    def _status(self, state, code=None):
        _atomic_file(self.root / _STATUS, encode({
            "profile": self.layout.profile, "companion": state, "code": code,
        }))

    def _marked_window(self, tag, exe):
        return next((window for window in self.desktop.windows()
                     if self.desktop.is_marked(window.handle, tag)
                     and _matches(self.desktop.identify(window.pid), exe)), None)

    def _pid_window(self, process, titles, *, browser=False):
        if self.desktop.identify(process.pid) != process:
            return None
        approved = titles | {title + suffix for title in titles for suffix in _BROWSER_SUFFIXES} if browser else titles
        return next((win for win in self.desktop.windows()
                     if win.pid == process.pid and win.title in approved), None)

    def _position(self, window, tag, rect):
        try:
            self.desktop.place(window.handle, rect)
        except OSError:
            return False
        self.desktop.mark(window.handle, tag)
        return True

    def _browser_window(self, role, port, rect, dpi):
        browser = self.desktop.browser()
        if not browser:
            return "browser_unavailable"
        tag = self.tag + role
        window = self._marked_window(tag, browser)
        process, key = self._process(role)
        if process is not None and key != "browser:" + str(port):
            return "companion_conflict"
        if window is None:
            if process is None:
                profile = self.root / ("browser-profile" if role == "agent_window" else "companion-browser-profile")
                width, height = browser_size(rect, dpi)
                args = [browser, "--user-data-dir=" + str(profile), "--app=http://127.0.0.1:{}".format(port),
                        "--window-size={},{}".format(width, height), "--autoplay-policy=no-user-gesture-required",
                        "--no-first-run", "--no-default-browser-check", "--disable-background-mode"]
                process = self._start(role, args, self.cwd, "browser:" + str(port))
            if process is not None:
                window = self._until(lambda: self._pid_window(process, _BROWSER_TITLES[role], browser=True))
        if window is None:
            return "companion_window_missing"
        if not self._position(window, tag, rect):
            return "companion_position_failed"
        if role == "agent_window":
            self.desktop.focus(window.handle)
        return None

    def _backcover(self, companion, rect, dpi):
        def available(data):
            return isinstance(data.get("history"), list) and isinstance(data.get("videos"), list)

        backend, key = self._process("backend")
        desired = "backcover:" + _identity_path(companion.work_dir)
        if backend is not None and key != desired:
            return "companion_conflict"
        if not self.probe(_BACKCOVER_PORT, available):
            if backend is None and not self.listening(_BACKCOVER_PORT):
                self._start("backend", companion_args(companion, self.language), companion.work_dir, desired)
            if not self._until(lambda: self.probe(_BACKCOVER_PORT, available)):
                return "companion_start_failed"
        return self._browser_window("companion_window", _BACKCOVER_PORT, rect, dpi)

    def _native(self, companion, rect, dpi):
        role = "companion_window"
        desired = companion.kind + ":" + _identity_path(companion.work_dir)
        process, key = self._process(role)
        if process is not None and key != desired:
            return "companion_conflict"
        tag = self.tag + sha256(desired.encode()).hexdigest()[:24]
        window = self._marked_window(tag, companion.python)
        if window is None and process is None:
            matches = [item for item in self.desktop.windows()
                       if item.title in _NATIVE_TITLES[companion.kind]]
            if matches:
                # Some external instances predate this launcher. Never start a
                # second camera owner while there is a conflicting main window.
                if len(matches) != 1 or not _matches(self.desktop.identify(matches[0].pid), companion.python):
                    return "companion_conflict"
                window = matches[0]
                self._save_process(role, self.desktop.identify(window.pid), desired)
            elif self.desktop.has_process(companion.python):
                # An external process may still be starting, without a main
                # window or a verifiable module identity.
                return "companion_conflict"
            else:
                process = self._start(role, companion_args(companion, self.language), companion.work_dir, desired)
        if window is None and process is not None:
            window = self._until(lambda: self._pid_window(process, _NATIVE_TITLES[companion.kind]))
        if window is None:
            return "companion_window_missing"
        # The current UV window's Qt minimum is specified in logical pixels.
        # Preserve its original location when this layout cannot fit it.
        if companion.kind == "batch_inspection":
            width, height = browser_size(rect, dpi)
            if width < 1040 or height < 690:
                return "companion_position_failed"
        return None if self._position(window, tag, rect) else "companion_position_failed"

    def _minimize_agent(self):
        role = "agent_window"
        process, key = self._process(role)
        if process is None or key != "browser:" + str(_AGENT_PORT):
            return
        window = self._pid_window(process, _BROWSER_TITLES[role], browser=True)
        if window is not None:
            self.desktop.minimize(window.handle)

    def _shortcut(self):
        args = ["-m", "field_agent.launcher", "--data-dir", str(self.root), "--show-agent", *self.shortcut_args]
        return self.desktop.shortcut(self.runner, args, self.cwd, self.language)

    def run(self, *, show_agent=False, shortcut=True):
        try:
            agent_live = self._agent_ready()
        except (OSError, ValueError):
            agent_live = False
        monitor, self.monitor_fallback = select_monitor(self.desktop.monitors(), self.layout.monitor)
        agent_rect, companion_rect = placement(self.layout, monitor.work, show_agent=show_agent)
        window_ready = True
        if agent_live and agent_rect is not None:
            try:
                window_ready = self._browser_window("agent_window", _AGENT_PORT, agent_rect, monitor.dpi) is None
            except (OSError, ValueError):
                window_ready = False
        if show_agent:
            return agent_live and window_ready
        if agent_live and agent_rect is None:
            self._minimize_agent()
        if companion_rect is not None:
            self._status("waiting")
            try:
                companion = self.layout.companion
                if companion.kind == "backcover_v49":
                    reason = self._backcover(companion, companion_rect, monitor.dpi)
                else:
                    reason = self._native(companion, companion_rect, monitor.dpi)
            except OSError:
                reason = "companion_start_failed"
            self._status("failed" if reason else "ready", reason or ("monitor_defaulted" if self.monitor_fallback else None))
        else:
            self._status("none")
        if agent_rect is None and shortcut:
            try:
                shortcut_ready = self._shortcut()
            except OSError:
                shortcut_ready = False
            return agent_live and shortcut_ready
        return agent_live and window_ready


def _arguments(argv):
    parser = argparse.ArgumentParser(description="WJ field station window launcher")
    parser.add_argument("--data-dir", type=Path, required=True)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--app-config", type=Path)
    group.add_argument("--legacy-barcode-db", type=Path)
    group.add_argument("--legacy-weigh-dbs", type=Path, nargs=2)
    parser.add_argument("--app-kind", choices=("barcode", "weigh"))
    parser.add_argument("--show-agent", action="store_true")
    args = parser.parse_args(argv)
    if args.app_kind and not args.app_config:
        parser.error("--app-kind requires --app-config")
    if args.app_config:
        app_kind = args.app_kind or "barcode"
        agent = ["--" + app_kind + "-config", str(args.app_config.resolve())]
        shortcut = ["--app-kind", app_kind, "--app-config", str(args.app_config.resolve())]
    elif args.legacy_barcode_db:
        agent = ["--legacy-barcode-db", str(args.legacy_barcode_db.resolve())]
        shortcut = agent
    elif args.legacy_weigh_dbs:
        agent = ["--legacy-weigh-dbs", *[str(path.resolve()) for path in args.legacy_weigh_dbs]]
        shortcut = agent
    else:
        agent = shortcut = []
    return args, agent, shortcut


def main(argv=None):
    args, agent, shortcut = _arguments(argv)
    lang = "ko"
    try:
        from .launcher_win32 import WindowsDesktop, launcher_lock
        root = args.data_dir.resolve()
        lang = LanguagePreferences(root).get()
        station = _stored_config(root)["station_id"]
        with launcher_lock(root):
            launcher = Launcher(root, load_layout(root), WindowsDesktop(), sys.executable,
                                station, lang, agent, shortcut_args=shortcut)
            ok = launcher.run(show_agent=args.show_agent)
    except (OSError, ValueError):
        ok = False
    if not ok:
        message = ("无法完成现场窗口启动。请检查本机配置及状态。"
                   if lang == "zh" else "현장 창을 열지 못했습니다. PC 설정과 상태를 확인하세요.")
        if sys.stderr is not None:
            print(message, file=sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
