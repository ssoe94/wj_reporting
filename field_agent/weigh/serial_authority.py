"""Establish a today's first serial from durable, attributable evidence."""

from contextlib import closing
from hashlib import sha256
import os
from pathlib import Path
import sqlite3
from time import monotonic

from .. import __version__
from ..protocol import event_time, timestamp
from . import issuer_policy
from .legacy import open_readonly
from .serials import get_date_code
from .settings import MAX_SERIAL


REQUIRED = "serial_floor_required"
UNAVAILABLE = "serial_source_unavailable"
SCHEMA = f"""CREATE TABLE IF NOT EXISTS weigh_serial_authority (
    part_no TEXT NOT NULL,
    print_date TEXT NOT NULL,
    date_code TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('legacy', 'admin_no_issuance')),
    floor INTEGER NOT NULL CHECK(floor BETWEEN 0 AND {MAX_SERIAL}),
    event_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
    PRIMARY KEY(part_no, print_date)
)"""
FLOOR_GUARDS = (
    """CREATE TRIGGER IF NOT EXISTS weigh_serial_authority_no_update BEFORE UPDATE ON weigh_serial_authority
    BEGIN SELECT RAISE(ABORT, 'serial evidence is append-only'); END""",
    """CREATE TRIGGER IF NOT EXISTS weigh_serial_authority_no_delete BEFORE DELETE ON weigh_serial_authority
    BEGIN SELECT RAISE(ABORT, 'serial evidence is append-only'); END""",
)


def install(conn):
    conn.execute(SCHEMA)
    for guard in FLOOR_GUARDS:
        conn.execute(guard)


def _match(part, day):
    # Date encodes a one-digit year. A historic date with identical printed
    # date code supplies a lower bound, but cannot authorize a new day's use.
    return part, day[-5:], day[3]


def historical_max(conn, part, day):
    maximum = conn.execute("""SELECT MAX(last_serial) FROM weigh_serials
        WHERE part_no=? AND substr(print_date,6)=? AND substr(print_date,4,1)=?""", _match(part, day)).fetchone()[0]
    return 0 if maximum is None else _valid_floor(maximum)


def _valid_floor(value):
    if type(value) is not int or not 0 <= value <= MAX_SERIAL:
        raise ValueError("Invalid source serial evidence")
    return value


def _local_file(path):
    normalized = Path(path).resolve(strict=True)
    if not normalized.is_file() or str(normalized).startswith(("//", "\\\\")):
        raise ValueError("Legacy serial evidence requires a local SQLite file")
    if os.name == "nt":
        import ctypes
        if ctypes.windll.kernel32.GetDriveTypeW(normalized.anchor) != 3:
            raise ValueError("Legacy serial evidence requires a local fixed disk")
    return normalized


def legacy_floor(path, ledger_path, part, day):
    """Read both legacy counter and reserved jobs from one bounded snapshot."""
    source = _local_file(path)
    if source == ledger_path or os.path.samefile(source, ledger_path):
        raise ValueError("Legacy serial evidence requires a separate database")
    before = source.stat()
    start = monotonic()
    with closing(open_readonly(source)) as conn:
        conn.set_progress_handler(lambda: int(monotonic() - start > 0.2), 1000)
        conn.execute("BEGIN")
        if not (conn.execute("SELECT 1 FROM jobs LIMIT 1").fetchone()
                or conn.execute("SELECT 1 FROM serials LIMIT 1").fetchone()):
            raise ValueError("The configured legacy database has no issuance history")
        # Sort malformed nonnumeric data above numeric data on SQLite so that
        # an untrustworthy maximum blocks issuance rather than becoming zero.
        raw = conn.execute("""SELECT MAX(last_serial) FROM (
            SELECT last_serial FROM serials
            WHERE part_no=? COLLATE NOCASE AND substr(print_date,6)=? AND substr(print_date,4,1)=?
            UNION ALL
            SELECT last_serial FROM jobs
            WHERE part_no=? COLLATE NOCASE AND substr(print_date,6)=? AND substr(print_date,4,1)=?
        )""", _match(part, day) * 2).fetchone()[0]
        after = source.stat()
        if not os.path.samestat(before, after):
            raise ValueError("Legacy serial evidence changed during inspection")
        floor = 0 if raw is None else _valid_floor(raw)
        identity = sha256(os.fsencode(str(source)) + f":{before.st_dev}:{before.st_ino}".encode()).hexdigest()
        return floor, identity


def saved_floor(conn, part, day):
    row = conn.execute("SELECT MAX(floor) FROM weigh_serial_authority WHERE part_no=? AND print_date=?",
                       (part, day)).fetchone()
    return row[0]


