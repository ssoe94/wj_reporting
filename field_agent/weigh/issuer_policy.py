"""Explicit station policy. SQLite guards persist across runtime rollback."""

from datetime import date
import json
from pathlib import Path
import re

from .. import __version__
from ..config import _atomic_file, _limited_read
from ..protocol import MAX_SEQUENCE, encode, event_time, timestamp
from .serials import get_date_code
from .settings import MAX_SERIAL, PART, hash_json

NOT_ALLOWED = "issuer_not_allowed"
TRANSFER_REQUIRED = "issuer_transfer_required"
NAMESPACE = re.compile(r"[A-Z0-9]{3}", re.ASCII)
MAX_GRANTS = 512
MAX_CEILINGS = 4096
CHECKPOINT = "issuer-policy-checkpoint.json"
SCHEMA = (
    """CREATE TABLE IF NOT EXISTS weigh_issuer_policy (
        revision INTEGER PRIMARY KEY CHECK(revision>=0),
        policy TEXT NOT NULL, sha256 TEXT NOT NULL, applied_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq)
    )""",
    """CREATE TRIGGER IF NOT EXISTS weigh_issuer_policy_no_update BEFORE UPDATE ON weigh_issuer_policy
        BEGIN SELECT RAISE(ABORT, 'issuer policy history is append-only'); END""",
    """CREATE TRIGGER IF NOT EXISTS weigh_issuer_policy_no_delete BEFORE DELETE ON weigh_issuer_policy
        BEGIN SELECT RAISE(ABORT, 'issuer policy history is append-only'); END""",
    """CREATE TABLE IF NOT EXISTS weigh_issuer_grants (
        namespace TEXT NOT NULL, part_no TEXT NOT NULL, assignment_id INTEGER NOT NULL UNIQUE,
        PRIMARY KEY(namespace,part_no)
    )""",
    """CREATE TABLE IF NOT EXISTS weigh_issuer_inherited (
        assignment_id INTEGER NOT NULL, date_code TEXT NOT NULL, floor INTEGER NOT NULL,
        PRIMARY KEY(assignment_id,date_code)
    )""",
    """CREATE TABLE IF NOT EXISTS weigh_issuer_confirmations (
        assignment_id INTEGER NOT NULL, print_date TEXT NOT NULL, floor INTEGER NOT NULL,
        event_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
        PRIMARY KEY(assignment_id,print_date)
    )""",
)
_JOB_GRANT = """
    SELECT g.assignment_id FROM weigh_issuer_grants g
    WHERE g.part_no=NEW.part_no AND g.namespace=substr(NEW.barcode,length(NEW.part_no)+1,3)
"""
RESERVE_GUARD = """CREATE TRIGGER IF NOT EXISTS weigh_issuer_reserve BEFORE INSERT ON weigh_jobs
    WHEN NOT EXISTS ({grant}) OR EXISTS (
        SELECT 1 FROM weigh_issuer_inherited i
        WHERE i.assignment_id=({grant}) AND i.date_code=substr(NEW.barcode,-7,3)
          AND (NEW.serial <= i.floor OR NOT EXISTS (
              SELECT 1 FROM weigh_issuer_confirmations c
              WHERE c.assignment_id=i.assignment_id AND c.print_date=NEW.print_date AND c.floor>=i.floor
          ))
    )
    BEGIN SELECT RAISE(ABORT, 'label issuer or confirmed serial floor required'); END
""".format(grant=_JOB_GRANT)
PRINT_GUARD = """CREATE TRIGGER IF NOT EXISTS weigh_issuer_dispatch BEFORE UPDATE OF state ON weigh_jobs
    WHEN NEW.state='dispatching' AND NOT EXISTS ({})
    BEGIN SELECT RAISE(ABORT, 'label issuer required for dispatch'); END
""".format(_JOB_GRANT)


def install(conn):
    for statement in (*SCHEMA, RESERVE_GUARD, PRINT_GUARD):
        conn.execute(statement)


