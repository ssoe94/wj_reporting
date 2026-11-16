"""Install and run one field station from a portable folder."""

import argparse
import json
from pathlib import Path
from queue import Full
import signal
import sqlite3
import sys
from threading import Event, Thread

from .backup import DEFAULT_MIN_FREE, restore_snapshot, verify_snapshot
from .config import LANGUAGES, configure, load_connection, station_lock
from .devices import MAX_FRAME_BYTES
from .ledger import Ledger
from .launcher import prepare_layout, save_layout
from .protocol import encode
from .runtime import Runtime
from .transport import Transport
from .vision_sources import load_sources, prepare_sources, save_sources
from .weigh.app import make_devices
from .weigh.settings import load as load_weigh_settings
from .weigh.serial_authority import confirm_no_issuance, local_admin_actor


def _feed_stdin(runtime, stop):
    while not stop.is_set():
        frame = sys.stdin.buffer.readline(MAX_FRAME_BYTES + 1)
        if not frame:
            return
        if len(frame) > MAX_FRAME_BYTES:
            print("Demo input exceeded the frame limit; input stopped.", file=sys.stderr)
            return
        while not stop.is_set():
            try:
                runtime.device.feed(frame)
                break
            except Full:
                stop.wait(0.05)


def _feed_weigh_stdin(runtime, stop):
    """Local bounded JSON-lines bench input. It is disabled for real equipment."""
    app = runtime.weigh
    while not stop.is_set():
        raw = sys.stdin.buffer.readline(1025)
        if not raw:
            return
        try:
            if len(raw) > 1024:
                raise ValueError
            item = json.loads(raw.decode("utf-8"))
            kind = item["type"]
            if kind == "scale":
                app.scale.add_weight(item["grams"], item.get("status", "ST"), item.get("mode", "GS"))
            elif kind == "scan":
                app.scanner.feed(item["device"], item["barcode"])
            elif kind == "printer":
                app.printer.inject(item["outcome"])
            elif kind == "peel":
                if type(item["waiting"]) is not bool:
                    raise ValueError
                app.printer.set_label_waiting(item["waiting"])
            else:
                raise ValueError
        except (ValueError, KeyError, TypeError, AttributeError, BufferError):
            print("Field Agent: invalid or full synthetic weigh input; input stopped.", file=sys.stderr)
            return


def _run(args):
    if args.backup_keep < 1 or args.backup_idle < 0 or args.min_free_mib < 0 or not 1 <= args.port <= 65535:
        raise ValueError("Invalid port or backup settings")
    if args.weigh_fake and not args.weigh_config:
        raise ValueError("--weigh-fake requires --weigh-config")
    weigh_settings = load_weigh_settings(args.weigh_config) if args.weigh_config else None
    if args.weigh_fake and weigh_settings.mode != "test":
        raise ValueError("Synthetic weigh input requires test mode")
    connection = load_connection(args.data_dir)
    sources = load_sources(args.data_dir)
    ledger = Ledger(args.data_dir / "ledger.sqlite3", connection.station_id)
    try:
        runtime = Runtime(ledger, Transport(connection.server, connection.token), demo=args.fake_stdin,
                          port=args.port, backup_idle=args.backup_idle, backup_keep=args.backup_keep,
                          min_free_bytes=args.min_free_mib * 1024 * 1024,
                          barcode_config=args.barcode_config, legacy_barcode_db=args.legacy_barcode_db,
                          weigh_settings=weigh_settings,
                          weigh_devices=make_devices(weigh_settings, fake=True) if args.weigh_fake else None,
                          legacy_weigh_dbs=tuple(map(Path, args.legacy_weigh_dbs)) if args.legacy_weigh_dbs else None,
                          vision_sources=sources)
        stop = Event()
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, lambda *_args: stop.set())
        runtime.start()
        try:
            if args.fake_stdin:
                Thread(name="field-stdin", target=_feed_stdin, args=(runtime, stop), daemon=True).start()
            if args.weigh_fake:
                Thread(name="field-weigh-stdin", target=_feed_weigh_stdin, args=(runtime, stop), daemon=True).start()
            print("Field Agent: http://127.0.0.1:{}/".format(runtime.local_ui.port), flush=True)
            stop.wait()
        finally:
            runtime.stop()
    finally:
        ledger.close()


