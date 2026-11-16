"""Notebook barcode rules with a durable, reset-scoped station workflow."""

import csv
import hashlib
import io
import json
import re
import sqlite3
from collections import deque
from copy import deepcopy
from pathlib import Path
from threading import RLock
from uuid import uuid4

from . import __version__
from .barcode_logic import BarcodeRules, build_field_parts
from .ledger import disk_full_error
from .protocol import business_day, encode, event_time, timestamp


LANES = ("A", "B")
MODES = ("test", "production")
RECENT_LIMIT = 20
HEX = re.compile(r"[A-Z0-9]+", re.ASCII)
STATUS = {
    "ok": ("scan_match", "정상", "正常"),
    "duplicate": ("scan_duplicate", "중복", "重复"),
    "invalid": ("scan_invalid", "유효하지 않은 바코드", "无效条码"),
    "over21": ("scan_overlength", "21자 초과", "超过 21 个字符"),
    "wrong_product_group": ("scan_wrong_product_group", "제품군 불일치", "产品组不符"),
    "wrong_scanner_A": ("scan_wrong_device", "스캐너 A에서 스캔 필요", "请使用 A 扫码枪"),
    "wrong_scanner_B": ("scan_wrong_device", "스캐너 B에서 스캔 필요", "请使用 B 扫码枪"),
}
FRAME_ERRORS = ("decode", "partial", "oversize")
TABLES = (
    """CREATE TABLE IF NOT EXISTS barcode_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        mode TEXT NOT NULL, production_group TEXT NOT NULL, assignments TEXT NOT NULL,
        reset_id INTEGER NOT NULL, config_version TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS barcode_decisions (
        seq INTEGER PRIMARY KEY REFERENCES events(seq),
        reset_id INTEGER NOT NULL, business_day TEXT NOT NULL, time TEXT NOT NULL,
        mode TEXT NOT NULL, lane TEXT NOT NULL, barcode TEXT NOT NULL, status TEXT NOT NULL,
        size TEXT NOT NULL, product_group TEXT NOT NULL
    )""",
    """CREATE INDEX IF NOT EXISTS barcode_ok_lookup
        ON barcode_decisions(mode, barcode, reset_id, seq) WHERE status='ok'""",
    """CREATE INDEX IF NOT EXISTS barcode_shift_lookup
        ON barcode_decisions(mode, reset_id, business_day, lane, seq)""",
    """CREATE TRIGGER IF NOT EXISTS barcode_decisions_no_update BEFORE UPDATE ON barcode_decisions
        BEGIN SELECT RAISE(ABORT, 'barcode decisions are append-only'); END""",
    """CREATE TRIGGER IF NOT EXISTS barcode_decisions_no_delete BEFORE DELETE ON barcode_decisions
        BEGIN SELECT RAISE(ABORT, 'barcode decisions are append-only'); END""",
)


def _text(value, limit):
    return isinstance(value, str) and 0 < len(value) <= limit and value.strip() == value and value.isprintable()


def _codes(values, maximum):
    return isinstance(values, list) and bool(values) and all(
        isinstance(code, str) and len(code) <= maximum and HEX.fullmatch(code) for code in values
    )