def _require(condition):
    if not condition:
        raise ValueError("Invalid station issuer policy")


def _int(value, low=1, high=MAX_SEQUENCE):
    return type(value) is int and low <= value <= high


def _match(value, pattern):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _calendar(value):
    _require(isinstance(value, str) and len(value) == 10)
    parsed = date.fromisoformat(value)
    _require(parsed.isoformat() == value)
    return parsed


def prepare_policy(path):
    def unique(items):
        value = dict(items)
        _require(len(value) == len(items))
        return value

    payload = json.loads(_limited_read(Path(path), 8 * 1024 * 1024).decode("utf-8-sig"), object_pairs_hook=unique)
    _require(isinstance(payload, dict) and set(payload) == {"station_id", "revision", "grants"}
             and _match(payload["station_id"], re.compile(r"[A-Za-z0-9_-]{1,64}", re.ASCII))
             and _int(payload["revision"], 0) and isinstance(payload["grants"], list)
             and len(payload["grants"]) <= MAX_GRANTS and (payload["revision"] > 0 or not payload["grants"]))
    keys = set()
    ids = set()
    for row in payload["grants"]:
        _require(isinstance(row, dict) and set(row) == {"namespace", "part_no", "assignment_id", "transfer"}
                 and _match(row["namespace"], NAMESPACE) and _match(row["part_no"], PART)
                 and _int(row["assignment_id"]))
        key = (row["namespace"], row["part_no"])
        _require(key not in keys and row["assignment_id"] not in ids)
        keys.add(key)
        ids.add(row["assignment_id"])
        transfer = row["transfer"]
        if transfer is None:
            continue
        _require(isinstance(transfer, dict) and set(transfer) == {"previous_id", "ceilings"}
                 and _int(transfer["previous_id"]) and transfer["previous_id"] != row["assignment_id"]
                 and isinstance(transfer["ceilings"], list) and 1 <= len(transfer["ceilings"]) <= MAX_CEILINGS)
        dates = set()
        for item in transfer["ceilings"]:
            _require(isinstance(item, dict) and set(item) == {"print_date", "serial_floor"}
                     and _int(item["serial_floor"], 0, MAX_SERIAL))
            printed = _calendar(item["print_date"])
            _require(printed not in dates)
            dates.add(printed)
        transfer["ceilings"].sort(key=lambda item: item["print_date"])
    payload["grants"].sort(key=lambda row: (row["namespace"], row["part_no"]))
    return payload


def current(conn):
    return conn.execute("SELECT * FROM weigh_issuer_policy ORDER BY revision DESC LIMIT 1").fetchone()


def heartbeat(ledger):
    with ledger.read() as conn:
        if conn.execute("SELECT 1 FROM sqlite_master WHERE name='weigh_issuer_policy'").fetchone() is None:
            return None
        stored = current(conn)
    if stored is None:
        return None
    policy = json.loads(stored["policy"])
    return {"revision": stored["revision"], "sha256": stored["sha256"], "applied_seq": stored["applied_seq"],
            "grants": [{key: value for key, value in row.items() if key != "transfer"} for row in policy["grants"]]}


def namespace(settings):
    return settings.code["site_code"] + settings.code["vendor_code"]


def effective_version(version, digest):
    return hash_json({"product_version": version, "issuer_policy_sha256": digest})


def grant(conn, ns, part):
    row = conn.execute("SELECT assignment_id FROM weigh_issuer_grants WHERE namespace=? AND part_no=?",
                       (ns, part)).fetchone()
    return row[0] if row else None


def inherited_bound(conn, assignment_id, calendar):
    row = conn.execute("SELECT floor FROM weigh_issuer_inherited WHERE assignment_id=? AND date_code=?",
                       (assignment_id, get_date_code(calendar))).fetchone()
    return row[0] if row else None


