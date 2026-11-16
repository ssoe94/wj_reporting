"""Install and run one field station from a portable folder."""

import argparse
from pathlib import Path
from queue import Full
import signal
import sqlite3
import sys
from threading import Event, Thread

from .backup import DEFAULT_MIN_FREE, restore_snapshot, verify_snapshot
from .config import configure, load_connection, station_lock
from .devices import MAX_FRAME_BYTES
from .ledger import Ledger
from .protocol import encode
from .runtime import Runtime
from .transport import Transport


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


def _run(args):
    if args.backup_keep < 1 or args.backup_idle < 0 or args.min_free_mib < 0 or not 1 <= args.port <= 65535:
        raise ValueError("Invalid port or backup settings")
    connection = load_connection(args.data_dir)
    ledger = Ledger(args.data_dir / "ledger.sqlite3", connection.station_id)
    try:
        runtime = Runtime(ledger, Transport(connection.server, connection.token), demo=args.fake_stdin,
                          port=args.port, backup_idle=args.backup_idle, backup_keep=args.backup_keep,
                          min_free_bytes=args.min_free_mib * 1024 * 1024)
        stop = Event()
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, lambda *_args: stop.set())
        runtime.start()
        try:
            if args.fake_stdin:
                Thread(name="field-stdin", target=_feed_stdin, args=(runtime, stop), daemon=True).start()
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
    run = commands.add_parser("run", help="Run the station and its localhost screen")
    run.add_argument("--port", type=int, default=8769)
    run.add_argument("--fake-stdin", action="store_true", help="Record test-only barcode frames from stdin")
    run.add_argument("--backup-idle", type=int, default=60)
    run.add_argument("--backup-keep", type=int, default=30)
    run.add_argument("--min-free-mib", type=int, default=DEFAULT_MIN_FREE // (1024 * 1024))
    resume = commands.add_parser("resume", help="Retry an intact blocked batch after the cause is corrected")
    restore = commands.add_parser("restore", help="Restore a verified same-generation backup into a fresh ledger path")
    restore.add_argument("--backup", type=Path, required=True)
    restore.add_argument("--confirmed-same-generation", action="store_true", required=True)
    for command in (install, run, resume, restore):
        command.add_argument("--data-dir", type=Path, required=True)
    verify = commands.add_parser("verify-backup", help="Verify a backup file and its pending batches")
    verify.add_argument("--backup", type=Path, required=True)
    return parser.parse_args()


def main():
    args = _args()
    try:
        if args.command == "configure":
            configure(args.data_dir, args.connection)
            print("Field connection stored.")
        elif args.command == "verify-backup":
            print(encode(verify_snapshot(args.backup)).decode())
        else:
            with station_lock(args.data_dir):
                if args.command == "run":
                    _run(args)
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
