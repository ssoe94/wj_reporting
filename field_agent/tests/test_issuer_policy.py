from decimal import Decimal
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

from field_agent.backup import Backup
from field_agent.config import Connection
from field_agent.ledger import Ledger
from field_agent.protocol import event_time
from field_agent.runtime import Runtime
from field_agent.weigh import issuer_policy
from field_agent.weigh.rules import CycleEvent, evaluate_weight
from field_agent.weigh.store import WeighStore

from .test_weigh_app import NOW, OTHER, PART, settings


def policy(station, revision, grants):
    return {'station_id': station, 'revision': revision, 'grants': [
        {'namespace': 'SYN', 'part_no': part, 'assignment_id': assignment, 'transfer': transfer}
        for part, assignment, transfer in grants
    ]}


class IssuerPolicyTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.ledger = Ledger(self.root / 'ledger.sqlite3', 'SYNTH-ISSUER')
        self.addCleanup(self.ledger.close)
        self.clock = lambda: NOW
        self.settings = settings()

    def store(self):
        return WeighStore(self.ledger, self.settings, clock=self.clock)

    def record(self, store):
        profile = store.product.profile
        decision = evaluate_weight(Decimal('20'), profile)
        cycle = CycleEvent('accepted', Decimal('20'), decision)
        return store.record(cycle, scale_status='ST', scale_mode='GS', moment=NOW)

    def apply(self, revision, grants):
        selected = policy(self.ledger.station_id, revision, grants)
        return issuer_policy.apply(self.ledger, selected, clock=self.clock)

    def event(self, reason):
        with self.ledger.read() as conn:
            for row in conn.execute("SELECT payload FROM events ORDER BY seq DESC"):
                event = json.loads(row[0])
                if event["reason"] == reason:
                    return event
        self.fail(f"No event for {reason}")

    def test_unknown_or_unlisted_part_is_blocked_before_local_floor_evidence(self):
        store = self.store()
        self.assertEqual(store.serial_status(event_time(NOW).date())['status'], 'issuer_not_allowed')
        result = self.record(store)
        self.assertEqual(result['reservation_blocked'], 'issuer_not_allowed')
        self.assertEqual(self.event('weigh_reservation_blocked')['detail']['cause'], 'issuer_not_allowed')
        with self.assertRaisesRegex(ValueError, 'not assigned'):
            store.confirm_no_issuance(PART, 'Synthetic check', 'Test admin')
        with self.ledger.read() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM weigh_jobs').fetchone()[0], 0)

    def test_transfer_ceiling_and_policy_hash_are_used_offline(self):
        inherited = {'previous_id': 3, 'ceilings': [
            {'print_date': '2016-01-02', 'serial_floor': 70}, {'print_date': NOW[:10], 'serial_floor': 38}
        ]}
        digest = self.apply(2, [(PART, 4, inherited)])
        store = self.store()
        result = self.record(store)
        self.assertEqual(result['reservation_blocked'], 'issuer_transfer_required')
        with self.assertRaisesRegex(ValueError, 'inherited'):
            store.confirm_no_issuance(PART, 'Synthetic check', 'Test admin')
        issuer_policy.confirm_transfer(self.ledger, self.settings, PART, 'Prior upper bound', 'Test admin', clock=self.clock)
        store.action('resume', {})
        self.record(store)
        reserved = self.event('label_reserved')
        self.assertEqual(reserved['detail']['issuer_assignment_id'], 4)
        self.assertEqual(reserved['detail']['issuer_policy_sha256'], digest)
        self.assertEqual(reserved['config_version'], issuer_policy.effective_version(self.settings.products[PART].version, digest))
        self.assertEqual(self.event('serial_transfer_confirmed')['detail']['serial_floor'], 70)
        with self.ledger.read() as conn:
            self.assertEqual(conn.execute('SELECT serial FROM weigh_jobs').fetchone()[0], 71)

    def test_withdrawal_rejects_pending_work_and_older_config_and_sql_dispatch(self):
        self.apply(1, [(PART, 1, None)])
        store = self.store()
        store.confirm_no_issuance(PART, 'Synthetic start', 'Test admin')
        self.record(store)
        with self.assertRaisesRegex(ValueError, 'pending printing'):
            self.apply(2, [])
        row, attempt = store.begin_dispatch()
        store.finish(row, attempt, 'submitted', 'positive_ack')
        digest = self.apply(2, [])
        self.assertEqual(self.apply(2, []), digest)
        with self.assertRaisesRegex(ValueError, 'older'):
            self.apply(1, [(PART, 1, None)])
        with self.assertRaisesRegex(ValueError, 'conflicts'):
            self.apply(2, [(PART, 1, None)])
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'issuer required'), self.ledger.transaction() as conn:
            conn.execute("UPDATE weigh_jobs SET state='dispatching' WHERE row_id=?", (row['row_id'],))
        self.assertEqual(self.store().serial_status(event_time(NOW).date())['status'], 'issuer_not_allowed')

    def test_current_policy_reaches_real_heartbeat_envelope(self):
        digest = self.apply(1, [(OTHER, 5, None)])
        payloads = []

        class Transport:
            def post(self, endpoint, raw):
                body = json.loads(raw)
                payloads.append((endpoint, body))
                return dict({key: body[key] for key in ('contract', 'station_id', 'database_id', 'heartbeat_id')},
                            received_at=body['client_at'], current=True)

        transport = Transport()
        runtime = Runtime(self.ledger, transport)
        runtime.uploader._send_heartbeat(runtime._heartbeat_snapshot())
        ((endpoint, actual),) = payloads
        self.assertEqual(endpoint, 'heartbeat')
        self.assertEqual(actual['issuer_policy'], {'revision': 1, 'sha256': digest, 'applied_seq': 1,
                                                  'grants': [{'namespace': 'SYN', 'part_no': OTHER, 'assignment_id': 5}]})

    def test_checkpoint_rejects_backup_before_revocation(self):
        connection = Connection('http://127.0.0.1:1', self.ledger.station_id, 'synthetic')
        first = policy(self.ledger.station_id, 1, [(PART, 1, None)])
        issuer_policy.apply_to_station(self.root, connection, first)
        backup = Backup(self.ledger, self.root / 'backup', min_free_bytes=0, idle_seconds=0)
        from threading import Event
        self.assertTrue(backup.due(1, Event()))
        historical, = (self.root / 'backup').glob('*.sqlite3')
        second = policy(self.ledger.station_id, 2, [])
        issuer_policy.apply_to_station(self.root, connection, second)
        issuer_policy.check_runtime_checkpoint(self.ledger)
        with self.assertRaisesRegex(ValueError, 'withdrawn grant'):
            issuer_policy.check_restore_checkpoint(self.root, self.ledger.station_id, historical)
        with self.assertRaisesRegex(ValueError, 'checkpoint'):
            issuer_policy.apply_to_station(self.root, connection, first)
