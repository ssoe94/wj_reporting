"""Build a Windows portable field agent from pinned local artifacts."""

import argparse
from contextlib import contextmanager
from email.parser import BytesParser
import hashlib
import json
from pathlib import Path
import re
import shutil
import struct
from tempfile import TemporaryDirectory, TemporaryFile
from zipfile import ZIP_DEFLATED, BadZipFile, ZipFile, ZipInfo

from .archive_rules import archive_members, archive_parts, checksum_rows, release_version


PROFILES = {"win7": ("3.8", "Chrome 109"), "win10": ("3.12", "Microsoft Edge or Google Chrome")}
_RUNTIME_NAME = re.compile(r"python-(3\.(?:8|12)\.[0-9]+)-embed-(amd64|win32)\.zip", re.ASCII)
_WHEEL_NAME = re.compile(r"([a-zA-Z0-9_]+)-[^-]+(?:-[^-]+)?-([^-]+)-none-any\.whl", re.ASCII)
_PATCH_PATHS = (
    b"diff --git a/batch_inspection/app.py b/batch_inspection/app.py",
    b"diff --git a/batch_inspection/ui_language.py b/batch_inspection/ui_language.py",
)
_ROOT = Path(__file__).resolve().parents[2]


def _sha256(stream):
    digest = hashlib.sha256()
    for block in iter(lambda: stream.read(1 << 20), b""):
        digest.update(block)
    return digest.hexdigest()


def _file_sha256(path):
    with path.open("rb") as stream:
        return _sha256(stream)


@contextmanager
def _verified(path, pins):
    if len(archive_parts(path.name)) != 1 or path.name not in pins:
        raise ValueError("Build input lacks an approved SHA-256 pin: " + path.name)
    # Use the exact bytes that were hashed even if input storage is shared.
    with TemporaryFile() as snapshot, path.open("rb") as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
            snapshot.write(block)
        verified = digest.hexdigest()
        if verified != pins[path.name]:
            raise ValueError("Build input SHA-256 mismatch: " + path.name)
        snapshot.seek(0)
        yield snapshot, {"name": path.name, "sha256": verified}


