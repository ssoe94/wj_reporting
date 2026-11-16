"""Local version activation for a Windows portable field agent."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
from tempfile import TemporaryDirectory, TemporaryFile
from time import monotonic, sleep
from zipfile import BadZipFile, ZipFile

from ..config import LANGUAGES, LanguagePreferences, _atomic_file, _limited_read, configure, load_connection, station_lock
from ..launcher import load_layout, prepare_layout, save_layout
from ..vision_sources import prepare_sources, save_sources
from ..weigh.issuer_policy import apply_to_station, prepare_policy
from .archive_rules import archive_members, archive_parts, checksum_rows, release_version
from .station import LEGACY, NATIVE, prepare_inputs, save_inputs

CURRENT = "current.txt"
PREVIOUS = "previous.txt"
STOP_FILE = "maintenance.stop"
CLEANUP = "uninstall-versions.txt"
VERSIONS = "versions"
SUMS = "SHA256SUMS"
MANIFEST = "BUILD-MANIFEST.json"
WRAPPERS = (
    "portable.cmd", "install.cmd", "configure.cmd", "start.cmd", "agent-view.cmd", "stop.cmd",
    "update.cmd", "rollback.cmd", "install-autostart.cmd", "remove-autostart.cmd", "supervise.cmd", "uninstall.cmd",
    "hidden.vbs", "shortcuts.vbs", "dispatch.vbs", "bootstrap.cmd",
)
_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
_SHA = re.compile(r"[a-f0-9]{64}", re.ASCII)


def _plain(path, *, directory=False):
    info = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("Unexpected linked or special portable path")


def _safe_dir(path):
    path.mkdir(exist_ok=True)
    _plain(path, directory=True)
    return path


def _digest(stream):
    checksum = hashlib.sha256()
    for chunk in iter(lambda: stream.read(256 * 1024), b""):
        checksum.update(chunk)
    return checksum.hexdigest()


def _manifest(release, version):
    path = release / MANIFEST
    _plain(path)
    raw = json.loads(_limited_read(path, 64 * 1024).decode("ascii"))
    profile = raw.get("profile") if isinstance(raw, dict) else None
    if (not isinstance(raw, dict) or type(raw.get("format")) is not int or raw["format"] != 1
            or raw.get("version") != version or profile not in ("win7", "win10")
            or type(raw.get("skeleton")) is not bool
            or raw.get("python_minor") != {"win7": "3.8", "win10": "3.12"}[profile]
            or (raw.get("architecture") not in ("amd64", "win32") if not raw["skeleton"]
                else raw.get("architecture") is not None)):
        raise ValueError("Invalid portable release manifest")
    return raw


def _verify_release(release, version, allow_skeleton):
    _plain(release, directory=True)
    manifest = _manifest(release, version)
    if manifest["skeleton"] and not allow_skeleton:
        raise ValueError("A test skeleton cannot run on an operator PC")
    sum_path = release / SUMS
    _plain(sum_path)
    checks = checksum_rows(_limited_read(sum_path, 2 * 1024 * 1024))
    required = {MANIFEST, "field_agent/__main__.py"}
    if not manifest["skeleton"]:
        required.add("python/python.exe")
    if not required <= checks.keys():
        raise ValueError("Missing required release members")
    seen = set()
    for current, dirs, files in os.walk(release):
        current = Path(current)
        for name in dirs:
            _plain(current / name, directory=True)
        for name in files:
            path = current / name
            _plain(path)
            relative = path.relative_to(release).as_posix()
            if relative == SUMS:
                continue
            archive_parts(relative)
            with path.open("rb") as content:
                if checks.get(relative) != _digest(content):
                    raise ValueError("Release SHA-256 verification failed")
            seen.add(relative)
    if seen != checks.keys():
        raise ValueError("Release file list differs from SHA256SUMS")
    return manifest


def _pointer(root, name=CURRENT, *, required=True):
    path = root / name
    try:
        _plain(path)
        value = _limited_read(path, 96).decode("ascii").strip()
    except FileNotFoundError:
        if not required:
            return None
        raise ValueError("No active portable release")
    return release_version(value)


def _set_pointer(root, name, version):
    _atomic_file(root / name, (release_version(version) + "\n").encode("ascii"))


def _extract_package(package, stage):
    digest_path = package.with_name(package.name + ".sha256")
    try:
        _plain(digest_path)
        line = _limited_read(digest_path, 4096).decode("utf-8").rstrip("\r\n")
    except FileNotFoundError as exc:
        raise ValueError("The approved archive SHA-256 sidecar is missing") from exc
    expected, separator, name = line.partition("  ")
    if not separator or not _SHA.fullmatch(expected) or name != package.name:
        raise ValueError("Invalid archive SHA-256 sidecar")
    _plain(package)
    if package.stat().st_size > _MAX_ARCHIVE_BYTES:
        raise ValueError("Portable archive exceeds the size limit")
    with package.open("rb") as source, TemporaryFile(dir=stage.parent) as content:
        checksum = hashlib.sha256()
        copied = 0
        for chunk in iter(lambda: source.read(256 * 1024), b""):
            copied += len(chunk)
            if copied > _MAX_ARCHIVE_BYTES:
                raise ValueError("Portable archive exceeds the size limit")
            checksum.update(chunk)
            content.write(chunk)
        if checksum.hexdigest() != expected:
            raise ValueError("Portable archive SHA-256 differs from the approved value")
        content.seek(0)
        with ZipFile(content) as archive:
            entries = archive_members(archive)
            versions = set()
            files = []
            for member, parts in entries:
                if len(parts) >= 4 and parts[:2] == ("WJField", VERSIONS):
                    versions.add(release_version(parts[2]))
                    files.append((member, parts[3:]))
                elif len(parts) != 2 or parts[0] != "WJField" or parts[1] not in WRAPPERS:
                    raise ValueError("Unexpected portable archive layout")
            if len(versions) != 1 or len(entries) > 20_000 or sum(item.file_size for item, _ in entries) > _MAX_ARCHIVE_BYTES:
                raise ValueError("Archive must contain one bounded release")
            version = versions.pop()
            for member, parts in files:
                dest = stage.joinpath(*parts)
                dest.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as packed, dest.open("xb") as target:
                    shutil.copyfileobj(packed, target, 256 * 1024)
    return version


def _runtime(release, manifest):
    if manifest["skeleton"]:
        return [sys.executable, "-B"]
    return [str(release / "python" / "python.exe"), "-I", "-B"]


def _selftest(release, manifest, data, port, *, idle=False):
    args = [
        *_runtime(release, manifest), "-m", "field_agent", "selftest",
        "--data-dir", str(data), "--port", str(port), "--stopped",
    ]
    if idle:
        args.append("--require-idle")
    if not manifest["skeleton"]:
        args.append("--windows-package")
    try:
        subprocess.run(args, cwd=str(release), check=True, timeout=180)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise ValueError("Candidate self-test failed; active version was preserved") from exc


def _check_companions(data):
    if os.name != "nt":
        return
    from ..launcher import _BACKCOVER_PORT, _listening, _process_records, _validated_process, _PROCESSES
    from ..launcher_win32 import WindowsDesktop
    layout = load_layout(data)
    if layout.companion is None:
        return
    records = _process_records(data / _PROCESSES)
    identify = WindowsDesktop().identify
    for role in ("backend", "companion_window"):
        if _validated_process(records.get(role), identify) is not None:
            raise ValueError("Close the tracked vision app before maintenance")
    if layout.companion.kind == "backcover_v49" and _listening(_BACKCOVER_PORT):
        raise ValueError("Close the running V49 backend before maintenance")


def _managed_versions(versions):
    for path in versions.iterdir():
        try:
            release_version(path.name)
            _plain(path, directory=True)
            _manifest(path, path.name)
        except (OSError, ValueError):
            continue
        yield path


def _retain(versions, current, previous, keep):
    oldest_last = sorted(_managed_versions(versions), key=lambda path: path.stat().st_mtime_ns, reverse=True)
    retained = {current, previous}
    for path in oldest_last:
        if path.name in retained or len(retained) < keep + 1:
            retained.add(path.name)
        else:
            try:
                shutil.rmtree(path)
            except OSError:
                # Antivirus or an old process can keep a version open. The
                # selected pointer is durable and the next update can retry.
                print("An older version could not yet be pruned.", file=sys.stderr)


def _same_release(stage, existing, version, allow_skeleton):
    _verify_release(existing, version, allow_skeleton)
    expected = checksum_rows(_limited_read(stage / SUMS, 2 * 1024 * 1024))
    actual = checksum_rows(_limited_read(existing / SUMS, 2 * 1024 * 1024))
    if actual != expected:
        raise ValueError("A different release already uses this version")


def install(source, root, version, *, allow_skeleton=False, port=8769, shortcuts=True):
    version = release_version(version)
    _plain(source, directory=True)
    bundled = source / VERSIONS / version
    manifest = _verify_release(bundled, version, allow_skeleton)
    root.mkdir(parents=True, exist_ok=True)
    _plain(root, directory=True)
    with station_lock(root):
        if _pointer(root, required=False) is not None:
            raise ValueError("An active release already exists; use update or rollback")
        data = _safe_dir(root / "data")
        versions = _safe_dir(root / VERSIONS)
        final = versions / version
        with station_lock(data, existing_only=True), TemporaryDirectory(prefix=".install-", dir=versions) as directory:
            stage = Path(directory) / "release"
            if bundled != final:
                if final.exists() or final.is_symlink():
                    _same_release(bundled, final, version, allow_skeleton)
                    stage = final
                else:
                    shutil.copytree(bundled, stage)
                    _verify_release(stage, version, allow_skeleton)
            else:
                stage = final
            _selftest(stage, manifest, data, port)
            for name in WRAPPERS:
                path = source / name
                _plain(path)
                if source != root:
                    _atomic_file(root / name, _limited_read(path, 64 * 1024))
            if stage != final:
                stage.rename(final)
            _set_pointer(root, CURRENT, version)
    if shortcuts and os.name == "nt":
        from .windows import shortcuts as change_shortcuts
        change_shortcuts(root, "add")
    return version


def update(root, package, *, allow_skeleton=False, port=8769, keep=2):
    if keep < 1:
        raise ValueError("Retain at least one prior release")
    with station_lock(root):
        active = _pointer(root)
        versions = root / VERSIONS
        data = root / "data"
        for directory in (versions, data):
            _plain(directory, directory=True)
        manifest = _manifest(versions / active, active)
        with station_lock(data, existing_only=True), TemporaryDirectory(prefix=".update-", dir=versions) as directory:
            _check_companions(data)
            stage = Path(directory) / "release"
            stage.mkdir()
            version = _extract_package(package, stage)
            final = versions / version
            prepared = _verify_release(stage, version, allow_skeleton)
            identity = ("profile", "architecture", "skeleton")
            if any(manifest[key] != prepared[key] for key in identity):
                raise ValueError("The package profile or runtime architecture differs from the active release")
            exists = final.exists() or final.is_symlink()
            if exists:
                _same_release(stage, final, version, allow_skeleton)
                if active == version:
                    return version
            _selftest(stage, prepared, data, port, idle=True)
            if not exists:
                stage.rename(final)
            _set_pointer(root, PREVIOUS, active)
            _set_pointer(root, CURRENT, version)
            _retain(versions, version, active, keep)
    return version


def rollback(root, version=None, *, allow_skeleton=False, port=8769):
    with station_lock(root):
        active = _pointer(root)
        version = release_version(version) if version is not None else _pointer(root, PREVIOUS)
        if version == active:
            raise ValueError("The requested release is already active")
        data = root / "data"
        versions = root / VERSIONS
        for directory in (versions, data):
            _plain(directory, directory=True)
        with station_lock(data, existing_only=True):
            _check_companions(data)
            target = versions / version
            prepared = _verify_release(target, version, allow_skeleton)
            _selftest(target, prepared, data, port, idle=True)
            _set_pointer(root, PREVIOUS, active)
            _set_pointer(root, CURRENT, version)
    return version


def _configure(root, args):
    data = root / "data"
    inputs = {name: getattr(args, name) for name in (*NATIVE, *LEGACY) if getattr(args, name) is not None}
    if inputs and args.agent_only:
        raise ValueError("Choose agent-only or one set of field inputs")
    settings = prepare_inputs(inputs, Path.cwd())
    layout = prepare_layout(args.layout_config) if args.layout_config else None
    sources = prepare_sources(args.vision_config) if args.vision_config else None
    policy = prepare_policy(args.issuer_policy) if args.issuer_policy else None
    with station_lock(root):
        if _pointer(root, required=False) is None:
            raise ValueError("Install the portable release first")
        if args.connection:
            configure(data, args.connection, language=args.language)
        with station_lock(data):
            connection = load_connection(data)
            if policy is not None:
                apply_to_station(data, connection, policy)
            if args.language:
                LanguagePreferences(data).set(args.language)
            if layout is not None:
                save_layout(data, layout)
            if sources is not None:
                save_sources(data, sources)
            if inputs or args.agent_only:
                save_inputs(data, settings)


def _stop(root):
    with station_lock(root):
        _atomic_file(root / STOP_FILE, b"stop\n")
        deadline = monotonic() + 30
        while True:
            try:
                with station_lock(root / "data", existing_only=True):
                    return
            except ValueError:
                if monotonic() >= deadline:
                    raise ValueError("Agent still shutting down; check local workers")
                sleep(0.25)


def _uninstall(root, port):
    with station_lock(root), station_lock(root / "data", existing_only=True):
        _check_companions(root / "data")
        active = _pointer(root)
        _plain(root / VERSIONS, directory=True)
        _plain(root / "data", directory=True)
        release = root / VERSIONS / active
        prepared = _manifest(release, active)
        _selftest(release, prepared, root / "data", port, idle=True)
        if os.name == "nt":
            from .windows import shortcuts, unregister_task
            unregister_task(root)
            shortcuts(root, "remove")
        names = [path.name for path in _managed_versions(root / VERSIONS)]
        _atomic_file(root / CLEANUP, ("\n".join(names) + "\n").encode("ascii"))
        _atomic_file(root / STOP_FILE, b"stop\n")
        (root / CURRENT).unlink()
        (root / PREVIOUS).unlink(missing_ok=True)
        # On Windows the batch wrapper removes versions once its own
        # Python interpreter exits and Windows releases the executable.
        return names


def _args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8769, help=argparse.SUPPRESS)
    parser.add_argument("--allow-skeleton", action="store_true", help=argparse.SUPPRESS)
    commands = parser.add_subparsers(dest="command", required=True)
    first = commands.add_parser("install")
    first.add_argument("target", type=Path)
    first.add_argument("--version", help=argparse.SUPPRESS)
    settings = commands.add_parser("configure")
    settings.add_argument("connection", type=Path, nargs="?")
    settings.add_argument("--language", choices=LANGUAGES)
    settings.add_argument("--layout-config", type=Path)
    settings.add_argument("--vision-config", type=Path)
    settings.add_argument("--issuer-policy", type=Path)
    for name in (*NATIVE, *LEGACY):
        settings.add_argument("--" + name.replace("_", "-"), nargs=2 if name == "legacy_weigh_dbs" else None)
    settings.add_argument("--agent-only", action="store_true")
    launch = commands.add_parser("start")
    launch.add_argument("--agent-view", action="store_true")
    commands.add_parser("stop")
    scheduler = commands.add_parser("install-autostart")
    scheduler.add_argument("--operator-sid")
    commands.add_parser("remove-autostart")
    commands.add_parser("supervise")
    upgrade = commands.add_parser("update")
    upgrade.add_argument("package", type=Path)
    upgrade.add_argument("--keep", type=int, default=2)
    back = commands.add_parser("rollback")
    back.add_argument("version", nargs="?")
    remove = commands.add_parser("uninstall")
    for command in (upgrade, back, remove):
        command.add_argument("--confirm-idle", action="store_true", required=True)
    return parser.parse_args(argv)


def main(argv=None):
    args = _args(argv)
    root = args.root.absolute()
    try:
        _plain(root, directory=True)
        if args.allow_skeleton and os.name == "nt":
            raise ValueError("Test skeleton execution is available only for host-side layout checks")
        if args.command == "install":
            version = args.version or Path(__file__).resolve().parents[2].name
            print("Installed " + install(root, args.target.absolute(), version,
                                        allow_skeleton=args.allow_skeleton, port=args.port))
        elif args.command == "configure":
            _configure(root, args)
        elif args.command == "update":
            print("Activated " + update(root, args.package, allow_skeleton=args.allow_skeleton,
                                        port=args.port, keep=args.keep))
        elif args.command == "rollback":
            print("Restored " + rollback(root, args.version, allow_skeleton=args.allow_skeleton, port=args.port))
        elif args.command == "stop":
            _stop(root)
        elif args.command == "uninstall":
            names = _uninstall(root, args.port)
            if os.name != "nt":
                for name in names:
                    shutil.rmtree(root / VERSIONS / name)
                (root / CLEANUP).unlink()
        else:
            from .windows import dispatch
            return dispatch(root, args)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError, BadZipFile, sqlite3.Error) as exc:
        message = str(exc) if type(exc) is ValueError else type(exc).__name__
        print("WJ Field: " + message, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
