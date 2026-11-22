"""Human API behavior backed by an isolated, synthetic field ledger."""

import csv
from datetime import date, datetime, timedelta, timezone
from io import StringIO
from unittest.mock import patch
from uuid import UUID

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.urls import path
from rest_framework.test import APIClient

from injection.cycle_time_history import business_date_at

from .models import FieldArchiveEvent, FieldEvent, FieldStation, FieldStationHeartbeat
from .read_views import EventsCsvView, EventsView, ExceptionsView, OverviewView


BASE = '/api/field/v1/'
urlpatterns = [
    path('api/field/v1/overview/', OverviewView.as_view()),
    path('api/field/v1/exceptions/', ExceptionsView.as_view()),
    path('api/field/v1/events/', EventsView.as_view()),
    path('api/field/v1/events.csv', EventsCsvView.as_view()),
]


@override_settings(ROOT_URLCONF=__name__)
class FieldReadTests(TestCase):
    now = datetime(2026, 1, 2, 2, tzinfo=timezone.utc)
    current_day = '2026-01-02'
    ledger = UUID('22222222-2222-4222-8222-222222222222')

    @classmethod
    def setUpTestData(cls):
        cls.viewer = get_user_model().objects.create_user(username='SYNTH-VIEWER')
        cls.viewer.profile.can_view_injection = True
        cls.viewer.profile.save(update_fields=['can_view_injection'])
        cls.station = FieldStation.objects.create(
            station_id='SYNTH-A', display_name='Synthetic A', apps=['barcode', 'weigh_label'],
            created_by=cls.viewer,
        )

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(self.viewer)
        self.seq = 0
        clock = patch('field_monitoring.read_views.timezone.now', return_value=self.now)
        clock.start()
        self.addCleanup(clock.stop)

    def new_station(self, ident, *, enabled=True):
        return FieldStation.objects.create(
            station_id=ident, display_name=ident, apps=['barcode'], created_by=self.viewer, enabled=enabled,
        )

    def heartbeat(self, station, *, minutes_ago, clock=0, until=None, devices=None, outbox=None):
        return FieldStationHeartbeat.objects.create(
            station=station, received_at=self.now - timedelta(minutes=minutes_ago), clock_offset_seconds=clock,
            duplicate_sender_until=until, payload={
                'apps': [{'app': 'barcode', 'version': '1.0.0', 'last_work_at': self.now.isoformat()}],
                'devices': devices or [],
                'outbox': outbox or {},
            },
        )

    def event(self, *, station=None, occurred=None, app='barcode', event_type='scan.recorded',
              result='ok', reason='scan_match', mode='production', suspect=False, job_id='',
              ref=None, detail=None, barcode='', serial='', part_no='', status_raw='raw',
              device=None, archive=False):
        self.seq += 1
        occurred = occurred or self.now - timedelta(minutes=5)
        payload = {'status_raw': status_raw, 'ref': ref or {}, 'detail': detail or {}}
        if device is not None:
            payload['device'] = device
        model = FieldArchiveEvent if archive else FieldEvent
        return model.objects.create(
            station=station or self.station, database_id=self.ledger, seq=self.seq, app=app,
            event_type=event_type, mode=mode, result=result, reason=reason, barcode=barcode, serial=serial,
            part_no=part_no, job_id=job_id, occurred_at=occurred, received_at=self.now,
            business_date=business_date_at(occurred), clock_offset_seconds=361, clock_suspect=suspect,
            payload=payload,
        )

    def test_overview_uses_business_date_and_distinguishes_current_health_from_work(self):
        stale, offline, never, disabled = (
            self.new_station('SYNTH-B'), self.new_station('SYNTH-C'), self.new_station('SYNTH-D'),
            self.new_station('SYNTH-E', enabled=False),
        )
        self.heartbeat(
            self.station, minutes_ago=3, clock=-301, until=self.now + timedelta(seconds=1),
            outbox={'pending_count': 1, 'oldest_occurred_at': (self.now - timedelta(minutes=31)).isoformat()},
        )
        self.heartbeat(stale, minutes_ago=15, clock=300,
                       outbox={'pending_count': 1, 'oldest_occurred_at': (self.now - timedelta(minutes=30)).isoformat()})
        self.heartbeat(offline, minutes_ago=16, outbox={'state': 'blocked', 'pending_count': 0})
        self.heartbeat(disabled, minutes_ago=20, clock=10_000)
        unknown_outbox = self.new_station('SYNTH-F')
        self.heartbeat(unknown_outbox, minutes_ago=1, outbox={'pending_count': None})
        boundary = datetime(2026, 1, 2, tzinfo=timezone.utc)
        self.event(occurred=boundary)
        self.event(occurred=boundary - timedelta(microseconds=1), result='ng')
        self.event(mode='test', result='ng')
        self.event(suspect=True, result='ng')
        self.event(app='weigh_label', event_type='label.dispatched', result='error', reason='print_uncertain')
        self.event(app='vision_capture', event_type='capture.single', mode='test')

        overview = self.client.get(BASE + 'overview/')
        self.assertEqual(overview.status_code, 200)
        self.assertEqual(overview.data['business_date'], date.fromisoformat(self.current_day))
        stations = {row['station_id']: row for row in overview.data['stations']}
        a = stations[self.station.station_id]
        self.assertEqual(a['connection'], 'online')
        self.assertEqual(a['production_counts'], {'ok': 1, 'ng': 0, 'error': 1, 'info': 0})
        self.assertEqual(a['non_production_count'], 2)
        self.assertEqual(a['exception_count'], 5)
        self.assertEqual(a['app_counts'], [
            {'app': 'barcode', 'production_counts': {'ok': 1, 'ng': 0, 'error': 0, 'info': 0}, 'non_production_count': 1},
            {'app': 'weigh_label', 'production_counts': {'ok': 0, 'ng': 0, 'error': 1, 'info': 0}, 'non_production_count': 0},
            {'app': 'vision_capture', 'production_counts': {'ok': 0, 'ng': 0, 'error': 0, 'info': 0}, 'non_production_count': 1},
        ])
        self.assertEqual(overview.data['summary'], {
            'registered_pc_count': 6, 'online_pc_count': 2, 'disconnected_pc_count': 4, 'exception_count': 8,
        })
        self.assertEqual(a['clock_offset_seconds'], -301)
        self.assertCountEqual(a['warnings'], ['clock_offset', 'duplicate_sender', 'upload_backlog'])
        self.assertEqual(stations[stale.station_id]['connection'], 'stale')
        self.assertEqual(stations[stale.station_id]['warnings'], ['connection_stale'])
        self.assertEqual(stations[offline.station_id]['connection'], 'offline')
        self.assertCountEqual(stations[offline.station_id]['warnings'], ['connection_offline', 'upload_backlog'])
        self.assertEqual(stations[never.station_id]['connection'], 'never')
        self.assertIsNone(stations[never.station_id]['last_heartbeat_at'])
        self.assertEqual(stations[disabled.station_id]['warnings'], [])
        self.assertIsNone(stations[unknown_outbox.station_id]['outbox']['pending_count'])
        self.assertEqual(stations[unknown_outbox.station_id]['warnings'], [])

        yesterday = self.client.get(BASE + 'overview/', {
            'station': self.station.station_id, 'business_date': '2026-01-01',
        })
        self.assertEqual(len(yesterday.data['stations']), 1)
        self.assertEqual(yesterday.data['stations'][0]['production_counts']['ng'], 1)
        self.assertEqual(yesterday.data['summary'], {
            'registered_pc_count': 1, 'online_pc_count': 1, 'disconnected_pc_count': 0, 'exception_count': 4,
        })

    def test_exceptions_link_production_records_and_latest_operational_warnings(self):
        self.heartbeat(
            self.station, minutes_ago=16, clock=301, until=self.now + timedelta(minutes=1),
            outbox={'state': 'storage_pressure', 'pending_count': 0},
            devices=[{'app': 'barcode', 'state': 'disconnected'}, {'app': 'weigh_label', 'state': 'fault'}],
        )
        required_reasons = (
            ('barcode', 'scan.recorded', 'ng', 'scan_duplicate'),
            ('barcode', 'scan.recorded', 'ng', 'scan_invalid'),
            ('barcode', 'scan.recorded', 'ng', 'scan_overlength'),
            ('barcode', 'scan.recorded', 'ng', 'scan_wrong_product_group'),
            ('barcode', 'scan.recorded', 'ng', 'scan_wrong_device'),
            ('weigh_label', 'weigh.result', 'ng', 'weight_outside_limit'),
            ('weigh_label', 'weigh.result', 'ng', 'weight_at_or_below_zero'),
            ('weigh_label', 'label.dispatched', 'error', 'print_uncertain'),
            ('weigh_label', 'label.dispatched', 'error', 'print_rejected_unsent'),
            ('vision_backcover', 'vision.cycle', 'ng', 'operation_not_confirmed'),
            ('vision_backcover', 'vision.cycle', 'error', 'vision_incomplete'),
            ('vision_backcover', 'device.state', 'error', 'vision_device_fault'),
            ('vision_backcover', 'device.state', 'error', 'vision_runtime_fault'),
            ('vision_capture', 'capture.pair', 'error', 'capture_pair_incomplete'),
            ('vision_uv', 'vision.batch', 'ng', 'uv_batch_fail'),
        )
        for app, event_type, result, reason in required_reasons:
            self.event(app=app, event_type=event_type, result=result, reason=reason)
        self.event(result='ng', reason='scan_invalid', suspect=True)
        self.event(result='ng', reason='scan_invalid', occurred=self.now - timedelta(days=1))
        for mode in ('test', 'demo', 'manual'):
            self.event(mode=mode)
        self.event(app='test_only_app', mode='test')
        self.event(mode='unknown')
        result = self.client.get(BASE + 'exceptions/')
        self.assertEqual(result.status_code, 200)
        by_reason = {row['reason']: row for row in result.data['exceptions']}
        self.assertSetEqual(set(by_reason), {item[3] for item in required_reasons} | {
            'connection_offline', 'clock_offset', 'duplicate_sender', 'upload_backlog',
            'device_fault', 'device_disconnected', 'non_production_activity',
        })
        for _, _, _, reason in required_reasons:
            self.assertEqual(by_reason[reason]['count'], 1)
            self.assertEqual(by_reason[reason]['filters']['reason'], reason)
            self.assertEqual(by_reason[reason]['filters']['mode'], 'production')
        mode_entries = [
            row['filters']['mode'] for row in result.data['exceptions'] if row['reason'] == 'non_production_activity'
        ]
        self.assertCountEqual(mode_entries, ['test', 'demo', 'manual'])
        overview = self.client.get(BASE + 'overview/')
        self.assertEqual(overview.data['summary']['exception_count'], sum(row['count'] for row in result.data['exceptions']))

    def test_barcode_rescan_exception_keeps_ok_and_drills_to_the_matching_record(self):
        details = {'seen_before_reset': True}
        accepted_again = self.event(detail=details, barcode='SYNTH-RESCAN')
        self.event(barcode='SYNTH-RESCAN')
        self.event(detail={'seen_before_reset': False})
        self.event(mode='test', detail=details)
        self.event(mode='unknown', detail=details)
        self.event(detail=details, app='weigh_label', event_type='weigh.result')
        self.event(detail=details, suspect=True)
        result = self.client.get(BASE + 'exceptions/')
        row = next(row for row in result.data['exceptions'] if row['reason'] == 'barcode_seen_before_reset')
        self.assertEqual(row['count'], 1)
        overview = self.client.get(BASE + 'overview/')
        self.assertEqual(overview.data['stations'][0]['production_counts']['ok'], 4)
        records = self.client.get(BASE + 'events/', row['filters']).data['results']
        self.assertEqual([(record['id'], record['result'], record['reason']) for record in records],
                         [(accepted_again.pk, 'ok', 'scan_match')])
        self.assertEqual(self.client.get(BASE + 'events/', {'seen_before_reset': 'bad'}).status_code, 400)

    def submit(self, job_id='', *, occurred=None, jobs=None, station=None):
        return self.event(
            station=station, app='weigh_label', event_type='label.dispatched', result='info', reason='print_submitted',
            job_id=job_id, occurred=occurred or self.now - timedelta(minutes=31), detail={'job_ids': jobs or []},
        )

    def reread(self, job_id, *, occurred=None, origin='local', mode='production', station=None, suspect=False):
        return self.event(
            station=station, app='weigh_label', event_type='label.reread', result='ok', reason='reread_match',
            job_id=job_id, occurred=occurred or self.now - timedelta(minutes=1),
            detail={'label_origin': origin}, mode=mode, suspect=suspect,
        )

    def test_overdue_uses_job_not_physical_row_and_only_later_valid_local_rereads_close(self):
        other = self.new_station('SYNTH-B')
        self.submit(jobs=['SYNTH-OVERDUE', 'SYNTH-CLOSED', 'SYNTH-EXTERNAL'])
        self.submit('SYNTH-OVERDUE')  # One overdue job even in two distinct transmissions.
        self.reread('SYNTH-CLOSED')
        self.reread('SYNTH-EXTERNAL', origin='external')
        self.reread('SYNTH-OVERDUE', occurred=self.now - timedelta(minutes=32))
        self.reread('SYNTH-OVERDUE', mode='test')
        self.reread('SYNTH-OVERDUE', station=other)
        self.reread('SYNTH-OVERDUE', suspect=True)
        self.submit('SYNTH-EXACTLY-30', occurred=self.now - timedelta(minutes=30))

        result = self.client.get(BASE + 'exceptions/', {'station': self.station.station_id})
        self.assertEqual(result.status_code, 200)
        overdue = [row for row in result.data['exceptions'] if row['reason'] == 'print_reread_overdue']
        self.assertCountEqual([row['filters']['job_id'] for row in overdue], ['SYNTH-OVERDUE', 'SYNTH-EXTERNAL'])
        linked = self.client.get(BASE + 'events/', next(
            row['filters'] for row in overdue if row['filters']['job_id'] == 'SYNTH-EXTERNAL'
        ))
        self.assertSetEqual({row['type'] for row in linked.data['results']}, {'label.dispatched', 'label.reread'})

    def test_next_day_reread_closes_prior_day_submission(self):
        boundary = datetime(2026, 1, 2, tzinfo=timezone.utc)
        self.submit('SYNTH-OVERNIGHT', occurred=boundary - timedelta(minutes=10))
        self.reread('SYNTH-OVERNIGHT', occurred=boundary + timedelta(minutes=2))
        result = self.client.get(BASE + 'exceptions/', {'business_date': '2026-01-01'})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.data['exceptions'], [])

    def test_vision_conflict_excludes_both_original_rows_from_counts_across_days(self):
        boundary = datetime(2026, 1, 2, tzinfo=timezone.utc)
        cycle_id = 'SYNTH-SESSION:1'
        other = self.new_station('SYNTH-OTHER')

        def vision(ref, **changes):
            values = {
                'app': 'vision_backcover', 'event_type': 'vision.cycle',
                'result': 'error', 'reason': 'vision_incomplete', 'ref': {'cycle_id': ref},
            }
            return self.event(**{**values, **changes})

        verdict = vision(cycle_id, occurred=boundary - timedelta(minutes=1), result='ok', reason='occlusion_confirmed')
        incomplete = vision(cycle_id, occurred=boundary + timedelta(minutes=1))
        vision(cycle_id, station=other)  # Same producer ref on another station is independent.
        vision('SYNTH-SESSION:2', result='ng', reason='operation_not_confirmed')
        vision('SYNTH-SESSION:2', mode='test')
        vision('SYNTH-SESSION:2', suspect=True)
        vision('SYNTH-SESSION:3')

        scope = {'station': self.station.station_id, 'business_date': self.current_day}
        overview = self.client.get(BASE + 'overview/', scope)
        self.assertEqual(overview.status_code, 200)
        self.assertEqual(overview.data['stations'][0]['production_counts'], {'ok': 0, 'ng': 1, 'error': 1, 'info': 0})
        prior = self.client.get(BASE + 'overview/', {**scope, 'business_date': '2026-01-01'})
        self.assertEqual(prior.data['stations'][0]['production_counts']['ok'], 0)
        other_station = self.client.get(BASE + 'overview/', {**scope, 'station': other.station_id})
        self.assertEqual(other_station.data['stations'][0]['production_counts']['error'], 1)

        exceptions = self.client.get(BASE + 'exceptions/', scope)
        self.assertEqual(exceptions.status_code, 200)
        conflicts = [row for row in exceptions.data['exceptions'] if row['reason'] == 'vision_cycle_conflict']
        self.assertEqual(len(conflicts), 1)
        filters = conflicts[0]['filters']
        self.assertEqual(conflicts[0]['count'], 1)
        self.assertEqual((filters['from'], filters['to'], filters['cycle_id']), ('2026-01-01', self.current_day, cycle_id))
        search = self.client.get(BASE + 'events/', filters)
        self.assertEqual(search.status_code, 200)
        self.assertEqual([row['id'] for row in search.data['results']], [incomplete.pk, verdict.pk])

    def test_vision_review_keeps_observation_modes_and_cross_mode_conflicts(self):
        v49 = {'app': 'vision_backcover', 'event_type': 'vision.cycle'}
        self.event(**v49, ref={'cycle_id': 'SYNTH-CROSS'}, result='ok', reason='occlusion_confirmed')
        self.event(**v49, ref={'cycle_id': 'SYNTH-CROSS'}, mode='unknown', result='error', reason='vision_incomplete')
        self.event(**v49, ref={'cycle_id': 'SYNTH-LIVE'}, mode='unknown', result='ng', reason='operation_not_confirmed')
        self.event(**v49, ref={'cycle_id': 'SYNTH-VIDEO'}, mode='demo', result='ng', reason='operation_not_confirmed')
        self.event(app='vision_backcover', event_type='device.state', mode='unknown',
                   result='error', reason='vision_device_fault')
        self.event(app='vision_backcover', event_type='operator.action', mode='unknown',
                   result='info', reason='vision_source_gap')
        self.event(app='vision_capture', event_type='capture.pair', mode='unknown',
                   result='error', reason='capture_pair_incomplete')
        self.event(app='vision_uv', event_type='vision.batch', mode='manual', result='ng', reason='uv_batch_fail')
        self.event(app='vision_uv', event_type='vision.batch', mode='demo', result='ng', reason='uv_batch_fail')
        scope = {'station': self.station.station_id, 'business_date': self.current_day}
        overview = self.client.get(BASE + 'overview/', scope).data['stations'][0]
        self.assertEqual(overview['production_counts'], {'ok': 0, 'ng': 0, 'error': 0, 'info': 0})
        rows = self.client.get(BASE + 'exceptions/', scope).data['exceptions']
        by_reason = {row['reason']: row for row in rows}
        for reason, app, mode in (
            ('operation_not_confirmed', 'vision_backcover', 'unknown'),
            ('vision_device_fault', 'vision_backcover', 'unknown'),
            ('vision_source_gap', 'vision_backcover', 'unknown'),
            ('capture_pair_incomplete', 'vision_capture', 'unknown'),
            ('uv_batch_fail', 'vision_uv', 'manual'),
        ):
            row = by_reason[reason]
            self.assertEqual((row['count'], row['filters']['app'], row['filters']['mode']), (1, app, mode))
            self.assertEqual(len(self.client.get(BASE + 'events/', row['filters']).data['results']), 1)
        conflict = by_reason['vision_cycle_conflict']['filters']
        self.assertNotIn('mode', conflict)
        self.assertEqual({row['mode'] for row in self.client.get(BASE + 'events/', conflict).data['results']},
                         {'production', 'unknown'})

    def test_search_cursor_is_tied_to_filters_and_reaches_all_timestamp_ties(self):
        barcode = 'SYNTH-CODE'
        a = self.event(barcode=barcode, reason='scan_match', suspect=True)
        b = self.event(barcode=barcode, reason='scan_match')
        c = self.event(barcode=barcode, reason='scan_match')
        self.event(barcode=barcode.lower(), reason='scan_match')
        self.event(barcode=barcode, reason='scan_duplicate')
        self.event(barcode=barcode, reason='scan_match', occurred=self.now - timedelta(days=1))
        filters = {
            'station': self.station.station_id, 'barcode': barcode, 'reason': 'scan_match',
            'app': 'barcode', 'type': 'scan.recorded', 'result': 'ok', 'mode': 'production', 'page_size': '2',
        }
        first = self.client.get(BASE + 'events/', filters)
        self.assertEqual(first.status_code, 200)
        self.assertIn('no-store', first['Cache-Control'].split(', '))
        self.assertEqual([row['id'] for row in first.data['results']], [c.pk, b.pk])
        cursor = first.data['next_cursor']
        last = self.client.get(BASE + 'events/', {**filters, 'cursor': cursor})
        self.assertEqual([row['id'] for row in last.data['results']], [a.pk])
        self.assertTrue(last.data['results'][0]['clock_suspect'])
        self.assertEqual(last.data['results'][0]['clock_offset_seconds'], 361)
        self.assertIsNone(last.data['next_cursor'])
        self.assertEqual(
            self.client.get(BASE + 'events/', {**filters, 'cursor': cursor, 'reason': 'scan_duplicate'}).status_code, 400
        )

    def test_invalid_filters(self):
        for filters in ({'from': '20260101'}, {'from': '2026-02-30'}, {'from': '2026-01-02', 'to': '2026-01-01'},
                        {'page_size': '501'}, {'page_size': '0'}, {'cursor': 'not-a-cursor'}, {'lane': 'X'}):
            with self.subTest(filters=filters):
                result = self.client.get(BASE + 'events/', filters)
                self.assertEqual(result.status_code, 400)
                self.assertEqual(result.data['code'], 'invalid_filter')

    def test_lane_search_and_csv_use_actual_device_in_live_and_archive(self):
        for archive in (False, True):
            with self.subTest(archive=archive):
                fixtures = {'archive': archive, 'mode': 'unknown' if archive else 'production'}
                matching = {lane: self.event(device=lane, **fixtures) for lane in ('A', 'B')}
                matching['W'] = self.event(app='weigh_label', event_type='label.reread', device='W',
                                           detail={'legacy_slot': 'A'}, **fixtures)
                missing = self.event(detail={'legacy_slot': 'B', 'expected_device': 'A'}, **fixtures)
                keyboard = self.event(device='KEYBOARD', detail={'legacy_slot': 'A'}, **fixtures)
                filters = {'archive': 'true'} if archive else {}
                rows = {row['id']: row['lane'] for row in self.client.get(BASE + 'events/', filters).data['results']}
                expected = {record.pk: lane for lane, record in matching.items()}
                self.assertEqual(rows, {**expected, missing.pk: None, keyboard.pk: None})

                for lane, record in matching.items():
                    query = {**filters, 'lane': lane}
                    selected = self.client.get(BASE + 'events/', query).data['results']
                    self.assertEqual([(row['id'], row['lane']) for row in selected], [(record.pk, lane)])
                    csv_result = self.client.get(BASE + 'events.csv', query)
                    self.assertEqual(csv_result.status_code, 200)
                    csv_rows = list(csv.DictReader(StringIO(csv_result.content.decode('utf-8-sig'))))
                    self.assertEqual([(row['id'], row['lane']) for row in csv_rows], [(str(record.pk), lane)])

                self.event(device='W', **fixtures)
                query = {**filters, 'lane': 'W', 'page_size': '1'}
                cursor = self.client.get(BASE + 'events/', query).data['next_cursor']
                self.assertIsNotNone(cursor)
                self.assertEqual(self.client.get(BASE + 'events/', {**query, 'cursor': cursor, 'lane': 'A'}).status_code,
                                 400)

    def test_csv_uses_same_filters_bom_and_formula_protection(self):
        self.event(barcode='  =SUM(1,2)', serial='+SYNTH-SERIAL', part_no='SYNTH-PART', status_raw='\tSYNTH')
        self.event(barcode='SYNTH-OTHER', part_no='SYNTH-PART-OTHER')
        csv_result = self.client.get(BASE + 'events.csv', {'part_no': 'SYNTH-PART'})
        self.assertEqual(csv_result.status_code, 200)
        self.assertIn('no-store', csv_result['Cache-Control'].split(', '))
        self.assertTrue(csv_result.content.startswith(b'\xef\xbb\xbf'))
        rows = list(csv.DictReader(StringIO(csv_result.content.decode('utf-8-sig'))))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['barcode'], "'  =SUM(1,2)")
        self.assertEqual(rows[0]['serial'], "'+SYNTH-SERIAL")
        self.assertEqual(rows[0]['status_raw'], "'\tSYNTH")
        with patch('field_monitoring.read_views.CSV_LIMIT', 1):
            result = self.client.get(BASE + 'events.csv')
        self.assertEqual(result.status_code, 400)
        self.assertEqual(result.data['code'], 'csv_limit_exceeded')

    def test_read_endpoints_require_active_injection_permission_or_superuser(self):
        self.viewer.profile.can_view_injection = False
        self.viewer.profile.save(update_fields=['can_view_injection'])
        for target in ('overview/', 'exceptions/', 'events/', 'events.csv'):
            with self.subTest(target=target):
                self.assertEqual(self.client.get(BASE + target).status_code, 403)
        self.viewer.is_superuser = True
        self.assertEqual(self.client.get(BASE + 'overview/').status_code, 200)
        self.viewer.is_active = False
        self.assertEqual(self.client.get(BASE + 'overview/').status_code, 403)
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(BASE + 'overview/').status_code, 401)