def _args():
    parser = argparse.ArgumentParser(prog="python -m field_agent")
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser("configure", help="Import a server-issued local connection JSON")
    install.add_argument("--connection", type=Path, required=True)
    install.add_argument("--language", choices=LANGUAGES, help="Initial operator screen language")
    install.add_argument("--layout-config", type=Path, help="Install a validated Windows companion layout")
    install.add_argument("--vision-config", type=Path, help="Install read-only vision sources for this PC")
    run = commands.add_parser("run", help="Run the station and its localhost screen")
    run.add_argument("--port", type=int, default=8769)
    barcode = run.add_mutually_exclusive_group()
    barcode.add_argument("--fake-stdin", action="store_true", help="Record test-only core demo frames from stdin")
    barcode.add_argument("--barcode-config", type=Path, help="Run the barcode reader with a local rules file")
    barcode.add_argument("--legacy-barcode-db", type=Path, help="Read the existing barcode SQLite source without opening COM")
    barcode.add_argument("--weigh-config", type=Path, help="Run the weight and label app with local rules")
    barcode.add_argument("--legacy-weigh-dbs", nargs=2, metavar=("SCANS", "PRINT"), help="Read existing weigh SQLite sources")
    run.add_argument("--weigh-fake", action="store_true", help="Use synthetic weigh devices with test-only JSON-lines input")
    run.add_argument("--backup-idle", type=int, default=60)
    run.add_argument("--backup-keep", type=int, default=30)
    run.add_argument("--min-free-mib", type=int, default=DEFAULT_MIN_FREE // (1024 * 1024))
    resume = commands.add_parser("resume", help="Retry an intact blocked batch after the cause is corrected")
    restore = commands.add_parser("restore", help="Restore a verified same-generation backup into a fresh ledger path")
    restore.add_argument("--backup", type=Path, required=True)
    restore.add_argument("--confirmed-same-generation", action="store_true", required=True)
    serial = commands.add_parser("confirm-serial-floor", help="Attest that a PART has no issuance today")
    serial.add_argument("--weigh-config", type=Path, required=True)
    serial.add_argument("--part-no", required=True)
    serial.add_argument("--reason", required=True)
    serial.add_argument("--confirm-no-issuance", action="store_true", required=True)
    for command in (install, run, resume, restore, serial):
        command.add_argument("--data-dir", type=Path, required=True)
    verify = commands.add_parser("verify-backup", help="Verify a backup file and its pending batches")
    verify.add_argument("--backup", type=Path, required=True)
    return parser.parse_args()


def main():
    args = _args()
    try:
        if args.command == "configure":
            layout = prepare_layout(args.layout_config) if args.layout_config else None
            sources = prepare_sources(args.vision_config) if args.vision_config else None
            configure(args.data_dir, args.connection, language=args.language)
            if layout is not None:
                save_layout(args.data_dir, layout)
            if sources is not None:
                save_sources(args.data_dir, sources)
            print("Field connection stored.")
        elif args.command == "verify-backup":
            print(encode(verify_snapshot(args.backup)).decode())
        else:
            with station_lock(args.data_dir):
                if args.command == "run":
                    _run(args)
                elif args.command == "confirm-serial-floor":
                    actor = local_admin_actor(args.data_dir)
                    setting = load_weigh_settings(args.weigh_config)
                    connection = load_connection(args.data_dir)
                    ledger = Ledger(args.data_dir / "ledger.sqlite3", connection.station_id)
                    try:
                        day = confirm_no_issuance(ledger, setting, args.part_no, args.reason, actor)
                    finally:
                        ledger.close()
                    print("Serial authorization recorded for {}.".format(day))
                elif args.command == "restore":
                    connection = load_connection(args.data_dir)
                    if verify_snapshot(args.backup)["station_id"] != connection.station_id:
                        raise ValueError("Backup belongs to another station")
                    restore_snapshot(args.backup, args.data_dir / "ledger.sqlite3")
                    print("Verified snapshot restored.")
                elif args.command == "resume":
                    connection = load_connection(args.data_dir)
                    path = args.data_dir / "ledger.sqlite3"
                    if not path.is_file():
                        raise ValueError("There is no ledger to resume")
                    ledger = Ledger(path, connection.station_id)
                    try:
                        with ledger.transaction() as conn:
                            conn.execute("UPDATE upload_state SET blocked_reason=NULL WHERE id=1")
                    finally:
                        ledger.close()
                    print("Delivery can retry on the next start.")
    except (ValueError, OSError, RuntimeError, sqlite3.Error, KeyError, TypeError) as exc:
        # Never print input, credential errors from HTTP, or file contents.
        message = str(exc) if type(exc) is ValueError and not hasattr(exc, "doc") else type(exc).__name__
        print("Field Agent: " + message, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
