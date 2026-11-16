"""Exercise the candidate runtime against a private copy of station state."""

from contextlib import closing
import json
from pathlib import Path
import shutil
import socket
import sqlite3
from tempfile import TemporaryDirectory

from ..backup import verify_snapshot
from ..barcode_app import BarcodeApp
from ..barcode_legacy import LegacyBarcodeCollector
from ..config import CONFIG, _limited_read, load_connection
from ..launcher import load_layout
from ..ledger import Ledger
from ..vision_sources import create_collectors, load_sources
from ..weigh.legacy import WeighLegacyCollector
from ..weigh.settings import load as load_weigh_settings
from ..weigh.store import WeighStore
from .station import read_inputs


def _idle_ledger(conn):
    names = {item[0] for item in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    checks = {
        "weigh_jobs": "SELECT 1 FROM weigh_jobs WHERE state IN ('waiting','dispatching') LIMIT 1",
        "weigh_attempts": "SELECT 1 FROM weigh_attempts WHERE outcome='dispatching' LIMIT 1",
        "weigh_rows": """SELECT 1 FROM weigh_rows LEFT JOIN weigh_reconciliations USING(row_id)
            WHERE state='uncertain' AND confirmed_quantity IS NULL LIMIT 1""",
        "weigh_peel": "SELECT 1 FROM weigh_peel LIMIT 1",
    }
    if any(conn.execute(query).fetchone() for name, query in checks.items() if name in names):
        raise ValueError("Stop and reconcile the active print work before maintenance")


def _idle_vision(sources):
    v49 = sources.get("backcover")
    if not v49:
        return
    checkpoint = Path(v49["history"]).parent.parent / "safety.json"
    try:
        raw = json.loads(_limited_read(checkpoint, 64 * 1024).decode("utf-8"))
    except FileNotFoundError:
        # A new installation may have no journal. The maintenance command
        # still requires the operator to attest that all external apps are idle.
        return
    if not isinstance(raw, dict) or type(raw.get("active")) is not bool:
        raise ValueError("V49 safety checkpoint cannot establish an idle cycle")
    if raw["active"] or raw.get("running") is True:
        raise ValueError("Stop the active V49 inspection before maintenance")


def _copy_ledger(origin, destination):
    if origin.is_symlink() or not origin.is_file():
        raise ValueError("Invalid station ledger path")
    for suffix in ("", "-wal"):
        original = origin.with_name(origin.name + suffix)
        if original.is_symlink():
            raise ValueError("Invalid station ledger sidecar")
        if original.exists():
            if not original.is_file():
                raise ValueError("Invalid station ledger sidecar")
            # Rebuild SHM from the copied WAL. Never open the installed database.
            shutil.copyfile(original, destination.with_name(destination.name + suffix))


def _existing_schema(conn):
    objects = conn.execute("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    return {(name, kind): tuple(conn.execute("SELECT name,type,pk FROM pragma_table_info(?)", (name,)))
            if kind == "table" else (table, sql) for name, kind, table, sql in objects}


def _preserved_schema(before, after):
    for key, baseline in before.items():
        current = after.get(key)
        if key[1] == "table" and current is not None:
            current = current[:len(baseline)]
        if baseline != current:
            raise ValueError("The candidate changed an existing station schema object")


def _check_port(port):
    if not 0 <= port <= 65535:
        raise ValueError("Invalid local port")
    with socket.socket() as listener:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        listener.bind(("127.0.0.1", port))
        listener.listen(1)


def check_station(data, *, port=8769, idle=False):
    data = Path(data)
    old = data / "ledger.sqlite3"
    has_ledger = old.exists() or old.is_symlink()
    connection = load_connection(data) if has_ledger or (data / CONFIG).exists() else None
    load_layout(data)
    sources = load_sources(data)
    inputs = read_inputs(data)
    if idle:
        _idle_vision(sources)
    _check_port(port)
    with TemporaryDirectory(prefix="wj-station-selftest-") as directory:
        root = Path(directory)
        candidate = root / "ledger.sqlite3"
        baseline = {}
        if has_ledger:
            _copy_ledger(old, candidate)
            with closing(sqlite3.connect(str(candidate))) as conn:
                baseline = _existing_schema(conn)
        with closing(Ledger(candidate, connection.station_id if connection else "SELFTEST")) as ledger:
            if idle:
                with ledger.read() as conn:
                    _idle_ledger(conn)
            if "barcode_config" in inputs:
                BarcodeApp(ledger, inputs["barcode_config"], lambda **_: None)
            if "weigh_config" in inputs:
                WeighStore(ledger, load_weigh_settings(inputs["weigh_config"]))
            if "legacy_barcode_db" in inputs:
                LegacyBarcodeCollector(ledger, inputs["legacy_barcode_db"]).close()
            if "legacy_weigh_dbs" in inputs:
                WeighLegacyCollector(ledger, *inputs["legacy_weigh_dbs"]).close()
            for collector in create_collectors(ledger, sources).values():
                collector.close()
            normalized = root / "snapshot.sqlite3"
            with ledger.read() as conn, closing(sqlite3.connect(str(normalized))) as snapshot:
                conn.row_factory = None
                _preserved_schema(baseline, _existing_schema(conn))
                conn.backup(snapshot)
                snapshot.execute("PRAGMA journal_mode=DELETE")
        return verify_snapshot(normalized)