def _write_member(archive, item, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with archive.open(item) as source, destination.open("xb") as target:
        shutil.copyfileobj(source, target)


def _check_architecture(executable, arch):
    expected = {"amd64": 0x8664, "win32": 0x014c}[arch]
    with executable.open("rb") as stream:
        header = stream.read(64)
        if len(header) != 64 or header[:2] != b"MZ":
            raise ValueError("Expected a Windows embeddable python.exe")
        stream.seek(struct.unpack_from("<I", header, 60)[0])
        section = stream.read(6)
        if len(section) != 6 or section[:4] != b"PE\0\0" or struct.unpack_from("<H", section, 4)[0] != expected:
            raise ValueError("Embeddable python.exe architecture differs from archive name")


def _add_runtime(runtime, minor, pins, destination):
    match = _RUNTIME_NAME.fullmatch(runtime.name)
    if not match or match[1].rsplit(".", 1)[0] != minor:
        raise ValueError("Embeddable ZIP version does not match the Windows profile")
    version, arch = match.groups()
    digits = minor.replace(".", "")
    stdlib = "python" + digits + ".zip"
    pth = "python" + digits + "._pth"
    expected = {"python.exe", "pythonw.exe", "python3.dll", "python" + digits + ".dll",
                stdlib, pth, "sqlite3.dll", "_sqlite3.pyd", "_ssl.pyd"}
    with _verified(runtime, pins) as (stream, provenance), ZipFile(stream) as payload:
        members = archive_members(payload)
        if any(len(parts) != 1 for _, parts in members) or not expected <= {parts[0] for _, parts in members}:
            raise ValueError("Incomplete embeddable Python ZIP")
        for item, parts in members:
            _write_member(payload, item, destination.joinpath(*parts))
    _check_architecture(destination / "python.exe", arch)
    # The embeddable interpreter reads this isolated search path. Use explicit
    # vendored wheel paths without enabling ambient site initialization.
    (destination / pth).write_bytes((stdlib + "\n.\n..\nLib\\site-packages\n").encode("ascii"))
    return provenance, version, arch


def _add_wheel(wheel, minor, pins, destination, installed):
    match = _WHEEL_NAME.fullmatch(wheel.name)
    tags = {"py3", "py" + minor.replace(".", "")}
    if not match or tags.isdisjoint(match[2].split(".")):
        raise ValueError("Expected a pure Python wheel compatible with " + minor)
    with _verified(wheel, pins) as (stream, provenance), ZipFile(stream) as payload:
        members = archive_members(payload)
        metadata = [item for item, parts in members
                    if len(parts) == 2 and parts[0].endswith(".dist-info") and parts[1] == "WHEEL"]
        if len(metadata) != 1 or metadata[0].file_size > 16 << 10:
            raise ValueError("Expected one wheel metadata file")
        with payload.open(metadata[0]) as source:
            headers = BytesParser().parsebytes(source.read())
        compatible = {tag + "-none-any" for tag in tags}
        if headers.get("Root-Is-Purelib", "").lower() != "true" or compatible.isdisjoint(headers.get_all("Tag", [])):
            raise ValueError("Expected a pure Python wheel for the selected profile")
        for item, parts in members:
            if parts[0].endswith(".data"):
                if len(parts) >= 3 and parts[1] == "scripts":
                    continue
                if len(parts) < 3 or parts[1] != "purelib":
                    raise ValueError("Unsupported wheel data category")
                parts = parts[2:]
            key = tuple(part.lower() for part in parts)
            if key in installed or parts[-1].lower().endswith((".exe", ".dll", ".pyd", ".pth", ".pyc")):
                raise ValueError("Conflicting or unsupported wheel file")
            for index in range(1, len(parts)):
                if installed.setdefault(key[:index], (parts[:index], True)) != (parts[:index], True):
                    raise ValueError("Wheel contains a colliding package directory")
            installed[key] = (parts, False)
            _write_member(payload, item, destination.joinpath(*parts))
    return provenance, match[1].lower()


def _add_uv(uv_patch, pins, destination, source_root):
    with _verified(uv_patch, pins) as (stream, provenance):
        patch = stream.read(1 << 20)
        if stream.read(1) or tuple(line for line in patch.splitlines() if line.startswith(b"diff --git ")) != _PATCH_PATHS:
            raise ValueError("Expected the separately supplied UV display patch from work 007")
        destination.mkdir(parents=True)
        (destination / "batch-inspection-ko-zh.patch").write_bytes(patch)
    shutil.copyfile(source_root / "field_agent" / "packaging" / "UV_COMPONENT.md", destination / "README.md")
    return provenance


def _copy_release_files(source_root, release):
    agent = source_root / "field_agent"
    excluded = {"__pycache__", "tests", "windows_files", "ci_embedded.py"}
    for path in sorted(agent.rglob("*")):
        relative = path.relative_to(agent)
        if not path.is_file() or excluded.intersection(relative.parts):
            continue
        if path.suffix in {".py", ".md"} or relative.parts[0] == "static":
            destination = release / "field_agent" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
    field_docs = source_root / "docs" / "field-monitoring"
    protocol_docs = release / "docs" / "field-monitoring"
    shutil.copytree(field_docs / "operations", protocol_docs / "operations")
    for path in sorted(field_docs.glob("*.md")):
        shutil.copyfile(path, protocol_docs / path.name)
    if (field_docs / "fixtures").is_dir():
        shutil.copytree(field_docs / "fixtures", protocol_docs / "fixtures")


def _copy_application(source_root, release, install):
    _copy_release_files(source_root, release)
    wrappers = source_root / "field_agent" / "packaging" / "windows_files"
    for path in sorted(wrappers.iterdir()):
        if path.is_file():
            shutil.copyfile(path, install / path.name)
    if not (install / "install.cmd").is_file():
        raise ValueError("Windows setup scripts are missing")


def _write_checksums(directory):
    rows = []
    for path in sorted((item for item in directory.rglob("*") if item.is_file()), key=Path.as_posix):
        relative = path.relative_to(directory).as_posix()
        archive_parts(relative)
        rows.append(_file_sha256(path) + "  " + relative + "\n")
    (directory / "SHA256SUMS").write_bytes("".join(rows).encode("ascii"))


def _write_zip(stage, destination):
    with ZipFile(destination, "w", compression=ZIP_DEFLATED, compresslevel=6) as package:
        files = (item for item in (stage / "WJField").rglob("*") if item.is_file())
        for path in sorted(files, key=Path.as_posix):
            name = path.relative_to(stage).as_posix()
            archive_parts(name)
            entry = ZipInfo(name)
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            with path.open("rb") as source, package.open(entry, "w") as target:
                shutil.copyfileobj(source, target)
    with ZipFile(destination) as package:
        archive_members(package)


def build_portable(*, profile, version, output, pins=None, python_zip=None, wheels=(), uv_patch=None,
                   source_root=_ROOT):
    version = release_version(version)
    if profile not in PROFILES:
        raise ValueError("Unknown Windows profile")
    minor, browser = PROFILES[profile]
    output = Path(output)
    if output.suffix.lower() != ".zip":
        raise ValueError("Package output must end in .zip")
    if python_zip is not None and (not wheels or uv_patch is None):
        raise ValueError("A runnable release requires pyserial and the separate UV display patch")
    approved = checksum_rows(Path(pins).read_bytes()) if pins is not None else {}
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".wj-build-", dir=output.parent) as staging:
        stage = Path(staging)
        install = stage / "WJField"
        release = install / "versions" / version
        release.mkdir(parents=True)
        _copy_application(source_root, release, install)
        (release / "field_agent" / "_build_version.py").write_text(
            "__version__ = " + repr(version) + "\n", encoding="ascii")
        (install / "bootstrap.cmd").write_bytes(('@set "WJ_PORTABLE_VERSION=' + version + '"\r\n').encode("ascii"))
        inputs = {"python": None, "wheels": [], "uv_patch": None}
        runtime = release / "python"
        arch = runtime_version = None
        if python_zip is not None:
            inputs["python"], runtime_version, arch = _add_runtime(Path(python_zip), minor, approved, runtime)
        else:
            runtime.mkdir()
            (runtime / "TEST-ONLY.txt").write_bytes(b"No Windows runtime. Test skeleton only.\r\n")
        installed = {}
        wheel_names = set()
        for wheel in wheels:
            proven, name = _add_wheel(Path(wheel), minor, approved, runtime / "Lib" / "site-packages", installed)
            if name in wheel_names:
                raise ValueError("More than one wheel version for " + name)
            wheel_names.add(name)
            inputs["wheels"].append(proven)
        if python_zip is not None and ("pyserial" not in wheel_names or
                                       ("serial", "__init__.py") not in installed):
            raise ValueError("A runnable release requires the approved pyserial wheel")
        if uv_patch is not None:
            inputs["uv_patch"] = _add_uv(Path(uv_patch), approved, release / "components" / "uv", source_root)
        manifest = {"format": 1, "version": version, "profile": profile, "skeleton": python_zip is None,
                    "inputs": inputs, "python_minor": minor, "python_version": runtime_version,
                    "architecture": arch, "browser": browser}
        (release / "BUILD-MANIFEST.json").write_bytes(
            (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("ascii"))
        _write_checksums(release)
        packaged = stage / "package.zip"
        _write_zip(stage, packaged)
        checksum_path = output.with_name(output.name + ".sha256")
        checksum = stage / "package.sha256"
        checksum.write_bytes((_file_sha256(packaged) + "  " + output.name + "\n").encode("utf-8"))
        packaged.replace(output)
        checksum.replace(checksum_path)
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True, choices=PROFILES)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pins", type=Path, help="Trusted pinned SHA-256 list for all supplied artifacts")
    runtime = parser.add_mutually_exclusive_group()
    runtime.add_argument("--python-zip", type=Path)
    runtime.add_argument("--skeleton", action="store_true", help="Test-only package, cannot install on Windows")
    parser.add_argument("--wheel", type=Path, action="append", default=[])
    parser.add_argument("--uv-patch", type=Path)
    args = parser.parse_args(argv)
    try:
        manifest = build_portable(profile=args.profile, version=args.version, output=args.output, pins=args.pins,
                                  python_zip=args.python_zip, wheels=args.wheel, uv_patch=args.uv_patch)
    except (ValueError, OSError, BadZipFile) as error:
        parser.exit(1, "Package build failed: " + str(error) + "\n")
    print("Built " + ("TEST SKELETON" if manifest["skeleton"] else "Windows portable release"), args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
