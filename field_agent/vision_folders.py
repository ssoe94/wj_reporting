"""Incrementally observe committed vision records, without reading media bytes."""

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat

from . import __version__
from .protocol import encode, event_time, timestamp


_ENTRY_LIMIT = 256
_DOCUMENT_LIMIT = 32
_DIRECTORY_PROBES = 12
_MAX_JSON_BYTES = 128 * 1024
_ID = re.compile(r"[A-Za-z0-9_-]{1,96}", re.ASCII)
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", re.ASCII)
_HASH = re.compile(r"[a-f0-9]{64}", re.ASCII)
_UV_REASONS = {"point_1", "point_2", "unreadable", "multiple", "duplicate"}

_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS vision_folder_sources (
        source TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, last_work_at TEXT,
        last_mode TEXT NOT NULL DEFAULT 'unknown'
    )""",
    """CREATE TABLE IF NOT EXISTS vision_folder_directories (
        source TEXT NOT NULL, path TEXT NOT NULL, level INTEGER NOT NULL,
        fingerprint TEXT, entry_count INTEGER NOT NULL DEFAULT 0, anchor TEXT, anchor_stamp TEXT,
        visited INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(source,path)
    )""",
    """CREATE INDEX IF NOT EXISTS vision_folders_due ON vision_folder_directories(source,visited,path)""",
    """CREATE TABLE IF NOT EXISTS vision_folder_entries (
        source TEXT NOT NULL, path TEXT NOT NULL, fingerprint TEXT NOT NULL,
        PRIMARY KEY(source,path)
    )""",
    """CREATE TABLE IF NOT EXISTS vision_folder_ids (
        app TEXT NOT NULL, stable_id TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
        PRIMARY KEY(app,stable_id)
    )""",
    """CREATE TABLE IF NOT EXISTS vision_capture_pair_state (
        pair_id TEXT PRIMARY KEY, status TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS vision_capture_faces (
        pair_id TEXT NOT NULL, side TEXT NOT NULL, details TEXT NOT NULL, PRIMARY KEY(pair_id,side)
    )""",
)


def _digest(data):
    return sha256(data).hexdigest()


def _json(value):
    return encode(value).decode("utf-8")


def _require(condition):
    if not condition:
        raise ValueError("Invalid source record")


def _stable_id(value):
    _require(isinstance(value, str) and _ID.fullmatch(value))
    return value


def _visible_text(value, limit, *, byte_limit=None):
    if not isinstance(value, str) or not 0 < len(value) <= limit or not value.isprintable():
        return None
    try:
        length = len(value.encode("utf-8"))
    except UnicodeError:
        return None
    return value if byte_limit is None or length <= byte_limit else None


def _valid_day(value):
    if not _DATE.fullmatch(value):
        return False
    try:
        return date.fromisoformat(value).year in range(2, 9999)
    except ValueError:
        return False


def _safe_regular(info, expected):
    # Disallow all Windows reparse points as well as POSIX symlinks.
    return not (getattr(info, "st_file_attributes", 0) & 0x400) and expected(info.st_mode)


def _checked_stat(path, expected):
    info = path.lstat()
    _require(_safe_regular(info, expected))
    return info


def _checked_under(root, relative, expected):
    parts = PurePosixPath(relative).parts
    path = root
    for component in parts[:-1]:
        path /= component
        _checked_stat(path, stat.S_ISDIR)
    if parts:
        path /= parts[-1]
    return _checked_stat(path, expected)


def _identity(info):
    return "{}:{}".format(info.st_dev, info.st_ino)


def _stamp(info):
    return "{}:{}:{}".format(_identity(info), info.st_mtime_ns, info.st_size)


def _moment(label, expected_day):
    _require(isinstance(label, str))
    # UV writes datetime.isoformat() with up to six fractional digits,
    # while the field wire protocol retains explicitly bounded milliseconds.
    label = re.sub(r"(\.[0-9]{3})[0-9]{1,3}(?=Z|[+-])", r"\1", label)
    parsed = event_time(label)
    _require(parsed.date().isoformat() == expected_day)
    return timestamp(parsed)


def _no_duplicates(entries):
    result = {}
    for key, value in entries:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _no_constant(_value):
    raise ValueError("Non-finite JSON number")


def _read_document(path, fingerprint):
    # The final publication markers are data-only. Verify an unchanged file
    # across open/read so a replaced or symlinked document cannot provide evidence.
    before = _checked_stat(path, stat.S_ISREG)
    _require(_stamp(before) == fingerprint and before.st_size <= _MAX_JSON_BYTES)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        _require(_stamp(os.fstat(stream.fileno())) == fingerprint)
        raw = stream.read(_MAX_JSON_BYTES + 1)
    _require(len(raw) <= _MAX_JSON_BYTES and _stamp(_checked_stat(path, stat.S_ISREG)) == fingerprint)
    data = json.loads(raw, object_pairs_hook=_no_duplicates, parse_float=Decimal, parse_constant=_no_constant)
    _require(isinstance(data, dict))
    return data, _digest(raw), len(raw)


@dataclass
class _Traversal:
    row: dict
    identity: str
    stamp: str
    iterator: object
    count: int = 0
    new_paths: int = 0
    anchor: str = ""
    anchor_stamp: str = ""
    buffered: list = field(default_factory=list)
    exhausted: bool = False


class _FolderCollector:
    root_level = 0

    def __init__(self, ledger, root):
        self.ledger = ledger
        self.root = Path(root).expanduser().resolve()
        if self.root == self.ledger.path or self.root in self.ledger.path.parents:
            raise ValueError("Source folder must be separate from the agent ledger")
        self.source = _digest(self.app.encode() + b"\0" + os.fsencode(str(self.root)))
        self.current = None
        self.source_state = "unknown"
        self.metadata_bytes_read = 0
        self.directory_entries_seen = 0
        with self.ledger.transaction() as conn:
            for statement in _SCHEMA:
                conn.execute(statement)
            conn.execute("INSERT OR IGNORE INTO vision_folder_sources(source) VALUES(?)", (self.source,))
            conn.execute(
                "INSERT OR IGNORE INTO vision_folder_directories(source,path,level) VALUES(?,?,?)",
                (self.source, ".", self.root_level),
            )
            self.last_work_at, self.last_mode = conn.execute(
                "SELECT last_work_at,last_mode FROM vision_folder_sources WHERE source=?", (self.source,)
            ).fetchone()

    def close(self):
        if self.current is not None:
            self.current.iterator.close()
            self.current = None

    def status(self):
        # Directory observation cannot establish process liveness or prove that
        # a source never lost records between bounded reconciliation passes.
        return {"coverage": "partial", "state": self.source_state, "mode": self.last_mode,
                "last_work_at": self.last_work_at, "devices": []}

    def _gap(self, conn, cause, relative):
        self.ledger.append(conn, {
            "app": self.app, "type": "operator.action", "mode": "unknown", "result": "info",
            "reason": "vision_source_gap", "occurred_at": timestamp(),
            "agent_version": __version__,
            "ref": {"source_key": _digest((self.source + "\0" + relative).encode("utf-8"))},
            "detail": {"action": "observe_source_gap", "causes": [cause], "stream": self.app},
        })
        return 1

    def _new_revision(self, conn):
        conn.execute("UPDATE vision_folder_sources SET revision=revision+1 WHERE source=?", (self.source,))
        return conn.execute("SELECT revision FROM vision_folder_sources WHERE source=?", (self.source,)).fetchone()[0]

    def _visit(self, conn, relative, revision):
        conn.execute(
            "UPDATE vision_folder_directories SET visited=? WHERE source=? AND path=?",
            (revision, self.source, relative),
        )

    def _due(self):
        with self.ledger.read() as conn:
            return [dict(row) for row in conn.execute(
                """SELECT path,level,fingerprint,entry_count,anchor,anchor_stamp FROM vision_folder_directories
                WHERE source=? ORDER BY visited,path LIMIT ?""", (self.source, _DIRECTORY_PROBES)
            )]

    def _anchor_matches(self, row):
        if row["anchor"] is None:
            return True
        try:
            return _stamp(_checked_under(self.root, row["anchor"], stat.S_ISREG)) == row["anchor_stamp"]
        except (ValueError, OSError):
            return False

    def _schedule(self):
        outcomes = []
        walk = None
        for row in self._due():
            path = self.root / row["path"]
            try:
                info = _checked_under(self.root, row["path"], stat.S_ISDIR)
                fingerprint = _stamp(info)
                if fingerprint == row["fingerprint"] and self._anchor_matches(row):
                    if row["path"] == ".":
                        self.source_state = "running"
                    outcomes.append((row["path"], fingerprint, None))
                    continue
                walk = _Traversal(row, _identity(info), fingerprint, os.scandir(path))
                if row["path"] == ".":
                    self.source_state = "running"
                break
            except (ValueError, OSError):
                if row["path"] == ".":
                    self.source_state = "fault"
                if row["fingerprint"] == "missing":
                    outcomes.append((row["path"], "missing", None))
                else:
                    cause = "source_directory_unavailable" if row["fingerprint"] or row["path"] == "." else None
                    outcomes.append((row["path"], "missing", cause))
        added = 0
        if outcomes or walk:
            try:
                with self.ledger.transaction() as conn:
                    revision = self._new_revision(conn)
                    for relative, signature, cause in outcomes:
                        self._visit(conn, relative, revision)
                        if cause:
                            added += self._gap(conn, cause, relative)
                        if signature == "missing":
                            conn.execute("""UPDATE vision_folder_directories SET fingerprint=?,entry_count=0,anchor=NULL,anchor_stamp=NULL
                                WHERE source=? AND path=? AND fingerprint IS NOT ?""",
                                (signature, self.source, relative, signature))
                    if walk:
                        self._visit(conn, walk.row["path"], revision)
            except Exception:
                if walk:
                    walk.iterator.close()
                raise
        self.current = walk
        return added

    def _take_entries(self, walk):
        candidates = []
        done = False
        for _ in range(_ENTRY_LIMIT):
            item = next(walk.iterator, None)
            if item is None:
                done = True
                break
            self.directory_entries_seen += 1
            leaf = self._entry_kind(walk.row["level"], item.name)
            if leaf is None:
                continue
            relative = (PurePosixPath(walk.row["path"]) / item.name).as_posix()
            try:
                check = stat.S_ISDIR if (not leaf or self.app == "vision_uv") else stat.S_ISREG
                info = item.stat(follow_symlinks=False)
                if not _safe_regular(info, check):
                    continue
                document = relative + "/result.json" if leaf and self.app == "vision_uv" else relative
                if document != relative:
                    info = _checked_under(self.root, document, stat.S_ISREG)
                mark = _stamp(info)
                if leaf and document > walk.anchor:
                    walk.anchor, walk.anchor_stamp = document, mark
                candidates.append((relative, leaf, document, mark))
            except (ValueError, OSError):
                # A final filename with missing required data is a source gap,
                # not a failed inspection or a synthesized capture.
                candidates.append((relative, leaf, relative, "unavailable"))
        return candidates, done

    def _prepare(self, entries):
        new = []
        read_count = consumed = 0
        with self.ledger.read() as conn:
            for relative, leaf, document, mark in entries:
                existing = conn.execute(
                    "SELECT fingerprint FROM vision_folder_entries WHERE source=? AND path=?", (self.source, relative)
                ).fetchone()
                if existing is None or existing["fingerprint"] != mark:
                    opens_document = leaf and mark != "unavailable"
                    if opens_document and read_count == _DOCUMENT_LIMIT:
                        break
                    read_count += int(opens_document)
                    new.append((relative, leaf, document, mark, existing is None))
                consumed += 1
        parsed = []
        for relative, leaf, document, mark, first in new:
            result = None
            malformed = mark == "unavailable"
            if leaf and not malformed:
                try:
                    data, checksum, length = _read_document(self.root / document, mark)
                    self.metadata_bytes_read += length
                    result = self._interpret(relative, data, checksum)
                except (OSError, ValueError, ArithmeticError, UnicodeError, RecursionError):
                    malformed = True
            parsed.append((relative, leaf, mark, first, result, malformed))
        return parsed, consumed

    def _save_entries(self, walk, entries, *, completed, count, new_paths):
        added = 0
        last_work_at, last_mode = self.last_work_at, self.last_mode
        with self.ledger.transaction() as conn:
            revision = self._new_revision(conn)
            for relative, leaf, mark, _first, result, malformed in entries:
                conn.execute("""INSERT INTO vision_folder_entries VALUES(?,?,?)
                    ON CONFLICT(source,path) DO UPDATE SET fingerprint=excluded.fingerprint""",
                    (self.source, relative, mark))
                if malformed:
                    added += self._gap(conn, "source_record_unavailable", relative)
                elif not leaf:
                    conn.execute(
                        """INSERT OR IGNORE INTO vision_folder_directories(source,path,level) VALUES(?,?,?)""",
                        (self.source, relative, walk.row["level"] + 1),
                    )
                else:
                    emitted, work = self._observe(conn, result, relative)
                    added += emitted
                    if work is not None and (last_work_at is None or work[0] >= last_work_at):
                        last_work_at, last_mode = work
            if completed:
                previous = walk.row["fingerprint"]
                if previous not in (None, "missing") and previous.rsplit(":", 2)[0] != walk.identity:
                    added += self._gap(conn, "source_directory_replaced", walk.row["path"])
                elif previous not in (None, "missing") and count < walk.row["entry_count"] + new_paths:
                    added += self._gap(conn, "source_entries_removed", walk.row["path"])
                conn.execute("""UPDATE vision_folder_directories SET fingerprint=?,entry_count=?,anchor=?,anchor_stamp=?
                    WHERE source=? AND path=?""", (walk.stamp, count, walk.anchor or None,
                                                   walk.anchor_stamp or None, self.source, walk.row["path"]))
            if (last_work_at, last_mode) != (self.last_work_at, self.last_mode):
                conn.execute("UPDATE vision_folder_sources SET last_work_at=?,last_mode=? WHERE source=?",
                             (last_work_at, last_mode, self.source))
            self._visit(conn, walk.row["path"], revision)
        self.last_work_at, self.last_mode = last_work_at, last_mode
        return added

    def poll(self):
        added = self._schedule() if self.current is None else 0
        walk = self.current
        if walk is None:
            return added
        try:
            # Check the open directory's identity as well as the path. A moved
            # directory's old iterator must not label its replacement clean.
            info = _checked_under(self.root, walk.row["path"], stat.S_ISDIR)
            if _identity(info) != walk.identity:
                self.close()
                return added
            if not walk.buffered:
                walk.buffered, walk.exhausted = self._take_entries(walk)
            prepared, consumed = self._prepare(walk.buffered)
            del walk.buffered[:consumed]
            done = walk.exhausted and not walk.buffered
            count = walk.count + consumed
            new_paths = walk.new_paths + sum(1 for *_, first, _result, _malformed in prepared if first)
            after = _checked_under(self.root, walk.row["path"], stat.S_ISDIR)
            if _identity(after) != walk.identity:
                self.close()
                return added
            if prepared or done:
                added += self._save_entries(walk, prepared, completed=done and _stamp(after) == walk.stamp,
                                            count=count, new_paths=new_paths)
            if done:
                self.close()
            else:
                walk.count, walk.new_paths = count, new_paths
            return added
        except (OSError, ValueError):
            if walk.row["path"] == ".":
                self.source_state = "fault"
            self.close()
            return added
        except Exception:
            # The iterator may have advanced before a local transaction
            # failed. Retry the dirty directory with its durable ID index.
            self.close()
            raise

    def _claim(self, conn, stable_id, checksum, relative):
        previous = conn.execute("SELECT manifest_sha256 FROM vision_folder_ids WHERE app=? AND stable_id=?",
                                (self.app, stable_id)).fetchone()
        if previous is not None:
            added = 0 if previous[0] == checksum else self._gap(conn, "source_id_changed", relative)
            return False, added
        conn.execute("INSERT INTO vision_folder_ids VALUES(?,?,?)", (self.app, stable_id, checksum))
        return True, 0

    def _event(self, kind, stable_id, *, moment, mode, result, reason, detail, **extra):
        refs = dict(extra.pop("ref", {}), source_key=self.app + ":" + stable_id)
        return {
            "app": self.app, "type": kind, "occurred_at": moment, "mode": mode,
            "result": result, "reason": reason, "agent_version": __version__,
            "ref": refs, "detail": detail, **extra,
        }


class CaptureCollector(_FolderCollector):
    app = "vision_capture"

    def __init__(self, ledger, root, *, auto_mode="unknown"):
        if auto_mode not in ("unknown", "production", "test"):
            raise ValueError("Invalid automatic capture mode")
        self.auto_mode = auto_mode
        name = Path(root).expanduser().resolve().name
        self.branch = name if name in ("production", "demo") else None
        self.root_level = 0 if self.branch else -1
        super().__init__(ledger, root)

    @staticmethod
    def _entry_kind(level, name):
        if level == -1 and name in ("production", "demo"):
            return False
        if level == 0 and _valid_day(name):
            return False
        if level == 1 and not name.startswith("."):
            return False
        if level == 2 and name.endswith(".json") and _ID.fullmatch(name[:-5]):
            return True
        return None

    def _interpret(self, path, data, checksum):
        pieces = PurePosixPath(path).parts
        branch, day, _part_folder, filename = (self.branch, *pieces) if self.branch else pieces
        capture_id = _stable_id(data.get("capture_id"))
        _require(type(data.get("schema_version")) is int and data["schema_version"] == 1
                 and filename == capture_id + ".json" and data.get("image_file") == capture_id + ".png")
        digest = data.get("sha256")
        _require(isinstance(digest, str) and _HASH.fullmatch(digest))
        _checked_under(self.root, PurePosixPath(path).with_suffix(".png"), stat.S_ISREG)
        production = data.get("production") or {}
        _require(isinstance(production, dict))
        part = _visible_text(data.get("product_code"), 128)
        declared_part = _visible_text(production.get("part_no"), 128)
        source = production.get("source")
        if source not in ("manual", "wj_reporting"):
            source = "unknown"
        trigger = data.get("trigger")
        simulated = data.get("is_simulated")
        if branch == "demo" or simulated is True:
            mode = "demo"
        elif trigger == "manual" or source == "manual":
            mode = "manual"
        elif simulated is False and trigger == "automatic" and source == "wj_reporting" and part == declared_part and part:
            mode = self.auto_mode
        else:
            mode = "unknown"
        # The producer binds both faces to these values. Keep only an opaque
        # local digest of private pair context, never operator/lot data on wire.
        binding = [source, part]
        for value in (production.get("machine_number"), data.get("lot"), data.get("operator"),
                      data.get("quality_label")):
            binding.append(value if type(value) is int else _visible_text(value, 128))
        item = {"id": capture_id, "manifest": checksum, "occurred_at": _moment(data.get("timestamp"), day),
                "binding": _digest(encode(binding)),
                "image_sha256": digest, "app_version": _visible_text(data.get("app_version"), 64),
                "part_no": part, "assignment_source": source, "mode": mode}
        pair = data.get("pair_id")
        if trigger == "manual":
            _require(pair is None and not data.get("capture_side"))
            return item
        _require(trigger == "automatic")
        item["pair_id"] = _stable_id(pair)
        side, order = data.get("capture_side"), data.get("capture_sequence")
        _require(side in ("front", "back") and type(order) is int and order == {"front": 1, "back": 2}[side])
        item["side"] = side
        return item

    @staticmethod
    def _evidence(item, kind):
        return {"kind": kind, "id": item["id"], "sha256": item["image_sha256"]}

    def _observe(self, conn, item, relative):
        fresh, gap = self._claim(conn, item["id"], item["manifest"], relative)
        if not fresh:
            return gap, None
        if "pair_id" not in item:
            self.ledger.append(conn, self._event(
                "capture.single", item["id"], moment=item["occurred_at"], mode=item["mode"], result="info",
                reason="capture_single_saved", app_version=item["app_version"], part_no=item["part_no"],
                detail={"capture_id": item["id"], "assignment_source": item["assignment_source"]},
                evidence=[self._evidence(item, "capture_image")],
            ))
            return 1, (item["occurred_at"], item["mode"])
        return self._pair(conn, item, relative)

    def _pair(self, conn, item, relative):
        pair = item["pair_id"]
        saved = conn.execute("SELECT status FROM vision_capture_pair_state WHERE pair_id=?", (pair,)).fetchone()
        if saved is not None and saved["status"] != "pending":
            return self._gap(conn, "capture_pair_already_resolved", relative), None
        sides = {row["side"]: json.loads(row["details"]) for row in conn.execute(
            "SELECT side,details FROM vision_capture_faces WHERE pair_id=?", (pair,)
        )}
        if item["side"] in sides:
            # Different immutable IDs claim the same face. An absent back by
            # itself stays pending because the producer writes no abort marker.
            return self._finish_pair(conn, pair, [sides[item["side"]], item], "duplicate_capture_side")
        conn.execute("INSERT INTO vision_capture_faces VALUES(?,?,?)", (pair, item["side"], _json(item)))
        sides[item["side"]] = item
        if len(sides) < 2:
            conn.execute("INSERT OR IGNORE INTO vision_capture_pair_state VALUES(?,'pending')", (pair,))
            return 0, None
        front, back = sides["front"], sides["back"]
        # An installation may change its automatic-mode declaration between
        # polls. That changes the confidence on mode, not the two source faces.
        auto_modes = {"unknown", "production", "test"}
        matching_mode = front["mode"] == back["mode"] or {front["mode"], back["mode"]} <= auto_modes
        consistent = front["binding"] == back["binding"] and matching_mode
        cause = None if consistent else "capture_provenance_conflict"
        return self._finish_pair(conn, pair, [front, back], cause)

    def _finish_pair(self, conn, pair, items, cause):
        front, other = items
        mode = front["mode"] if front["mode"] == other["mode"] else "unknown"
        status = "incomplete" if cause else "complete"
        detail = {"pair_status": status, "assignment_source": front["assignment_source"]
                  if front["assignment_source"] == other["assignment_source"] else "unknown"}
        if cause:
            detail["cause"] = cause
        elif front["occurred_at"] > other["occurred_at"]:
            detail["source_time_order_anomaly"] = True
        moment = other["occurred_at"] if not cause else max(item["occurred_at"] for item in items)
        evidence = [self._evidence(item, "capture_" + item["side"]) for item in items]
        self.ledger.append(conn, self._event(
            "capture.pair", pair, moment=moment, mode=mode, result="error" if cause else "info",
            reason="capture_pair_incomplete" if cause else "capture_pair_saved",
            app_version=front["app_version"], ref={"pair_id": pair}, detail=detail,
            part_no=front["part_no"] if front["part_no"] == other["part_no"] else None, evidence=evidence,
        ))
        conn.execute("""INSERT INTO vision_capture_pair_state VALUES(?,?)
            ON CONFLICT(pair_id) DO UPDATE SET status=excluded.status""", (pair, status))
        return 1, (moment, mode)


def _canonical_hash(value):
    def numeric_decimal(item):
        if isinstance(item, Decimal):
            return format(item, "f") if item.is_finite() and abs(item.adjusted()) <= 32 else None
        raise TypeError("Unsupported recipe value")

    return _digest(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                              allow_nan=False, default=numeric_decimal).encode("utf-8"))


def _percentage(value):
    _require(type(value) in (Decimal, int))
    number = Decimal(value)
    _require(number.is_finite() and 0 <= number <= 100)
    # The protocol limits decimal length. Do not re-evaluate any passed flag.
    return format(number.quantize(Decimal("0.000000000001")), "f").rstrip("0").rstrip(".") or "0"


class UVCollector(_FolderCollector):
    app = "vision_uv"

    @staticmethod
    def _entry_kind(level, name):
        if level == 0 and name in ("manual", "demo"):
            return False
        if level == 1 and _valid_day(name):
            return False
        if level == 2 and _ID.fullmatch(name):
            return True
        return None

    def _interpret(self, path, data, checksum):
        mode, day, folder = PurePosixPath(path).parts
        batch = _stable_id(data.get("batch_id"))
        _require(batch == folder and type(data.get("passed")) is bool)
        for name in ("uv.png", "barcode.png"):
            _checked_under(self.root, PurePosixPath(path) / name, stat.S_ISREG)
        recipe = data.get("recipe")
        _require(isinstance(recipe, dict) and isinstance(recipe.get("slots"), list))
        slots = len(recipe["slots"])
        products = data.get("products")
        _require(1 <= slots <= 16 and isinstance(products, list) and len(products) == slots)
        expected_count = data.get("slot_count", slots)
        _require(type(expected_count) is int and expected_count == slots)
        output = {}
        for product in products:
            _require(isinstance(product, dict))
            position, alarms, passed = product.get("position"), product.get("alarms"), product.get("passed")
            _require(type(position) is int and 1 <= position <= slots and position not in output)
            _require(type(passed) is bool and isinstance(alarms, list) and len(alarms) <= 5
                     and all(isinstance(alarm, str) and alarm in _UV_REASONS for alarm in alarms)
                     and len(alarms) == len(set(alarms)) and passed == (not alarms))
            barcode = product.get("barcode")
            _require(barcode is None or _visible_text(barcode, 256, byte_limit=256))
            output[position] = {
                "position": position, "barcode": barcode, "result": "ok" if passed else "ng", "reasons": alarms,
                "point_1_percent": _percentage(product.get("point_1_percent")),
                "point_2_percent": _percentage(product.get("point_2_percent")),
            }
        passed = data["passed"]
        _require(passed == all(product["result"] == "ok" for product in output.values()))
        capture = data.get("capture") or {}
        _require(isinstance(capture, dict))
        _require(capture.get("is_simulated") is not True or mode == "demo")
        if capture.get("mode") is not None:
            _require(capture["mode"] == {"demo": "simulation", "manual": "manual"}[mode])
        return {"id": batch, "manifest": checksum, "moment": _moment(data.get("recorded_at"), day),
                "mode": mode, "passed": passed, "slots": slots, "recipe": _canonical_hash(recipe),
                "products": [output[index] for index in range(1, slots + 1)]}

    def _observe(self, conn, item, relative):
        fresh, added = self._claim(conn, item["id"], item["manifest"], relative)
        if not fresh:
            return added, None
        self.ledger.append(conn, self._event(
            "vision.batch", item["id"], moment=item["moment"], mode=item["mode"],
            result="ok" if item["passed"] else "ng", reason="uv_batch_pass" if item["passed"] else "uv_batch_fail",
            detail={"slot_count": item["slots"]}, ref={"batch_id": item["id"]}, config_version=item["recipe"],
            products=item["products"], evidence=[{"kind": "uv_result_manifest", "id": item["id"],
                                                  "sha256": item["manifest"]}],
        ))
        return 1, (item["moment"], item["mode"])
