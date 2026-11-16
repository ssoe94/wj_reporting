"""Persist inspection, reservation, transport attempts and rereads in the field ledger."""

from hashlib import sha256
import json
import re
import sqlite3
from uuid import uuid4

from .. import __version__
from ..protocol import encode, event_time, timestamp
from .reread import CODE, DEVICES, SOURCES, SCAN_RESULTS, classify, expected_lane, scan_slot
from .serials import make_barcode, int_to_base34, get_date_code
from . import serial_authority
from .settings import MAX_SERIAL, choose_template


QUEUE_LIMIT = 100
BLOCKED_TRANSPORT = {"route_changed", "language_mismatch", "invalid_command_language", "invalid_payload", "invalid_mode"}
RULE = "unit_5pct_sqrt_quantity_v1"
SCHEMA = (
    """CREATE TABLE IF NOT EXISTS weigh_state (
        id INTEGER PRIMARY KEY CHECK(id=1), part_no TEXT NOT NULL, version TEXT NOT NULL, mode TEXT NOT NULL,
        pause TEXT, submitted INTEGER NOT NULL DEFAULT 0
    )""",
    """CREATE TABLE IF NOT EXISTS weigh_cycles (
        id TEXT PRIMARY KEY, seq INTEGER NOT NULL REFERENCES events(seq), part_no TEXT NOT NULL, record TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS weigh_serials (
        print_date TEXT NOT NULL, part_no TEXT NOT NULL, last_serial INTEGER NOT NULL,
        PRIMARY KEY(print_date,part_no)
    )""",
    """CREATE TABLE IF NOT EXISTS weigh_jobs (
        sequence INTEGER PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, cycle_id TEXT NOT NULL REFERENCES weigh_cycles(id),
        barcode TEXT NOT NULL UNIQUE, part_no TEXT NOT NULL, model TEXT NOT NULL, print_date TEXT NOT NULL,
        serial INTEGER NOT NULL, label_index INTEGER NOT NULL,
        mode TEXT NOT NULL, config_version TEXT NOT NULL, route TEXT NOT NULL, peel INTEGER NOT NULL,
        columns INTEGER NOT NULL, fragments TEXT NOT NULL, fragments_sha TEXT NOT NULL, state TEXT NOT NULL,
        row_id TEXT REFERENCES weigh_rows(row_id)
    )""",
    """CREATE TABLE IF NOT EXISTS weigh_rows (
        row_id TEXT PRIMARY KEY, quantity INTEGER NOT NULL, columns INTEGER NOT NULL,
        mode TEXT NOT NULL, config_version TEXT NOT NULL, route TEXT NOT NULL, peel INTEGER NOT NULL,
        payload BLOB NOT NULL, payload_sha TEXT NOT NULL, state TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS weigh_attempts (
        id TEXT PRIMARY KEY, row_id TEXT NOT NULL REFERENCES weigh_rows(row_id),
        started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT NOT NULL, code TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS weigh_reconciliations (
        row_id TEXT PRIMARY KEY REFERENCES weigh_rows(row_id), seq INTEGER NOT NULL REFERENCES events(seq),
        confirmed_quantity INTEGER NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS weigh_peel (
        id INTEGER PRIMARY KEY CHECK(id=1), row_id TEXT NOT NULL REFERENCES weigh_rows(row_id),
        seen_waiting INTEGER NOT NULL DEFAULT 0
    )""",
    """CREATE TABLE IF NOT EXISTS weigh_template_selection (
        part_no TEXT PRIMARY KEY, template_id TEXT NOT NULL, label_values TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS weigh_scans (
        request_id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
        identity TEXT NOT NULL, raw_barcode TEXT NOT NULL, response TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS weigh_confirmations (
        mode TEXT NOT NULL, barcode TEXT NOT NULL, scan_seq INTEGER NOT NULL REFERENCES events(seq),
        PRIMARY KEY(mode,barcode)
    )""",
    "CREATE INDEX IF NOT EXISTS weigh_jobs_state ON weigh_jobs(state, sequence)",
    "CREATE INDEX IF NOT EXISTS weigh_jobs_row ON weigh_jobs(row_id, sequence)",
    "CREATE INDEX IF NOT EXISTS weigh_jobs_cycle ON weigh_jobs(cycle_id, sequence)",
    "CREATE INDEX IF NOT EXISTS weigh_jobs_part_date ON weigh_jobs(part_no, print_date, serial)",
    """CREATE INDEX IF NOT EXISTS weigh_serials_print_code
        ON weigh_serials(part_no, substr(print_date,6), substr(print_date,4,1), last_serial)""",
    "CREATE INDEX IF NOT EXISTS weigh_rows_state ON weigh_rows(state)",
    "CREATE INDEX IF NOT EXISTS weigh_attempts_pending ON weigh_attempts(outcome) WHERE outcome='dispatching'",
    """CREATE TRIGGER IF NOT EXISTS weigh_jobs_frozen BEFORE UPDATE OF
        job_id,cycle_id,barcode,part_no,model,print_date,serial,label_index,mode,config_version,route,peel,
        columns,fragments,fragments_sha ON weigh_jobs
        BEGIN SELECT RAISE(ABORT, 'reserved label evidence is immutable'); END""",
    """CREATE TRIGGER IF NOT EXISTS weigh_rows_frozen BEFORE UPDATE OF
        row_id,quantity,columns,mode,config_version,route,peel,payload,payload_sha ON weigh_rows
        BEGIN SELECT RAISE(ABORT, 'physical label payload is immutable'); END""",
    """CREATE TRIGGER IF NOT EXISTS weigh_scans_no_update BEFORE UPDATE ON weigh_scans
        BEGIN SELECT RAISE(ABORT, 'weigh scans are append-only'); END""",
    """CREATE TRIGGER IF NOT EXISTS weigh_scans_no_delete BEFORE DELETE ON weigh_scans
        BEGIN SELECT RAISE(ABORT, 'weigh scans are append-only'); END""",
)


