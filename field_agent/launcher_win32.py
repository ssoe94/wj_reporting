"""Windows-only native desktop calls for the field station launcher."""

from contextlib import contextmanager
import ctypes as C
from ctypes import wintypes as W
import os
from pathlib import Path
import subprocess
from time import monotonic, sleep

from .launcher import Monitor, Process, Rect, Window, _identity_path


SW_SHOWMINNOACTIVE = 7
SW_RESTORE = 9
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_ASYNCWINDOWPOS = 0x4000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TH32CS_SNAPPROCESS = 0x00000002


def _close_bounds(current, target, tolerance):
    def edges(r):
        return r.x, r.y, r.x + r.width, r.y + r.height

    return all(abs(actual - requested) <= tolerance for actual, requested in zip(edges(current), edges(target)))


class _MonitorInfo(C.Structure):
    _fields_ = [
        ("size", W.DWORD), ("monitor", W.RECT), ("work", W.RECT), ("flags", W.DWORD),
        ("device", W.WCHAR * 32),
    ]


class _ProcessEntry(C.Structure):
    _fields_ = [
        ("size", W.DWORD), ("usage", W.DWORD), ("pid", W.DWORD), ("heap", C.c_size_t),
        ("module", W.DWORD), ("threads", W.DWORD), ("parent", W.DWORD), ("priority", W.LONG),
        ("flags", W.DWORD), ("exe", W.WCHAR * 260),
    ]


def _bind(dll, name, args, result):
    func = getattr(dll, name)
    func.argtypes = args
    func.restype = result
    return func


@contextmanager
def launcher_lock(root):
    """Serialize setup of roles, without taking the field agent's own lock."""
    if os.name != "nt":
        raise OSError("Windows desktop required")
    import msvcrt

    path = Path(root) / "launcher.lock"
    if path.is_symlink():
        raise ValueError("Invalid launcher lock file")
    handle = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(handle, "r+b", buffering=0) as stream:
        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        if os.fstat(stream.fileno()).st_size == 0:
            stream.write(b"0")
        yield