def load_barcode_config(path):
    """Load only local station rules; accept the notebook rule keys."""
    with Path(path).open("rb") as stream:
        body = stream.read(128 * 1024 + 1)
    try:
        if len(body) > 128 * 1024:
            raise ValueError
        config = json.loads(body.decode("utf-8-sig"))
        allowed = {"prefixes", "length", "parity_index", "allowed_sizes", "size_groups",
                   "site_vendor_codes", "serial_length", "any_scanner_parts", "field_parts", "part_rules"}
        known = allowed | {"production_group", "assignments"}
        if not isinstance(config, dict) or config.keys() - known:
            raise ValueError
        rules = {key: value for key, value in config.items() if key in allowed}
        for key, expected in (("length", 21), ("serial_length", 4), ("parity_index", 10)):
            actual = rules.setdefault(key, expected)
            if type(actual) is not int or actual != expected:
                raise ValueError
        if not _codes(rules.get("prefixes"), 17) or not _codes(rules.get("site_vendor_codes"), 17):
            raise ValueError
        groups = rules.get("size_groups")
        allowed_sizes = rules.get("allowed_sizes")
        if not _codes(allowed_sizes, 8) or not isinstance(groups, dict) or not groups:
            raise ValueError
        if any(not _text(name, 64) or not _codes(sizes, 8) or not set(sizes) <= set(allowed_sizes)
               for name, sizes in groups.items()):
            raise ValueError
        parts = rules.setdefault("part_rules", [])
        if not isinstance(parts, list):
            raise ValueError
        for part in parts:
            if (not isinstance(part, dict) or set(part) != {"part_no", "size", "group", "scanner"}
                    or not _codes([part["part_no"]], 17 - max(map(len, rules["site_vendor_codes"])))
                    or part["size"] not in groups[part["group"]]
                    or part["scanner"] not in ("A", "B", "ANY", "")):
                raise ValueError
        any_parts = rules.setdefault("any_scanner_parts", [])
        if any_parts != [] and not _codes(any_parts, 17):
            raise ValueError
        fields = rules.setdefault("field_parts", {})
        if not isinstance(fields, dict):
            raise ValueError
        for group, entry in fields.items():
            if group not in groups or not isinstance(entry, dict) or not entry or entry.keys() - set(LANES):
                raise ValueError
            for lane, part in entry.items():
                if not _codes([part], 17 - max(map(len, rules["site_vendor_codes"]))):
                    raise ValueError
                if build_field_parts(part[:-4], part[-4:] if lane == "A" else "",
                                     part[-4:] if lane == "B" else "")[lane] != part:
                    raise ValueError
        if not parts and not fields:
            raise ValueError
        group = config.get("production_group", "")
        if group not in groups:
            raise ValueError
        assignments = _assignments(config.get("assignments", {}), dict.fromkeys(LANES))
    except (KeyError, TypeError, ValueError, UnicodeError):
        raise ValueError("Invalid local barcode rule file") from None
    return rules, group, assignments


def _assignments(update, current):
    if not isinstance(update, dict) or update.keys() - set(LANES):
        raise ValueError("Invalid scanner assignments")
    result = dict(current)
    for lane, identity in update.items():
        if identity is not None and not _text(identity, 160):
            raise ValueError("Invalid scanner identity")
        result[lane] = identity
    if result["A"] is not None and result["A"] == result["B"]:
        raise ValueError("The same scanner cannot be assigned to both lanes")
    return result


def _config_version(rules, group, assignments):
    value = {"rules": rules, "production_group": group, "assignments": assignments}
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def _lane_state():
    return {"connected": False, "state": "disconnected", "last_input_at": None, "port": "",
            "frame_errors": dict.fromkeys(FRAME_ERRORS, 0)}


def _safe_csv(value):
    if value.lstrip().startswith(("=", "+", "-", "@", "＝", "＋", "－", "＠")) or value.startswith(("\t", "\r", "\n")):
        return "'" + value
    return value