def local_today(conn, part, day):
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='weigh_jobs' AND type='table'").fetchone():
        return None
    issued = conn.execute("SELECT MAX(serial) FROM weigh_jobs WHERE part_no=? AND print_date=?",
                          (part, day)).fetchone()[0]
    if issued is None:
        return None
    counter = conn.execute("SELECT last_serial FROM weigh_serials WHERE part_no=? AND print_date=?",
                           (part, day)).fetchone()
    return max(_valid_floor(issued), _valid_floor(counter[0]) if counter else 0)


def _record(ledger, conn, settings, part, moment, floor, kind, *, extra):
    calendar = event_time(moment).date()
    day, date_code = calendar.isoformat(), get_date_code(calendar)
    stored = issuer_policy.current(conn)
    version = issuer_policy.effective_version(settings.products[part].version, stored["sha256"] if stored else None)
    seq = ledger.append(conn, {
        "app": "weigh_label", "type": "operator.action", "result": "info", "mode": settings.mode,
        "reason": "serial_floor_imported" if kind == "legacy" else "serial_no_issuance_confirmed",
        "occurred_at": moment, "agent_version": __version__, "app_version": __version__,
        "config_version": version, "part_no": part,
        "detail": dict(extra, action=kind, print_date=day, date_code=date_code, serial_floor=floor),
    })
    conn.execute("INSERT INTO weigh_serial_authority VALUES(?,?,?,?,?,?)", (part, day, date_code, kind, floor, seq))


def establish(ledger, conn, settings, part, moment):
    day = event_time(moment).date().isoformat()
    existing = local_today(conn, part, day)
    if existing is not None:
        return max(existing, historical_max(conn, part, day)), None
    floor = saved_floor(conn, part, day)
    if floor is not None:
        return max(floor, historical_max(conn, part, day)), None
    if not settings.legacy_print_db:
        return None, REQUIRED
    try:
        floor, identity = legacy_floor(settings.legacy_print_db, ledger.path, part, day)
    except (sqlite3.Error, OSError, ValueError, TypeError):
        return None, UNAVAILABLE
    floor = max(floor, historical_max(conn, part, day))
    _record(ledger, conn, settings, part, moment, floor, "legacy", extra={"source_fingerprint": identity})
    return floor, None


def confirm_no_issuance(ledger, settings, part, reason, actor, *, clock=timestamp):
    if part not in settings.products:
        raise ValueError("PART must be in the weigh configuration")
    if (not isinstance(reason, str) or not isinstance(actor, str) or not reason.strip() or not actor.strip()
            or len(reason) > 240 or len(actor) > 100 or not reason.isprintable() or not actor.isprintable()):
        raise ValueError("An administrator account and meaningful confirmation reason are required")
    moment = clock()
    day = event_time(moment).date().isoformat()
    with ledger.transaction() as conn:
        install(conn)
        if conn.execute("SELECT 1 FROM sqlite_master WHERE name='weigh_issuer_policy'").fetchone() is None:
            raise ValueError("Import the station issuer policy before confirming a serial floor")
        assignment_id = issuer_policy.grant(conn, issuer_policy.namespace(settings), part)
        if assignment_id is None:
            raise ValueError("This station is not assigned to issue labels for this PART")
        if issuer_policy.inherited_bound(conn, assignment_id, event_time(moment).date()) is not None:
            raise ValueError("Confirm the inherited serial ceiling for this assignment")
        if local_today(conn, part, day) is not None or saved_floor(conn, part, day) is not None:
            raise ValueError("Serial evidence is already established")
        if settings.legacy_print_db:
            # An explicit no-issuance declaration must not override a known
            # conflicting issuer from the configured source.
            try:
                observed, _identity = legacy_floor(settings.legacy_print_db, ledger.path, part, day)
            except (sqlite3.Error, OSError, ValueError, TypeError):
                observed = None
            if observed:
                raise ValueError("Legacy reservations exist; use their automatic ceiling")
        _record(ledger, conn, settings, part, moment, 0, "admin_no_issuance",
                extra={"actor": actor.strip(), "reason": reason.strip()})
    return day


def local_admin_actor(data_dir):
    """Use the OS principal rather than accepting a browser or CLI display name."""
    if os.name == "nt":
        import ctypes
        if not ctypes.windll.shell32.IsUserAnAdmin():
            raise ValueError("Run serial authorization in an elevated administrator shell")
        size = ctypes.c_ulong(256)
        result = ctypes.create_unicode_buffer(size.value)
        if not ctypes.windll.advapi32.GetUserNameW(result, ctypes.byref(size)):
            raise ValueError("Unable to identify the Windows administrator")
        return result.value
    import pwd
    owner = Path(data_dir).stat()
    if owner.st_uid != os.geteuid() or owner.st_mode & 0o022:
        raise ValueError("Use the owner of the private station data directory")
    return pwd.getpwuid(os.geteuid()).pw_name