def transfer_floor(conn, assignment_id, calendar):
    required = inherited_bound(conn, assignment_id, calendar)
    if required is None:
        return None, None
    row = conn.execute("SELECT floor FROM weigh_issuer_confirmations WHERE assignment_id=? AND print_date=?",
                       (assignment_id, calendar.isoformat())).fetchone()
    if row is None or row[0] < required:
        return None, TRANSFER_REQUIRED
    return row[0], None


def apply(ledger, policy, *, clock=timestamp):
    from .store import SCHEMA as WEIGH_SCHEMA

    if policy["station_id"] != ledger.station_id:
        raise ValueError("Issuer policy belongs to a different station")
    digest = hash_json(policy)
    with ledger.transaction() as conn:
        for statement in WEIGH_SCHEMA:
            conn.execute(statement)
        install(conn)
        previous = current(conn)
        revision = policy["revision"]
        if previous is not None and revision <= previous["revision"]:
            if revision == previous["revision"] and previous["sha256"] == digest:
                return digest
            raise ValueError("This issuer policy is older than or conflicts with the installed revision")
        keys = {(row["namespace"], row["part_no"]): row["assignment_id"] for row in policy["grants"]}
        for row in conn.execute("SELECT * FROM weigh_issuer_grants"):
            if keys.get((row["namespace"], row["part_no"])) == row["assignment_id"]:
                continue
            pending = conn.execute("""SELECT 1 FROM weigh_jobs j
                LEFT JOIN weigh_reconciliations r ON r.row_id=j.row_id
                LEFT JOIN weigh_peel p ON p.row_id=j.row_id
                WHERE j.part_no=? AND substr(j.barcode,length(j.part_no)+1,3)=?
                  AND (j.state IN ('waiting','dispatching') OR (j.state='uncertain' AND r.row_id IS NULL)
                       OR p.row_id IS NOT NULL)
                LIMIT 1""", (row["part_no"], row["namespace"])).fetchone()
            if pending:
                raise ValueError("Reconcile pending printing or peel work before withdrawing issuer authority")
        seq = ledger.append(conn, {
            "app": "weigh_label", "type": "operator.action", "result": "info", "mode": "unknown",
            "reason": "issuer_policy_applied", "occurred_at": clock(), "agent_version": __version__,
            "config_version": digest, "detail": {"action": "apply_issuer_policy", "revision": revision, "sha256": digest},
        })
        conn.execute("INSERT INTO weigh_issuer_policy VALUES(?,?,?,?)",
                     (revision, json.dumps(policy, ensure_ascii=False, separators=(",", ":")), digest, seq))
        conn.execute("DELETE FROM weigh_issuer_grants")
        conn.execute("DELETE FROM weigh_issuer_inherited")
        conn.executemany("INSERT INTO weigh_issuer_grants VALUES(?,?,?)",
                         [(ns, part, assignment_id) for (ns, part), assignment_id in keys.items()])
        for row in policy["grants"]:
            if row["transfer"]:
                bounds = {}
                for item in row["transfer"]["ceilings"]:
                    code = get_date_code(date.fromisoformat(item["print_date"]))
                    bounds[code] = max(bounds.get(code, 0), item["serial_floor"])
                conn.executemany("INSERT INTO weigh_issuer_inherited VALUES(?,?,?)",
                                 [(row["assignment_id"], code, floor) for code, floor in bounds.items()])
    return digest


