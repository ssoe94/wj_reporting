"""Windows logon task and stable desktop entry points."""

import hashlib
import os
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory
from time import monotonic, sleep
import xml.etree.ElementTree as ET

from ..config import LanguagePreferences, _atomic_file, load_connection, station_lock
from ..launcher import Launcher, _probe, load_layout
from .lifecycle import STOP_FILE, VERSIONS, _manifest, _plain, _pointer, _runtime, _safe_dir
from .station import input_args, read_inputs

_TASK_NS = "http://schemas.microsoft.com/windows/2004/02/mit/task"
_TASK_STATE = "logon-task.txt"
_TITLE = "WJ Field Agent Portable"
_MAX_LOG = 1024 * 1024
_SID = re.compile(rb"S-1-[0-9]+(?:-[0-9]+){1,14}")


def _system(name):
    system_root = os.environ.get("SystemRoot")
    if not system_root:
        raise OSError("Windows system directory is unavailable")
    return Path(system_root) / "System32" / name


def _call(program, *args, check=True):
    return subprocess.run([str(_system(program)), *map(str, args)], stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          check=check, timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def _station_task(root):
    identity = os.path.normcase(str(root.resolve()))
    return "WJField-" + hashlib.sha256(identity.encode()).hexdigest()[:20]


def _task_xml(principal, command, arguments, directory):
    task = ET.Element("Task", {"version": "1.2", "xmlns": _TASK_NS})
    triggers = ET.SubElement(task, "Triggers")
    logon = ET.SubElement(triggers, "LogonTrigger")
    ET.SubElement(logon, "Enabled").text = "true"
    ET.SubElement(logon, "UserId").text = principal
    principals = ET.SubElement(task, "Principals")
    operator = ET.SubElement(principals, "Principal", {"id": "Operator"})
    ET.SubElement(operator, "UserId").text = principal
    ET.SubElement(operator, "LogonType").text = "InteractiveToken"
    ET.SubElement(operator, "RunLevel").text = "LeastPrivilege"
    settings = ET.SubElement(task, "Settings")
    for key, value in {
        "MultipleInstancesPolicy": "IgnoreNew", "StartWhenAvailable": "true",
        "ExecutionTimeLimit": "PT0S", "DisallowStartIfOnBatteries": "false",
        "StopIfGoingOnBatteries": "false", "RunOnlyIfNetworkAvailable": "false",
    }.items():
        ET.SubElement(settings, key).text = value
    retry = ET.SubElement(settings, "RestartOnFailure")
    ET.SubElement(retry, "Interval").text = "PT1M"
    ET.SubElement(retry, "Count").text = "3"
    actions = ET.SubElement(task, "Actions", {"Context": "Operator"})
    run = ET.SubElement(actions, "Exec")
    ET.SubElement(run, "Command").text = str(command)
    ET.SubElement(run, "Arguments").text = arguments
    ET.SubElement(run, "WorkingDirectory").text = str(directory)
    return ET.tostring(task, encoding="utf-16", xml_declaration=True)


def shortcuts(root, mode):
    try:
        _call("cscript.exe", "//NoLogo", root / "shortcuts.vbs", mode, root, _TITLE)
    except subprocess.CalledProcessError as exc:
        raise ValueError("Unable to update the shortcuts for this Windows account") from exc


def _install_task(root, operator_sid):
    name = _station_task(root)
    if operator_sid is None:
        found = _SID.search(_call("whoami.exe", "/user", "/fo", "csv", "/nh").stdout)
    else:
        found = _SID.fullmatch(operator_sid.encode("ascii"))
    if found is None:
        raise ValueError("Specify a valid Windows operator SID from whoami /user")
    principal = found[0].decode("ascii")
    command = _system("wscript.exe")
    arguments = subprocess.list2cmdline([str(root / "hidden.vbs"), "supervise"])
    with TemporaryDirectory(prefix="wj-logon-task-") as directory:
        xml = Path(directory) / "task.xml"
        xml.write_bytes(_task_xml(principal, command, arguments, root))
        try:
            _call("schtasks.exe", "/Create", "/TN", name, "/XML", xml, "/F")
        except subprocess.CalledProcessError as exc:
            raise ValueError("Register the logon task from an elevated Windows command prompt") from exc
    _atomic_file(root / _TASK_STATE, (name + "\n").encode("ascii"))


def unregister_task(root):
    if not (root / _TASK_STATE).exists():
        return
    name = _station_task(root)
    try:
        _call("schtasks.exe", "/Delete", "/TN", name, "/F")
    except subprocess.CalledProcessError as exc:
        raise ValueError("Run remove-autostart.cmd from an elevated Windows command prompt") from exc
    (root / _TASK_STATE).unlink()


def _ready(port, station):
    return _probe(port, lambda data: data.get("station_id") == station and bool(data.get("agent_version")))


def _release(root):
    version = _pointer(root)
    release = root / VERSIONS / version
    _plain(release, directory=True)
    manifest = _manifest(release, version)
    if manifest["skeleton"]:
        raise ValueError("A test skeleton cannot run on an operator PC")
    return release, _runtime(release, manifest)


def _log(root):
    logs = _safe_dir(root / "logs")
    log = logs / "agent.log"
    if log.exists() or log.is_symlink():
        _plain(log)
        if log.stat().st_size >= _MAX_LOG:
            log.replace(logs / "agent.previous.log")
    return log.open("ab", buffering=0)


def _supervise(root, port):
    data = root / "data"
    with station_lock(root):
        if (root / STOP_FILE).exists():
            return 0
        station = load_connection(data).station_id
        if _ready(port, station):
            return 0
        release, runner = _release(root)
        values = input_args(read_inputs(data))
        command = [
            *runner, "-m", "field_agent", "run", "--data-dir", str(data), "--port", str(port),
            "--stop-file", str(root / STOP_FILE), *values,
        ]
        with _log(data) as log:
            child = subprocess.Popen(command, cwd=str(release), stdin=subprocess.DEVNULL, stdout=log,
                                     stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
        # Keep start and maintenance serialized until the runtime owns its
        # station lock and the socket is ready, or exits during startup.
        limit = monotonic() + 12
        while child.poll() is None and not _ready(port, station) and monotonic() < limit:
            sleep(0.2)
    code = child.wait()
    # An abnormal child exit goes to Task Scheduler's RestartOnFailure.
    return 0 if code == 0 or (root / STOP_FILE).exists() else 1


def _show(root, *, agent_view, port):
    from ..launcher_win32 import WindowsDesktop, launcher_lock

    data = root / "data"
    with station_lock(root):
        (root / STOP_FILE).unlink(missing_ok=True)
        station = load_connection(data).station_id
        release, runner = _release(root)
        if not _ready(port, station):
            name = _station_task(root)
            scheduled = (root / _TASK_STATE).exists() and _call(
                "schtasks.exe", "/Run", "/TN", name, check=False,
            ).returncode == 0
            if not scheduled:
                command = [
                    *runner, "-m", "field_agent.packaging.lifecycle", "--root", str(root),
                    "--port", str(port), "supervise",
                ]
                subprocess.Popen(command, cwd=str(release), stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
    limit = monotonic() + 15
    while not _ready(port, station):
        if (root / STOP_FILE).exists() or monotonic() >= limit:
            return False
        sleep(0.25)
    with station_lock(root), launcher_lock(data):
        if (root / STOP_FILE).exists() or not _ready(port, station):
            return False
        _, runner = _release(root)
        launcher = Launcher(data, load_layout(data), WindowsDesktop(), runner[0],
                            station, LanguagePreferences(data).get())
        return launcher.run(show_agent=agent_view, shortcut=False, external_agent=True)


def dispatch(root, args):
    if os.name != "nt":
        raise OSError("This command requires Windows")
    if args.command == "install-autostart":
        with station_lock(root):
            load_connection(root / "data")
            _install_task(root, args.operator_sid)
        print("Registered the WJ Field logon task.")
    elif args.command == "remove-autostart":
        with station_lock(root):
            unregister_task(root)
    elif args.command == "supervise":
        return _supervise(root, args.port)
    elif not _show(root, agent_view=args.agent_view, port=args.port):
        raise ValueError("Unable to open the field window; check the local agent log and layout")
    return 0