class WindowsDesktop:
    """Own no companion processes. Only create, identify, position and activate windows."""

    def __init__(self):
        if os.name != "nt":
            raise OSError("Windows desktop required")
        self.user = C.WinDLL("user32", use_last_error=True)
        self.kernel = C.WinDLL("kernel32", use_last_error=True)
        self.gdi = C.WinDLL("gdi32", use_last_error=True)
        try:
            self.shcore = C.WinDLL("shcore", use_last_error=True)
        except OSError:
            self.shcore = None
        self._monitor_callback = C.WINFUNCTYPE(W.BOOL, W.HANDLE, W.HDC, C.POINTER(W.RECT), W.LPARAM)
        self._window_callback = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
        self._enable_dpi()
        self._bindings()

    def _enable_dpi(self):
        try:
            set_context = _bind(self.user, "SetProcessDpiAwarenessContext", [W.HANDLE], W.BOOL)
            if set_context(C.c_void_p(-4)):  # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
                return
        except AttributeError:
            pass
        if self.shcore:
            per_monitor = _bind(self.shcore, "SetProcessDpiAwareness", [C.c_int], W.LONG)
            if per_monitor(2) == 0:  # PROCESS_PER_MONITOR_DPI_AWARE
                return
        _bind(self.user, "SetProcessDPIAware", [], W.BOOL)()

    def _bindings(self):
        self.enum_monitors = _bind(self.user, "EnumDisplayMonitors",
                                   [W.HDC, C.POINTER(W.RECT), self._monitor_callback, W.LPARAM], W.BOOL)
        self.get_monitor = _bind(self.user, "GetMonitorInfoW", [W.HANDLE, C.POINTER(_MonitorInfo)], W.BOOL)
        self.dpi_for_monitor = (_bind(self.shcore, "GetDpiForMonitor",
                                     [W.HANDLE, C.c_int, C.POINTER(W.UINT), C.POINTER(W.UINT)], W.LONG)
                                if self.shcore else None)
        self.get_dc = _bind(self.user, "GetDC", [W.HWND], W.HDC)
        self.release_dc = _bind(self.user, "ReleaseDC", [W.HWND, W.HDC], C.c_int)
        self.device_caps = _bind(self.gdi, "GetDeviceCaps", [W.HDC, C.c_int], C.c_int)
        self.enum_windows = _bind(self.user, "EnumWindows", [self._window_callback, W.LPARAM], W.BOOL)
        self.visible = _bind(self.user, "IsWindowVisible", [W.HWND], W.BOOL)
        self.get_pid = _bind(self.user, "GetWindowThreadProcessId", [W.HWND, C.POINTER(W.DWORD)], W.DWORD)
        self.get_text = _bind(self.user, "GetWindowTextW", [W.HWND, W.LPWSTR, C.c_int], C.c_int)
        self.exists = _bind(self.user, "IsWindow", [W.HWND], W.BOOL)
        self.minimized = _bind(self.user, "IsIconic", [W.HWND], W.BOOL)
        self.maximized = _bind(self.user, "IsZoomed", [W.HWND], W.BOOL)
        self.show = _bind(self.user, "ShowWindowAsync", [W.HWND, C.c_int], W.BOOL)
        self.window_rect = _bind(self.user, "GetWindowRect", [W.HWND, C.POINTER(W.RECT)], W.BOOL)
        self.window_dpi = (None if not hasattr(self.user, "GetDpiForWindow")
                           else _bind(self.user, "GetDpiForWindow", [W.HWND], W.UINT))
        self.set_position = _bind(self.user, "SetWindowPos",
                                  [W.HWND, W.HWND, C.c_int, C.c_int, C.c_int, C.c_int, W.UINT], W.BOOL)
        self.foreground = _bind(self.user, "SetForegroundWindow", [W.HWND], W.BOOL)
        self.put_prop = _bind(self.user, "SetPropW", [W.HWND, W.LPCWSTR, W.HANDLE], W.BOOL)
        self.get_prop = _bind(self.user, "GetPropW", [W.HWND, W.LPCWSTR], W.HANDLE)
        self.open_process = _bind(self.kernel, "OpenProcess", [W.DWORD, W.BOOL, W.DWORD], W.HANDLE)
        self.close_handle = _bind(self.kernel, "CloseHandle", [W.HANDLE], W.BOOL)
        self.wait_process = _bind(self.kernel, "WaitForSingleObject", [W.HANDLE, W.DWORD], W.DWORD)
        self.process_times = _bind(self.kernel, "GetProcessTimes",
                                   [W.HANDLE, *[C.POINTER(W.FILETIME)] * 4], W.BOOL)
        self.process_path = _bind(self.kernel, "QueryFullProcessImageNameW",
                                  [W.HANDLE, W.DWORD, W.LPWSTR, C.POINTER(W.DWORD)], W.BOOL)
        self.take_snapshot = _bind(self.kernel, "CreateToolhelp32Snapshot", [W.DWORD, W.DWORD], W.HANDLE)
        self.process_first = _bind(self.kernel, "Process32FirstW", [W.HANDLE, C.POINTER(_ProcessEntry)], W.BOOL)
        self.process_next = _bind(self.kernel, "Process32NextW", [W.HANDLE, C.POINTER(_ProcessEntry)], W.BOOL)

    def _dpi(self, monitor):
        dpi_x, dpi_y = W.UINT(), W.UINT()
        if self.dpi_for_monitor and self.dpi_for_monitor(monitor, 0, C.byref(dpi_x), C.byref(dpi_y)) == 0:
            if dpi_x.value:
                return dpi_x.value
        dc = self.get_dc(None)
        if not dc:
            return 96
        try:
            return self.device_caps(dc, 88) or 96  # LOGPIXELSX
        finally:
            self.release_dc(None, dc)

    def monitors(self):
        result = []

        @self._monitor_callback
        def visit(handle, _dc, _bounds, _context):
            info = _MonitorInfo()
            info.size = C.sizeof(info)
            if self.get_monitor(handle, C.byref(info)):
                area = info.work
                rect = Rect(area.left, area.top, area.right - area.left, area.bottom - area.top)
                name = info.device.rsplit(chr(92), 1)[-1].upper()
                result.append(Monitor(name, rect, self._dpi(handle), bool(info.flags & 1)))
            return True

        if not self.enum_monitors(None, None, visit, 0):
            raise OSError("Could not enumerate displays")
        return result

    def identify(self, pid):
        # SYNCHRONIZE plus limited query; no VM-read, write or terminate rights.
        handle = self.open_process(0x00100000 | PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return None
        try:
            if self.wait_process(handle, 0) != 0x00000102:  # WAIT_TIMEOUT means still running
                return None
            created, exited, kernel_time, user_time = [W.FILETIME() for _ in range(4)]
            if not self.process_times(handle, C.byref(created), C.byref(exited), C.byref(kernel_time), C.byref(user_time)):
                return None
            path = C.create_unicode_buffer(32768)
            length = W.DWORD(len(path))
            if not self.process_path(handle, 0, path, C.byref(length)):
                return None
            return Process(pid, (created.dwHighDateTime << 32) | created.dwLowDateTime, path.value)
        finally:
            self.close_handle(handle)

    def has_process(self, path):
        handle = self.take_snapshot(TH32CS_SNAPPROCESS, 0)
        if not handle or handle == C.c_void_p(-1).value:
            raise OSError("Could not enumerate processes")
        name = Path(path).name.casefold()
        try:
            data = _ProcessEntry()
            data.size = C.sizeof(data)
            available = self.process_first(handle, C.byref(data))
            while available:
                if data.exe.casefold() == name:
                    process = self.identify(data.pid)
                    if process and _identity_path(process.exe) == _identity_path(path):
                        return True
                available = self.process_next(handle, C.byref(data))
            return False
        finally:
            self.close_handle(handle)

    def windows(self):
        result = []

        @self._window_callback
        def visit(handle, _context):
            if self.visible(handle):
                title = C.create_unicode_buffer(256)
                pid = W.DWORD()
                self.get_text(handle, title, len(title))
                self.get_pid(handle, C.byref(pid))
                if title.value and pid.value:
                    result.append(Window(handle, pid.value, title.value))
            return True

        if not self.enum_windows(visit, 0):
            raise OSError("Could not enumerate windows")
        return result

    def bounds(self, handle):
        value = W.RECT()
        if not self.window_rect(handle, C.byref(value)):
            return None
        return Rect(value.left, value.top, value.right - value.left, value.bottom - value.top)

    def place(self, handle, rect):
        if not self.exists(handle):
            raise OSError("Window disappeared")
        if self.minimized(handle) or self.maximized(handle):
            self.show(handle, SW_RESTORE)
        if not self.set_position(handle, None, rect.x, rect.y, rect.width, rect.height,
                                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS):
            raise OSError("Window position failed")
        # The asynchronous request can be accepted but clamped by the window's
        # minimum size. Verify that the position actually settled.
        deadline = monotonic() + 1.0
        while True:
            current = self.bounds(handle)
            dpi = (self.window_dpi(handle) if self.window_dpi else 96) or 96
            tolerance = round(12 * dpi / 96)
            if current is not None and _close_bounds(current, rect, tolerance):
                return
            if monotonic() >= deadline:
                raise OSError("Window did not fit the requested work area")
            sleep(0.05)

    def mark(self, handle, tag):
        self.put_prop(handle, "WJ.FieldLauncher." + tag, 1)

    def is_marked(self, handle, tag):
        return bool(self.get_prop(handle, "WJ.FieldLauncher." + tag))

    def minimize(self, handle):
        if self.exists(handle) and not self.minimized(handle):
            self.show(handle, SW_SHOWMINNOACTIVE)

    def focus(self, handle):
        # Windows can refuse this when a different foreground application is
        # consuming user input. Never steal focus with patched thread state.
        return bool(self.foreground(handle))

    @staticmethod
    def _environment():
        env = os.environ.copy()
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        env["PYTHONNOUSERSITE"] = "1"
        return env

    @staticmethod
    def spawn(args, cwd):
        if not Path(args[0]).is_file() or not Path(cwd).is_dir():
            raise OSError("Launch executable or working directory is missing")
        return subprocess.Popen(args, executable=args[0], shell=False, cwd=str(cwd), env=WindowsDesktop._environment(),
                                creationflags=0x08000200,  # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL).pid

    @staticmethod
    def browser():
        roots = [Path(value) for key in ("ProgramFiles", "ProgramFiles(x86)", "LocalAppData")
                 if (value := os.environ.get(key))]
        for relative in ("Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"):
            for root in roots:
                candidate = root / relative
                if candidate.is_file():
                    return str(candidate)
        return None

    @staticmethod
    def shortcut(runner, args, cwd, language):
        app = Path(runner)
        windowless = app.with_name("pythonw.exe")
        system_root = os.environ.get("SystemRoot")
        if not system_root:
            raise OSError("Windows system directory is unavailable")
        executable = Path(system_root) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        env = WindowsDesktop._environment()
        env.update(WJ_LINK_TARGET=str(windowless if windowless.is_file() else app),
                   WJ_LINK_ARGS=subprocess.list2cmdline(args), WJ_LINK_CWD=str(cwd),
                   WJ_LINK_DESC="打开现场代理" if language == "zh" else "현장 에이전트 열기")
        # Constant script. Configured paths are only values for shortcut COM
        # properties, never PowerShell code or command text.
        script = ("$ErrorActionPreference='Stop'; "
                  "$desktop=[Environment]::GetFolderPath('DesktopDirectory'); "
                  "if (!$desktop) { throw 'Desktop unavailable' }; "
                  "$ws=New-Object -ComObject WScript.Shell; "
                  "$link=$ws.CreateShortcut((Join-Path $desktop 'WJ Field Agent.lnk')); "
                  "$link.TargetPath=$env:WJ_LINK_TARGET; $link.Arguments=$env:WJ_LINK_ARGS; "
                  "$link.WorkingDirectory=$env:WJ_LINK_CWD; $link.Description=$env:WJ_LINK_DESC; $link.Save()")
        try:
            result = subprocess.run([str(executable), "-NoProfile", "-NonInteractive", "-Command", script],
                                    shell=False, env=env, timeout=8, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000)
        except subprocess.TimeoutExpired:
            return False
        return result.returncode == 0