def confirm_transfer(ledger, settings, part, reason, actor, *, clock=timestamp):
    if (part not in settings.products or not isinstance(reason, str) or not reason.strip()
            or len(reason) > 240 or not reason.isprintable()
            or not isinstance(actor, str) or not 1 <= len(actor) <= 100 or not actor.isprintable()):
        raise ValueError("A configured PART, administrator and reason are required")
    from .serial_authority import historical_max, local_today

    moment = clock()
    calendar = event_time(moment).date()
    day = calendar.isoformat()
    with ledger.transaction() as conn:
        if conn.execute("SELECT 1 FROM sqlite_master WHERE name='weigh_issuer_policy'").fetchone() is None:
            raise ValueError("Import the station issuer policy before confirming a transfer")
        assignment_id = grant(conn, namespace(settings), part)
        if assignment_id is None:
            raise ValueError("This station is not assigned to issue labels for this PART")
        previous = inherited_bound(conn, assignment_id, calendar)
        if previous is None:
            raise ValueError("There is no inherited ceiling for today's printed date; use regular serial evidence")
        existing, _blocked = transfer_floor(conn, assignment_id, calendar)
        if existing is not None:
            return day
        floor = max(previous, local_today(conn, part, day) or 0, historical_max(conn, part, day))
        stored = current(conn)
        seq = ledger.append(conn, {
            "app": "weigh_label", "type": "operator.action", "result": "info", "mode": settings.mode,
            "reason": "serial_transfer_confirmed", "occurred_at": moment, "agent_version": __version__,
            "app_version": __version__, "part_no": part,
            "config_version": effective_version(settings.products[part].version, stored["sha256"]),
            "detail": {"action": "confirm_serial_transfer", "actor": actor, "reason": reason.strip(),
                       "serial_floor": floor, "print_date": day, "issuer_assignment_id": assignment_id,
                       "issuer_namespace": namespace(settings), "issuer_policy_sha256": stored["sha256"]},
        })
        conn.execute("INSERT INTO weigh_issuer_confirmations VALUES(?,?,?,?)", (assignment_id, day, floor, seq))
    return day


def checkpoint(data, station_id):
    try:
        record = json.loads(_limited_read(Path(data) / CHECKPOINT, 512).decode("ascii"))
    except FileNotFoundError:
        return None
    _require(isinstance(record, dict) and set(record) == {"station_id", "revision", "sha256"}
             and record["station_id"] == station_id and _int(record["revision"], 0)
             and _match(record["sha256"], re.compile(r"[a-f0-9]{64}", re.ASCII)))
    return record["revision"], record["sha256"]


def check_runtime_checkpoint(ledger):
    reported = heartbeat(ledger)
    saved = checkpoint(ledger.path.parent, ledger.station_id)
    installed = (reported["revision"], reported["sha256"]) if reported else None
    if saved != installed:
        raise ValueError("Issuer policy checkpoint differs from the ledger; apply the current station export")


def check_restore_checkpoint(data, station_id, source):
    from contextlib import closing
    from ..backup import _open_snapshot

    saved = checkpoint(data, station_id)
    with closing(_open_snapshot(source)) as conn:
        exists = conn.execute("SELECT 1 FROM sqlite_master WHERE name='weigh_issuer_policy'").fetchone()
        prepared = current(conn) if exists else None
    installed = (prepared["revision"], prepared["sha256"]) if prepared else None
    if saved is not None and (installed is None or installed[0] < saved[0]
                              or (installed[0] == saved[0] and installed[1] != saved[1])):
        raise ValueError("Backup predates the station issuer policy; a withdrawn grant cannot be restored")
    return installed


def save_checkpoint(data, station_id, installed):
    revision, digest = installed
    _atomic_file(Path(data) / CHECKPOINT, encode({"station_id": station_id, "revision": revision, "sha256": digest}))


def apply_to_station(data, connection, policy):
    from contextlib import closing
    from ..ledger import Ledger
    from .serial_authority import local_admin_actor

    if policy["station_id"] != connection.station_id:
        raise ValueError("Issuer policy belongs to a different station")
    local_admin_actor(data)
    saved = checkpoint(data, connection.station_id)
    installed = (policy["revision"], hash_json(policy))
    if saved is not None and (installed[0] < saved[0] or (installed[0] == saved[0] and installed != saved)):
        raise ValueError("Issuer policy is older than or conflicts with the station checkpoint")
    with closing(Ledger(data / "ledger.sqlite3", connection.station_id)) as ledger:
        digest = apply(ledger, policy)
    save_checkpoint(data, connection.station_id, installed)
    return digest