def _id(prefix):
    return prefix + uuid4().hex


def _json(value):
    return encode(value).decode()


def _sha(data):
    return sha256(data).hexdigest()


def _number(value):
    if value is None:
        return None
    result = format(value, "f")
    if len(result) <= 32:
        return result
    result = format(value, ".12f")
    return result if len(result) <= 32 else None


class WeighStore:
    def __init__(self, ledger, settings, clock=timestamp):
        self.ledger, self.settings, self.clock = ledger, settings, clock
        with ledger.transaction() as conn:
            for statement in SCHEMA:
                conn.execute(statement)
            serial_authority.install(conn)
            state = self._state(conn)
            part = state["part_no"] if state and state["part_no"] in settings.products else settings.default
            self.product = self._load_product(conn, part)
            if state is None:
                conn.execute("INSERT INTO weigh_state(id,part_no,version,mode) VALUES(1,?,?,?)",
                             (part, self.product.version, settings.mode))
            elif (part, self.product.version, settings.mode) != (state["part_no"], state["version"], state["mode"]):
                conn.execute("UPDATE weigh_state SET part_no=?,version=?,mode=? WHERE id=1",
                             (part, self.product.version, settings.mode))
            interrupted = conn.execute("SELECT id,row_id FROM weigh_attempts WHERE outcome='dispatching'").fetchall()
            for attempt in interrupted:
                row = self._row(conn, attempt["row_id"])
                self._complete(conn, row, attempt["id"], "uncertain", "interrupted", self.clock())
            if self._active(conn, ("waiting", "dispatching", "uncertain")):
                self._pause(conn, "uncertain" if self._unresolved(conn) else "restart_queue")
            if state is None or state["version"] != self.product.version or state["mode"] != settings.mode:
                self._emit(conn, "config.applied", "weigh_config_applied",
                           part_no=part, detail={"previous_config_version": state["version"] if state else None})
            self._emit(conn, "app.started", "weigh_app_started")

    def _emit(self, conn, kind, reason, *, moment=None, version=None, mode=None, **fields):
        return self.ledger.append(conn, {
            "app": "weigh_label", "type": kind, "reason": reason, "result": "info",
            "occurred_at": moment or self.clock(), "mode": mode or self.settings.mode,
            "app_version": __version__, "agent_version": __version__,
            "config_version": version or self.product.version, **fields,
        })

    @staticmethod
    def _state(conn):
        return conn.execute("SELECT * FROM weigh_state WHERE id=1").fetchone()

    @staticmethod
    def _pause(conn, reason):
        conn.execute("UPDATE weigh_state SET pause=? WHERE id=1", (reason,))

    @staticmethod
    def _row(conn, row_id):
        return conn.execute("SELECT * FROM weigh_rows WHERE row_id=?", (row_id,)).fetchone()

    @staticmethod
    def _unresolved(conn):
        return conn.execute("""SELECT weigh_rows.* FROM weigh_rows
            LEFT JOIN weigh_reconciliations USING(row_id)
            WHERE state='uncertain' AND confirmed_quantity IS NULL LIMIT 1""").fetchone()

    @staticmethod
    def _active(conn, states):
        placeholders = ",".join("?" for _ in states)
        return conn.execute("SELECT COUNT(*) FROM weigh_jobs WHERE state IN (" + placeholders + ")", states).fetchone()[0]

    @staticmethod
    def _members(conn, row_id):
        return conn.execute("SELECT job_id FROM weigh_jobs WHERE row_id=? ORDER BY sequence", (row_id,)).fetchall()

    def record(self, cycle, *, scale_status, scale_mode, moment):
        """The result, serial counter, frozen label cells and reservation are one commit."""
        product = self.product
        part = product.profile.part_no
        decision = cycle.decision
        cycle_id = _id("cycle-")
        passed = decision.accepted
        reason = "weight_within_limit" if passed else (
            "weight_at_or_below_zero" if decision.quantity is None else "weight_outside_limit")
        data = {"result": "ok" if passed else "ng", "quantity": decision.quantity, "reason": reason, "part_no": part,
                "weight_g": _number(cycle.net_g), "delta_g": _number(decision.difference_g), "time": moment}
        measure = {"value": data["weight_g"], "unit": "g", "expected": _number(decision.expected_g),
                   "tolerance": _number(decision.limit_g)}
        fields = {"measure": measure} if measure["value"] is not None else {}
        detail = {"rule": RULE, "scale_status": scale_status, "scale_mode": scale_mode,
                  "difference_g": data["delta_g"], "unit_weight_g": _number(product.profile.unit_weight_g)}
        if decision.quantity is not None:
            detail["quantity"] = decision.quantity
        with self.ledger.transaction() as conn:
            pause = self._state(conn)["pause"]
            if pause:
                return None
            seq = self._emit(conn, "weigh.result", reason, result=data["result"], moment=moment,
                             status_raw=cycle.status, part_no=part, device="scale",
                             ref={"cycle_id": cycle_id}, detail=detail, **fields)
            data["seq"] = seq
            first = None
            if passed:
                first, code = self._reservation(conn, part, moment, decision.quantity)
                if code:
                    self._pause(conn, code)
                    self._emit(conn, "operator.action", "weigh_reservation_blocked", moment=moment, result="error",
                               ref={"cycle_id": cycle_id}, detail={"action": "reservation_blocked", "cause": code})
                    data["reservation_blocked"] = code
            conn.execute("INSERT INTO weigh_cycles VALUES(?,?,?,?)", (cycle_id, seq, part, _json(data)))
            if passed and "reservation_blocked" not in data:
                self._reserve(conn, cycle_id, product, moment, decision.quantity, first)
        return data

    def _reservation(self, conn, part, moment, quantity):
        if self._unresolved(conn):
            return None, "uncertain"
        if self._active(conn, ("waiting", "dispatching")) + quantity > QUEUE_LIMIT:
            return None, "queue_full"
        floor, blocked = serial_authority.establish(self.ledger, conn, self.settings, part, moment)
        if blocked:
            return None, blocked
        if floor + quantity > MAX_SERIAL:
            return None, "serial_exhausted"
        return floor + 1, None

    def serial_status(self, calendar):
        part = self.product.profile.part_no
        day = calendar.isoformat()
        with self.ledger.read() as conn:
            if (serial_authority.local_today(conn, part, day) is not None
                    or serial_authority.saved_floor(conn, part, day) is not None):
                status = "established"
            elif self._state(conn)["pause"] == serial_authority.UNAVAILABLE:
                status = serial_authority.UNAVAILABLE
            else:
                status = "lookup_pending" if self.settings.legacy_print_db else serial_authority.REQUIRED
        return {"part_no": part, "day": day, "date_code": get_date_code(calendar), "status": status}

    def confirm_no_issuance(self, part, reason, actor):
        return serial_authority.confirm_no_issuance(self.ledger, self.settings, part, reason, actor, clock=self.clock)

    def _reserve(self, conn, cycle_id, product, moment, quantity, first):
        calendar_date = event_time(moment).date()
        day, part = calendar_date.isoformat(), product.profile.part_no
        for serial in range(first, first + quantity):
            barcode = make_barcode(part, serial, self.settings.code, calendar_date)
            job_id = _id("job-")
            frozen = _json({"prefix": product.layout["prefix"], "cells": product.freeze(barcode),
                            "suffix": product.layout["suffix"], "language": product.layout["language"]})
            checksum = _sha(frozen.encode())
            conn.execute("""INSERT INTO weigh_jobs
                (job_id,cycle_id,barcode,part_no,model,print_date,serial,label_index,mode,config_version,route,peel,
                 columns,fragments,fragments_sha,state)
                VALUES(?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,'waiting')""",
                (job_id, cycle_id, barcode, part, product.profile.size, day, serial, self.settings.mode,
                 product.version, self.settings.printer_route, int(product.peel), product.columns, frozen, checksum))
            self._emit(conn, "label.reserved", "label_reserved", moment=moment, part_no=part, barcode=barcode,
                       serial=int_to_base34(serial), status_raw="waiting",
                       ref={"cycle_id": cycle_id, "job_id": job_id},
                       detail={"quantity": 1, "print_date": day, "label_index": 0, "payload_sha256": checksum,
                               "payload_basis": "frozen_label_cells_v1"})
        conn.execute("""INSERT INTO weigh_serials VALUES(?,?,?)
            ON CONFLICT(print_date,part_no) DO UPDATE SET last_serial=excluded.last_serial""",
            (day, part, first + quantity - 1))

    @staticmethod
    def _waiting(conn):
        return conn.execute("SELECT * FROM weigh_jobs WHERE state='waiting' ORDER BY sequence LIMIT 3").fetchall()

    @staticmethod
    def _prefix(waiting):
        first = waiting[0]
        grouped = []
        for job in waiting[:first["columns"]]:
            if any(job[key] != first[key] for key in ("config_version", "route", "mode", "columns", "peel", "row_id")):
                break
            grouped.append(job)
        return grouped

    def _form_row(self, conn, jobs, *, flush=False):
        first = jobs[0]
        if first["row_id"]:
            return self._row(conn, first["row_id"])
        if not flush and len(jobs) < first["columns"]:
            return None
        if flush and len(jobs) == first["columns"]:
            raise ValueError("Only an incomplete row can be flushed")
        cells = []
        for position, job in enumerate(jobs):
            encoded = job["fragments"]
            if _sha(encoded.encode()) != job["fragments_sha"]:
                self._pause(conn, "payload_corrupt")
                return None
            layout = json.loads(encoded)
            cells.append(layout["cells"][position])
        payload = (layout["prefix"] + "".join(cells) + layout["suffix"]).encode("ascii")
        row_id = _id("row-")
        conn.execute("INSERT INTO weigh_rows VALUES(?,?,?,?,?,?,?,?,?,'waiting')",
                     (row_id, len(jobs), first["columns"], first["mode"], first["config_version"], first["route"],
                      first["peel"], payload, _sha(payload)))
        conn.executemany("UPDATE weigh_jobs SET row_id=? WHERE job_id=?", [(row_id, job["job_id"]) for job in jobs])
        row = self._row(conn, row_id)
        if flush:
            detail = {"row_id": row_id, "quantity": row["quantity"], "columns": row["columns"],
                      "job_ids": [job["job_id"] for job in jobs], "action": "operator_flush"}
            self._emit(conn, "queue.partial_flush", "partial_flush_approved", version=row["config_version"],
                       mode=row["mode"], ref={"row_id": row_id}, detail=detail)
            self._emit(conn, "operator.action", "weigh_partial_flush_confirmed", version=row["config_version"],
                       mode=row["mode"], ref={"row_id": row_id}, detail=detail)
        return row

    def begin_dispatch(self):
        """Persist the send boundary before any printer I/O."""
        with self.ledger.transaction() as conn:
            if (self._state(conn)["pause"] or self._active(conn, ("dispatching", "uncertain"))
                    or conn.execute("SELECT 1 FROM weigh_peel").fetchone()):
                return None
            jobs = self._waiting(conn)
            if not jobs:
                return None
            if jobs[0]["route"] != self.settings.printer_route:
                self._pause(conn, "route_changed")
                return None
            row = self._form_row(conn, self._prefix(jobs))
            if row is None:
                return None
            if _sha(row["payload"]) != row["payload_sha"]:
                self._pause(conn, "payload_corrupt")
                return None
            attempt = _id("attempt-")
            conn.execute("INSERT INTO weigh_attempts VALUES(?,?,?,NULL,'dispatching',NULL)",
                         (attempt, row["row_id"], self.clock()))
            self._set_delivery(conn, row["row_id"], "dispatching")
            if row["peel"]:
                conn.execute("INSERT INTO weigh_peel(id,row_id) VALUES(1,?)", (row["row_id"],))
            return dict(row), attempt

    @staticmethod
    def _set_delivery(conn, row_id, state):
        conn.execute("UPDATE weigh_rows SET state=? WHERE row_id=?", (state, row_id))
        conn.execute("UPDATE weigh_jobs SET state=? WHERE row_id=?", (state, row_id))

    def _complete(self, conn, row, attempt, result, code, moment):
        row_id = row["row_id"]
        state = "waiting" if result == "not_sent" else result
        reason = {"not_sent": "print_rejected_unsent", "submitted": "print_submitted", "uncertain": "print_uncertain"}[result]
        changed = conn.execute("""UPDATE weigh_attempts SET finished_at=?,outcome=?,code=?
            WHERE id=? AND row_id=? AND outcome='dispatching'""", (moment, result, code, attempt, row_id)).rowcount
        if changed != 1:
            return False
        self._set_delivery(conn, row_id, state)
        self._emit(conn, "label.dispatched", reason, moment=moment, version=row["config_version"], mode=row["mode"],
                   status_raw=result, result="info" if result == "submitted" else "error",
                   ref={"attempt_id": attempt, "row_id": row_id},
                   detail={"row_id": row_id, "job_ids": [job["job_id"] for job in self._members(conn, row_id)],
                           "quantity": row["quantity"], "delivery_status": result, "cause": code,
                           "payload_sha256": row["payload_sha"]})
        if result == "not_sent":
            conn.execute("DELETE FROM weigh_peel WHERE row_id=?", (row_id,))
        elif result == "uncertain":
            self._pause(conn, "uncertain")
        else:
            conn.execute("UPDATE weigh_state SET submitted=submitted+? WHERE id=1", (row["quantity"],))
        return True

    def finish(self, row, attempt, result, code=None):
        with self.ledger.transaction() as conn:
            completed = self._complete(conn, row, attempt, result, code, self.clock())
            if completed and result == "not_sent" and code in BLOCKED_TRANSPORT:
                self._pause(conn, "printer_configuration")

    def observe_peel(self, observation):
        if observation not in ("waiting", "ready"):
            return False
        with self.ledger.read() as conn:
            gate = conn.execute("""SELECT row_id, seen_waiting FROM weigh_peel JOIN weigh_rows USING(row_id)
                                   WHERE state='submitted'""").fetchone()
        if not gate or (observation == "waiting") == bool(gate["seen_waiting"]):
            return False
        with self.ledger.transaction() as conn:
            saved = conn.execute("SELECT * FROM weigh_peel WHERE id=1").fetchone()
            if not saved or saved["row_id"] != gate["row_id"] or saved["seen_waiting"] != gate["seen_waiting"]:
                return False
            row = self._row(conn, gate["row_id"])
            if observation == "waiting":
                conn.execute("UPDATE weigh_peel SET seen_waiting=1 WHERE id=1")
                self._peel_event(conn, row, "peel_waiting_seen")
            else:
                conn.execute("DELETE FROM weigh_peel WHERE id=1")
                self._peel_event(conn, row, "peel_sensor_cleared")
        return True

    def _peel_event(self, conn, row, action):
        self._emit(conn, "operator.action" if action == "peel_operator_cleared" else "device.state",
                   action, mode=row["mode"], version=row["config_version"], device="printer",
                   ref={"row_id": row["row_id"]}, detail={"action": action})

    def _load_product(self, conn, part):
        base = self.settings.products[part]
        previous = conn.execute("SELECT template_id,label_values FROM weigh_template_selection WHERE part_no=?", (part,)).fetchone()
        if previous:
            try:
                return choose_template(base, previous["template_id"], json.loads(previous["label_values"]))
            except (TypeError, ValueError):
                # An installation can withdraw a template. Keep frozen work
                # untouched and load the approved default for future reservations.
                pass
        return base

    def label_options(self):
        product = self.product
        return {
            "template_id": product.template_id, "values": dict(product.values),
            "templates": [
                {"id": item["id"], "name": item["name"], "name_ko": item["name_ko"], "name_zh": item["name_zh"],
                 "columns": item["columns"], "language": item["layout"]["language"], "fields": item["fields"]}
                for item in product.templates.values()
            ],
            "preview": {"columns": product.columns, "cells": [
                {"barcode": product.profile.part_no + "-SAMPLE",
                 "text": [product.profile.part_no, *[value for _key, value in product.values if value]]}
                for _ in range(product.columns)
            ]},
        }

    def select_template(self, template_id, values):
        part = self.product.profile.part_no
        product = choose_template(self.settings.products[part], template_id, values)
        if product.version == self.product.version:
            return False
        with self.ledger.transaction() as conn:
            if self._active(conn, ("waiting", "dispatching", "uncertain")):
                raise ValueError("Finish or resolve the pending queue before changing templates")
            conn.execute("""INSERT INTO weigh_template_selection VALUES(?,?,?)
                ON CONFLICT(part_no) DO UPDATE SET template_id=excluded.template_id,label_values=excluded.label_values""",
                         (part, template_id, _json(dict(product.values))))
            conn.execute("UPDATE weigh_state SET version=? WHERE id=1", (product.version,))
            self._emit(conn, "config.applied", "weigh_template_applied", part_no=part, version=product.version,
                       detail={"template_id": template_id, "previous_config_version": self.product.version})
        self.product = product
        return True

    def recent_jobs(self):
        with self.ledger.read() as conn:
            # A load reserves at most five labels. Pick recent cycles from the
            # queue's chronological index, then expand each complete cycle.
            recent = conn.execute("SELECT cycle_id FROM weigh_jobs ORDER BY sequence DESC LIMIT 60")
            cycle_ids = list(dict.fromkeys(row["cycle_id"] for row in recent))[:12]
            output = []
            for cycle_id in cycle_ids:
                rows = conn.execute("""SELECT j.*, issue.occurred_at, confirmation.payload AS reread_payload
                    FROM weigh_jobs j JOIN weigh_cycles c ON c.id=j.cycle_id JOIN events issue ON issue.seq=c.seq
                    LEFT JOIN weigh_confirmations latest ON latest.mode=j.mode AND latest.barcode=j.barcode
                    LEFT JOIN events confirmation ON confirmation.seq=latest.scan_seq
                    WHERE j.cycle_id=? ORDER BY j.sequence""", (cycle_id,)).fetchall()
                confirmed, unconfirmed = 0, 0
                for label in rows:
                    reread = json.loads(label["reread_payload"]) if label["reread_payload"] else {}
                    linked = (reread.get("detail", {}).get("label_origin") == "local"
                              and reread.get("ref", {}).get("job_id") == label["job_id"])
                    confirmed += int(linked)
                    unconfirmed += int(label["state"] == "submitted" and not linked)
                states = {row["state"] for row in rows}
                state = next((item for item in ("uncertain", "dispatching", "waiting") if item in states),
                             next(iter(states)) if len(states) == 1 else "mixed")
                output.append({"id": cycle_id, "part_no": rows[0]["part_no"], "time": rows[0]["occurred_at"],
                               "reserved": len(rows), "submitted": sum(row["state"] == "submitted" for row in rows),
                               "confirmed": confirmed, "unconfirmed": unconfirmed, "state": state})
            return output

    def select(self, part):
        if not isinstance(part, str) or part not in self.settings.products:
            raise ValueError("Unknown weigh product")
        if part == self.product.profile.part_no:
            return False
        with self.ledger.transaction() as conn:
            product = self._load_product(conn, part)
            if self._active(conn, ("waiting", "dispatching", "uncertain")):
                raise ValueError("Finish or resolve the pending queue first")
            conn.execute("UPDATE weigh_state SET part_no=?,version=? WHERE id=1", (part, product.version))
            self._emit(conn, "config.applied", "weigh_config_applied", part_no=part, version=product.version,
                       detail={"previous_config_version": self.product.version})
        self.product = product
        return True

    def action(self, action, data, *, storage_recovery=False):
        with self.ledger.transaction() as conn:
            if action == "pause" and not data:
                if self._state(conn)["pause"]:
                    raise ValueError("Queue already paused")
                self._pause(conn, "operator_pause")
                self._emit(conn, "operator.action", "weigh_queue_paused", detail={"action": "pause"})
            elif action == "resume" and not data:
                pause = self._state(conn)["pause"]
                if (not pause and not storage_recovery) or self._unresolved(conn) or self._active(conn, ("dispatching",)):
                    raise ValueError("Queue cannot resume")
                waiting = self._waiting(conn)
                if waiting and waiting[0]["route"] != self.settings.printer_route:
                    raise ValueError("Restore the saved printer route first")
                if pause in (serial_authority.REQUIRED, serial_authority.UNAVAILABLE):
                    part = self.product.profile.part_no
                    _floor, blocked = serial_authority.establish(self.ledger, conn, self.settings, part, self.clock())
                    if blocked:
                        raise ValueError("Serial evidence must be established before resuming")
                self._pause(conn, None)
                self._emit(conn, "operator.action", "weigh_queue_resumed",
                           detail={"action": "resume", "previous_pause": pause})
            elif action == "acknowledge" and set(data) == {"job_id", "confirmed_quantity"}:
                row = self._unresolved(conn)
                confirmed = data["confirmed_quantity"]
                if (not row or row["row_id"] != data["job_id"] or type(confirmed) is not int
                        or not 0 <= confirmed <= row["quantity"]):
                    raise ValueError("Invalid uncertain row acknowledgement")
                seq = self._emit(conn, "operator.action", "operator_reconciled",
                                 version=row["config_version"], mode=row["mode"], ref={"row_id": row["row_id"]},
                                 detail={"action": "reconcile", "confirmed_quantity": confirmed})
                conn.execute("INSERT INTO weigh_reconciliations VALUES(?,?,?)", (row["row_id"], seq, confirmed))
                # Preserve the attempt's uncertain evidence. The queue can now move only by explicit resume.
                conn.execute("UPDATE weigh_jobs SET state='reconciled' WHERE row_id=?", (row["row_id"],))
                self._pause(conn, "operator_resume")
            elif action == "peel" and not data:
                gate = conn.execute("SELECT row_id FROM weigh_peel WHERE id=1").fetchone()
                row = self._row(conn, gate["row_id"]) if gate else None
                if not row or (row["state"] != "submitted" and self._unresolved(conn)):
                    raise ValueError("Resolve the uncertain row before clearing peel")
                if row["state"] == "dispatching":
                    raise ValueError("Wait for dispatch to finish")
                conn.execute("DELETE FROM weigh_peel WHERE id=1")
                self._peel_event(conn, row, "peel_operator_cleared")
            elif action == "cancel_waiting" and not data:
                self._cancel_waiting(conn)
            elif action == "flush" and not data:
                jobs = self._waiting(conn)
                if (not jobs or jobs[0]["row_id"] or self._unresolved(conn)
                        or self._active(conn, ("dispatching",))):
                    raise ValueError("No incomplete physical row can be flushed")
                if self._form_row(conn, self._prefix(jobs), flush=True) is None:
                    return
            else:
                raise ValueError("Invalid weigh action")

    def _cancel_waiting(self, conn):
        if not self._state(conn)["pause"] or self._unresolved(conn) or self._active(conn, ("dispatching",)):
            raise ValueError("Pause and resolve in-flight output before cancelling waiting labels")
        waiting = conn.execute("SELECT * FROM weigh_jobs WHERE state='waiting' ORDER BY sequence").fetchall()
        if not waiting:
            raise ValueError("No waiting labels to cancel")
        for job in waiting:
            if job["row_id"]:
                conn.execute("UPDATE weigh_rows SET state='cancelled' WHERE row_id=?", (job["row_id"],))
            conn.execute("UPDATE weigh_jobs SET state='cancelled' WHERE job_id=?", (job["job_id"],))
            self._emit(conn, "operator.action", "label_cancelled", mode=job["mode"], version=job["config_version"],
                       ref={"job_id": job["job_id"]}, detail={"action": "cancel_waiting"})
        self._pause(conn, "operator_resume")

    def _lookup(self, conn, barcode):
        return conn.execute("""SELECT weigh_jobs.*,weigh_rows.quantity AS row_quantity, weigh_rows.state AS row_state,
            weigh_reconciliations.confirmed_quantity FROM weigh_jobs
            LEFT JOIN weigh_rows USING(row_id) LEFT JOIN weigh_reconciliations USING(row_id)
            WHERE barcode=?""", (barcode,)).fetchone()

    def reread(self, barcode, device, *, source="serial", request_id=None, moment=None):
        if not isinstance(barcode, str) or len(barcode) > 512 or device not in DEVICES or source not in SOURCES:
            raise ValueError("Invalid scan evidence")
        request_id = request_id or _id("scan-")
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", request_id):
            raise ValueError("Invalid scan request ID")
        product = self.product
        code = barcode.strip().upper()
        slot = scan_slot(device, expected_lane(product))
        mode = {"manual": "manual", "demo": "test"}.get(source, self.settings.mode)
        identity = _json([device, source, slot, product.version, mode])
        with self.ledger.transaction() as conn:
            saved = conn.execute("SELECT * FROM weigh_scans WHERE request_id=?", (request_id,)).fetchone()
            if saved:
                original = json.loads(saved["response"])
                if (identity != saved["identity"] or barcode != saved["raw_barcode"]
                        or (moment is not None and timestamp(event_time(moment)) != original["time"])):
                    raise ValueError("Scan request ID was reused with different evidence")
                return dict(original, seq=saved["seq"])
            moment = timestamp(event_time(moment)) if moment is not None else self.clock()
            match = None
            try:
                if CODE.fullmatch(code):
                    match = self._lookup(conn, code)
            except (sqlite3.Error, OSError, ValueError, TypeError):
                data = {"status": "ledger_error", "label_origin": "unknown", "part_no": "", "job_id": None}
            else:
                first = conn.execute("SELECT scan_seq FROM weigh_confirmations WHERE mode=? AND barcode=?",
                                     (self.settings.mode, code)).fetchone()
                data = classify(code, job=match, first=first[0] if first else None, product=product,
                                all_products=self.settings.products, codes=self.settings.code, slot=slot, source=source,
                                calendar_date=event_time(moment).date())
            if match and match["mode"] != self.settings.mode and data["status"] == "ok":
                data.update(status="review_required", parse_error="mode_mismatch")
            data.update(time=moment, barcode=code, device=device)
            normalized = code.replace("\0", "")
            sent = normalized if len(normalized.encode("utf-8")) <= 256 else None
            detail = {"label_origin": data["label_origin"], "legacy_slot": slot, "source": source,
                      "expected_device": expected_lane(product), "expected_part_no": product.profile.part_no,
                      "expected_model": product.profile.size}
            detail.update({key: data[key] for key in ("label_index", "duplicate_of", "parse_error", "print_date", "print_status",
                                                      "model", "product_size", "product_group")
                           if key in data})
            if sent != code:
                detail["source_value_omitted"] = True
            result, reason = SCAN_RESULTS[data["status"]]
            seq = self._emit(conn, "label.reread", reason, result=result, moment=moment, mode=mode, barcode=sent,
                             device=device, part_no=data["part_no"] or None, status_raw=data["status"], detail=detail,
                             ref={"job_id": data["job_id"]} if data["job_id"] else {})
            data["seq"] = seq
            conn.execute("INSERT INTO weigh_scans VALUES(?,?,?,?,?)", (request_id, seq, identity, barcode, _json(data)))
            if data["status"] == "ok":
                conn.execute("INSERT INTO weigh_confirmations VALUES(?,?,?)", (self.settings.mode, code, seq))
            return data

    def queue(self):
        with self.ledger.read() as conn:
            state = self._state(conn)
            waiting = self._waiting(conn)
            uncertain = self._unresolved(conn)
            gate = conn.execute("SELECT row_id FROM weigh_peel").fetchone()
            partial = 0
            if waiting and waiting[0]["row_id"] is None:
                count = len(self._prefix(waiting))
                partial = count if count < waiting[0]["columns"] else 0
            return {"waiting": self._active(conn, ("waiting",)), "dispatching": self._active(conn, ("dispatching",)),
                    "submitted": state["submitted"], "uncertain": uncertain["quantity"] if uncertain else 0,
                    "uncertain_quantity": uncertain["quantity"] if uncertain else 0,
                    "uncertain_ids": [uncertain["row_id"]] if uncertain else [],
                    "peel_wait": bool(gate), "partial": partial, "paused": bool(state["pause"]),
                    "pause_reason": state["pause"]}

    def last(self):
        with self.ledger.read() as conn:
            cycle = conn.execute("SELECT part_no, seq, record FROM weigh_cycles ORDER BY rowid DESC LIMIT 1").fetchone()
            scan = conn.execute("SELECT seq, response FROM weigh_scans ORDER BY seq DESC LIMIT 1").fetchone()
            last_result = dict(json.loads(cycle["record"]), part_no=cycle["part_no"], seq=cycle["seq"]) if cycle else None
            return last_result, dict(json.loads(scan["response"]), seq=scan["seq"]) if scan else None

    def stop(self):
        with self.ledger.transaction() as conn:
            self._emit(conn, "app.stopped", "weigh_app_stopped")
