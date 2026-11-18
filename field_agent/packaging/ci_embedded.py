"""Stage a disposable test-only directory using the portable runtime layout."""

import argparse
from contextlib import closing
import json
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
from zipfile import BadZipFile

from ..config import configure
from ..launcher import Layout, save_layout
from ..ledger import Ledger
from .archive_rules import checksum_rows
from .build_portable import _ROOT, _add_runtime, _add_wheel, _copy_release_files


VERSIONS = ("3.8.10", "3.12.10")
ARCHITECTURES = ("amd64", "win32")
WHEEL = "pyserial-3.5-py2.py3-none-any.whl"
PINS = Path("field_agent/packaging/pins/public-runtime-sha256.txt")


def _station_fixture(staging, bundle):
    station = "SYNTH-EMBEDDED-CI"
    config = staging / "connection-import.json"
    config.write_text(json.dumps({
        "server": "http://127.0.0.1:1", "station_id": station,
        "token": "0" * 32 + "." + "f" * 43,
    }), encoding="utf-8")
    data = bundle / "synthetic station"
    configure(data, config, language="ko")
    save_layout(data, Layout(profile="agent_only"))
    with closing(Ledger(data / "ledger.sqlite3", station)):
        pass


def stage_runtime(inputs, destination, version, architecture, *, source_root=_ROOT):
    if version not in VERSIONS or architecture not in ARCHITECTURES:
        raise ValueError("Unknown public Windows runtime")
    if destination.exists() or destination.is_symlink():
        raise ValueError("Choose a new destination for the test runtime")
    pins = checksum_rows((source_root / PINS).read_bytes())
    minor = version.rsplit(".", 1)[0]
    runtime_name = "python-{}-embed-{}.zip".format(version, architecture)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".wj-ci-", dir=destination.parent) as temporary:
        staging = Path(temporary)
        bundle = staging / "bundle"
        binary = bundle / "python"
        runtime, verified_version, verified_architecture = _add_runtime(inputs / runtime_name, minor, pins, binary)
        installed = {}
        wheel, name = _add_wheel(inputs / WHEEL, minor, pins, binary / "Lib" / "site-packages", installed)
        if name != "pyserial" or ("serial", "__init__.py") not in installed:
            raise ValueError("Expected the approved pyserial module")
        _copy_release_files(source_root, bundle)
        tests = bundle / "field_agent" / "tests"
        tests.mkdir()
        for path in (source_root / "field_agent" / "tests").glob("*.py"):
            shutil.copyfile(path, tests / path.name)
        _station_fixture(staging, bundle)
        (bundle / "TEST-ONLY.txt").write_text("Disposable Windows PR runtime fixture.\n", encoding="ascii")
        bundle.rename(destination)
    return {"test_only": True, "python_version": verified_version, "architecture": verified_architecture,
            "inputs": [runtime, wheel]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--python-version", choices=VERSIONS, required=True)
    parser.add_argument("--architecture", choices=ARCHITECTURES, required=True)
    args = parser.parse_args(argv)
    try:
        result = stage_runtime(args.inputs, args.destination, args.python_version, args.architecture)
    except (ValueError, OSError, BadZipFile) as error:
        parser.exit(1, "Test runtime staging failed: " + str(error) + "\n")
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