class BarcodeApp:
    def __init__(self, ledger, config_path, changed, clock=timestamp):
        self.ledger = ledger
        self.changed = changed
        self.clock = clock
        self.lock = RLock()
        self.rules_data, default_group, default_assignments = load_barcode_config(config_path)
        self.rules = BarcodeRules(self.rules_data)
        self.lanes = {lane: _lane_state() for lane in LANES}
        self.storage_error = False
        self.disk_full = False
        self.coverage = "known"
        self.alert = None
        self.last_work_at = None
        self._shift = None
        self._committed = 0
        with ledger.transaction() as conn:
            for statement in TABLES:
                conn.execute(statement)
            stored = conn.execute("SELECT * FROM barcode_settings WHERE singleton=1").fetchone()
            self.mode = stored["mode"] if stored else "test"
            self.reset_id = stored["reset_id"] if stored else 0
            self.group = stored["production_group"] if stored and stored["production_group"] in self.rules.size_groups else default_group
            self.assignments = json.loads(stored["assignments"]) if stored else default_assignments
            self.config_version = _config_version(self.rules_data, self.group, self.assignments)
            if stored is None or stored["config_version"] != self.config_version:
                self._append(conn, "config.applied", "barcode_config_applied",
                             detail=self._config_detail(self.group, self.assignments))
                conn.execute("""INSERT INTO barcode_settings VALUES(1,?,?,?,?,?)
                    ON CONFLICT(singleton) DO UPDATE SET production_group=excluded.production_group,
                    assignments=excluded.assignments, config_version=excluded.config_version""",
                    (self.mode, self.group, encode(self.assignments).decode(), self.reset_id, self.config_version))
            self._append(conn, "app.started", "barcode_app_started")
        self._load_shift(self._day())
        with ledger.read() as conn:
            row = conn.execute("SELECT time FROM barcode_decisions ORDER BY seq DESC LIMIT 1").fetchone()
            self.last_work_at = row["time"] if row else None

    def _append(self, conn, kind, reason, *, moment=None, mode=None, config_version=None, **fields):
        return self.ledger.append(conn, {
            "occurred_at": moment or self.clock(), "app": "barcode", "type": kind,
            "app_version": __version__, "agent_version": __version__,
            "config_version": config_version or self.config_version,
            "mode": mode or self.mode, "result": "info", "reason": reason, **fields,
        })

    def _day(self, moment=None):
        return business_day(event_time(moment or self.clock()))

    def _config_detail(self, group, assignments):
        return {
            "production_group": group,
            "assignment_fingerprints": {
                lane: hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16] if identity else None
                for lane, identity in assignments.items()
            },
        }

    def _report_error(self, error):
        self.storage_error = True
        # sqlite_errorcode is available from Python 3.11. The resource probe
        # still reports low free space on the supported Python 3.8 runtime.
        self.disk_full = self.disk_full or disk_full_error(error)
        self.coverage = "partial"
        self.changed(state_changed=True, activity=True)

    def _saved(self, state_changed=False, activity=True, recovered=True):
        was_error = recovered and self.storage_error
        if recovered:
            self.storage_error = False
            self.disk_full = False
        self.changed(state_changed=state_changed or was_error, activity=activity)

    def _load_shift(self, day):
        key = (self.mode, self.reset_id, day)
        if key == self._shift:
            return
        counts = {lane: dict.fromkeys(("ok", "duplicate", "error"), 0) for lane in LANES}
        recent = {}
        with self.ledger.read() as conn:
            for row in conn.execute("""SELECT lane, status, COUNT(*) AS total FROM barcode_decisions
                    WHERE mode=? AND reset_id=? AND business_day=? GROUP BY lane, status""", key):
                counts[row["lane"]][self._category(row["status"])] += row["total"]
            for lane in LANES:
                rows = conn.execute("""SELECT seq, time, barcode, status FROM barcode_decisions
                    WHERE mode=? AND reset_id=? AND business_day=? AND lane=?
                    ORDER BY seq DESC LIMIT ?""", key + (lane, RECENT_LIMIT))
                recent[lane] = deque((dict(row) for row in rows), maxlen=RECENT_LIMIT)
        self._shift = key
        self.counts, self.recent = counts, recent

    @staticmethod
    def _category(status):
        return status if status in ("ok", "duplicate") else "error"

    def receive(self, lane, text, *, identity):
        with self.lock:
            if identity is None or self.assignments[lane] != identity:
                return None
            moment = self.clock()
            first_input = self.lanes[lane]["last_input_at"] is None
            self.lanes[lane]["last_input_at"] = moment
            try:
                day = self._day(moment)
                self._load_shift(day)
                barcode = self.rules.normalize_barcode(text)
                if len(barcode.encode("utf-8")) > 256:
                    # Unicode uppercasing can expand an otherwise bounded wire frame.
                    self.frame_error(lane, "oversize", identity=identity)
                    return None
                with self.ledger.transaction() as conn:
                    previous = conn.execute("""SELECT lane FROM barcode_decisions
                        WHERE mode=? AND barcode=? AND reset_id=? AND status='ok'
                        ORDER BY seq DESC LIMIT 1""", (self.mode, barcode, self.reset_id)).fetchone()
                    decision = self.rules.evaluate(lane, barcode, self.group, previous["lane"] if previous else None)
                    detail = {"product_group": decision.product_group, "product_size": decision.product_size}
                    if decision.expected_scanner:
                        detail["expected_device"] = decision.expected_scanner
                    if decision.success and self.reset_id and conn.execute("""SELECT 1 FROM barcode_decisions
                            WHERE mode=? AND barcode=? AND reset_id<? AND status='ok' LIMIT 1""",
                            (self.mode, barcode, self.reset_id)).fetchone():
                        detail["seen_before_reset"] = True
                    part = self.rules.get_part_rule(barcode)
                    seq = self._append(conn, "scan.recorded", STATUS[decision.status][0], moment=moment,
                                       result="ok" if decision.success else "ng", status_raw=decision.status,
                                       device=lane, barcode=barcode, part_no=part["part_no"] if part else None,
                                       detail=detail, ref={"source_key": "barcode-" + uuid4().hex})
                    conn.execute("INSERT INTO barcode_decisions VALUES(?,?,?,?,?,?,?,?,?,?)",
                                 (seq, self.reset_id, day, moment, self.mode, lane, barcode,
                                  decision.status, decision.product_size, decision.product_group))
            except sqlite3.Error as error:
                self._report_error(error)
                return None
            self.counts[lane][self._category(decision.status)] += 1
            self.recent[lane].appendleft({"seq": seq, "time": moment, "barcode": barcode, "status": decision.status})
            if not decision.success:
                self.alert = {"seq": seq, "status": decision.status}
            self.last_work_at = moment
            self._committed += 1
            self._saved(state_changed=first_input)
            return decision

    def device_status(self, lane, state, port, *, identity):
        with self.lock:
            if self.assignments[lane] != identity:
                return
            item = self.lanes[lane]
            if (item["state"], item["port"]) == (state, port):
                return
            item.update(connected=state == "connected", state=state, port=port)
            try:
                with self.ledger.transaction() as conn:
                    self._append(conn, "device.state", "barcode_device_" + state, device=lane,
                                 detail={"device_state": state, "last_input_at": item["last_input_at"]})
            except sqlite3.Error as error:
                self._report_error(error)
            else:
                self._saved(state_changed=True, activity=False, recovered=False)

    def frame_error(self, lane, reason, *, identity):
        with self.lock:
            if identity is None or self.assignments[lane] != identity:
                return
            try:
                with self.ledger.transaction() as conn:
                    seq = self._append(conn, "device.state", "scan_input_error", device=lane, result="error",
                                       detail={"frame_error": reason})
            except sqlite3.Error as error:
                self._report_error(error)
                return
            self.lanes[lane]["frame_errors"][reason] += 1
            self.alert = {"seq": seq, "status": "scan_input_error"}
            self._saved(recovered=False)

    def scanner_assignments(self):
        with self.lock:
            return dict(self.assignments)

    def action(self, action, data):
        with self.lock:
            try:
                return self._action(action, data)
            except sqlite3.Error as error:
                self._report_error(error)
                raise RuntimeError("Barcode storage failed") from None

    def _action(self, action, data):
        if not isinstance(data, dict):
            raise ValueError("Invalid barcode action")
        if action == "reset" and not data:
            with self.ledger.transaction() as conn:
                reset_id = self._append(conn, "operator.action", "barcode_reset",
                                        detail={"action": "reset", "previous_reset_id": self.reset_id})
                conn.execute("UPDATE barcode_settings SET reset_id=? WHERE singleton=1", (reset_id,))
            self.reset_id = reset_id
            self._clear_view()
        elif action == "mode" and data.keys() == {"mode"} and data["mode"] in MODES:
            mode = data["mode"]
            if mode == self.mode:
                return
            with self.ledger.transaction() as conn:
                self._append(conn, "mode.changed", "barcode_mode_changed", mode=mode,
                             detail={"previous_mode": self.mode, "mode": mode})
                conn.execute("UPDATE barcode_settings SET mode=? WHERE singleton=1", (mode,))
            self.mode = mode
            self.alert = None
        elif action == "config" and data and data.keys() <= {"production_group", "assignments"}:
            group = data.get("production_group", self.group)
            if not isinstance(group, str) or group not in self.rules.size_groups:
                raise ValueError("Invalid barcode product group")
            assignments = _assignments(data.get("assignments", {}), self.assignments)
            version = _config_version(self.rules_data, group, assignments)
            if version == self.config_version:
                return
            with self.ledger.transaction() as conn:
                self._append(conn, "config.applied", "barcode_config_applied", config_version=version,
                             detail=self._config_detail(group, assignments))
                conn.execute("""UPDATE barcode_settings SET production_group=?,assignments=?,config_version=?
                              WHERE singleton=1""", (group, encode(assignments).decode(), version))
            for lane in LANES:
                if assignments[lane] != self.assignments[lane]:
                    self.lanes[lane].update(connected=False, state="disconnected", port="", last_input_at=None)
            self.group, self.assignments, self.config_version = group, assignments, version
        else:
            raise ValueError("Invalid barcode action")
        self._saved(state_changed=True)

    def _clear_view(self):
        self.alert = None
        for lane in LANES:
            self.lanes[lane]["frame_errors"] = dict.fromkeys(FRAME_ERRORS, 0)

    def snapshot(self, ports):
        with self.lock:
            try:
                self._load_shift(self._day())
            except sqlite3.Error as error:
                self._report_error(error)
            lanes = deepcopy(self.lanes)
            for lane in LANES:
                lanes[lane]["counts"] = dict(self.counts[lane])
                lanes[lane]["recent"] = list(self.recent[lane])
            return {"mode": self.mode, "production_group": self.group, "groups": list(self.rules.size_groups),
                    "assignments": dict(self.assignments), "ports": ports, "lanes": lanes, "reset_id": self.reset_id,
                    "alert": self.alert, "storage_error": self.storage_error}

    def health(self):
        with self.lock:
            apps = [{"app": "barcode", "version": __version__, "mode": self.mode,
                     "state": "fault" if self.storage_error else "running", "last_work_at": self.last_work_at}]
            devices = [{"app": "barcode", "device": lane, "state": info["state"],
                        "last_input_at": info["last_input_at"]} for lane, info in self.lanes.items()]
            return apps, devices, self.coverage, self.disk_full

    @property
    def committed(self):
        with self.lock:
            return self._committed

    def csv(self, lang):
        with self.lock:
            scope = (self.mode, self.reset_id)
        return self._csv_rows(scope, 2 if lang == "zh" else 1)

    def _csv_rows(self, scope, language):
        buffer = io.StringIO(newline="")
        writer = csv.writer(buffer)
        writer.writerow(("Time", "Scanner", "Barcode", "Size", "ProductGroup", "Status", "StatusText"))
        yield buffer.getvalue().encode("utf-8-sig")
        with self.ledger.read() as conn:
            cursor = conn.execute("""SELECT time, lane, barcode, size, product_group, status FROM barcode_decisions
                WHERE mode=? AND reset_id=? ORDER BY seq""", scope)
            while True:
                rows = cursor.fetchmany(250)
                if not rows:
                    return
                buffer.seek(0)
                buffer.truncate()
                writer.writerows((row["time"][:19].replace("T", " "), row["lane"], _safe_csv(row["barcode"]),
                                  _safe_csv(row["size"]), _safe_csv(row["product_group"]), row["status"],
                                  STATUS[row["status"]][language]) for row in rows)
                yield buffer.getvalue().encode("utf-8")

    def stop(self):
        try:
            with self.ledger.transaction() as conn:
                self._append(conn, "app.stopped", "barcode_app_stopped")
        except sqlite3.Error as error:
            self._report_error(error)
