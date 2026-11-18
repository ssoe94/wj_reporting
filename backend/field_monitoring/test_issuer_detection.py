"""Synthetic coverage for bounded cross-station reservation and scan matching."""

from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from injection.cycle_time_history import business_date_at

from .issuer_detection import issuance_exceptions, successful_label_scans
from .models import FieldEvent, FieldLabelIssuer, FieldStation


class IssuerDetectionTests(TestCase):
    day = date(2026, 1, 2)
    boundary = datetime(2026, 1, 2, tzinfo=timezone.utc)
    part = 'SYNTH-PART'

    @classmethod
    def setUpTestData(cls):
        cls.admin = get_user_model().objects.create_superuser(username='synth-issuer-audit')
        cls.a, cls.b, cls.c = (
            FieldStation.objects.create(
                station_id='SYNTH-ISSUER-' + suffix, display_name='Synthetic ' + suffix,
                apps=['weigh_label', 'barcode'], created_by=cls.admin,
            )
            for suffix in ('A', 'B', 'C')
        )

    def setUp(self):
        self.ledger = uuid4()
        self.seq = 0

    def event(self, station, **values):
        self.seq += 1
        occurred = values.pop('occurred_at', self.boundary)
        return FieldEvent.objects.create(
            database_id=self.ledger, seq=self.seq, station=station,
            occurred_at=occurred, received_at=occurred, business_date=business_date_at(occurred),
            **values,
        )

    def reserve(self, station, *, assignment=None, **options):
        detail = {} if assignment is None else {'issuer_assignment_id': assignment.pk}
        return self.event(station, **{
            'app': 'weigh_label', 'event_type': 'label.reserved', 'mode': 'production',
            'result': 'info', 'reason': 'label_reserved', 'payload': {'detail': detail},
            'part_no': self.part, 'issuer_namespace': 'CWJ', 'label_print_date': self.day,
            'serial': '0001', **options,
        })

    def scan(self, station, barcode, *, reread=False, **options):
        return self.event(station, **{
            'app': 'weigh_label' if reread else 'barcode',
            'event_type': 'label.reread' if reread else 'scan.recorded', 'mode': 'production',
            'result': 'ok', 'reason': 'reread_match' if reread else 'scan_match',
            'barcode': barcode, 'payload': {}, **options,
        })

    def exceptions(self, *stations, day=None):
        rows = []
        issuance_exceptions(stations, day or self.day,
                            lambda station_id, reason, count, **scope: rows.append((station_id, reason, count, scope)))
        return rows

    def test_reservations_detect_peers_across_business_boundary_while_station_is_filtered(self):
        self.reserve(self.a, occurred_at=self.boundary - timedelta(seconds=1))
        self.reserve(self.b, mode='unknown')
        self.reserve(self.b, serial='0002')
        self.reserve(self.c, issuer_namespace='ALT')
        self.reserve(self.c, label_print_date=self.day + timedelta(days=1))

        self.assertEqual(self.exceptions(self.b, self.c), [(self.b.pk, 'concurrent_label_issuance', 1, {
            'station': '', 'app': 'weigh_label', 'type': 'label.reserved', 'part_no': self.part,
            'issuer_namespace': 'CWJ', 'label_print_date': self.day.isoformat(),
            'from': '2026-01-01', 'to': '2026-01-03',
        })])
        self.assertEqual(self.exceptions(self.a), [])
        older = self.exceptions(self.a, day=self.day - timedelta(days=1))
        self.assertEqual([item[:3] for item in older], [(self.a.pk, 'concurrent_label_issuance', 1)])

    def test_reservation_keys_exclude_missing_evidence_nonproduction_and_held_clock(self):
        self.reserve(self.a)
        self.reserve(self.b, mode='preview')
        self.reserve(self.b, mode='demo')
        self.reserve(self.b, clock_suspect=True)
        self.reserve(self.b, issuer_namespace='')
        self.reserve(self.b, label_print_date=None)
        self.reserve(self.b, part_no='')
        self.reserve(self.b, occurred_at=self.boundary - timedelta(days=2))
        self.reserve(self.b, result='error')
        self.assertEqual(self.exceptions(self.a, self.b), [])

    def test_test_mode_reservation_can_use_the_same_physical_serial_space(self):
        self.reserve(self.a)
        self.reserve(self.b, mode='test')
        rows = self.exceptions(self.a)
        self.assertEqual([item[1] for item in rows], ['concurrent_label_issuance'])

    def test_calibrated_same_day_handover_does_not_hide_later_reused_serial(self):
        release = self.boundary + timedelta(minutes=5)
        old = FieldLabelIssuer.objects.create(
            namespace='CWJ', part_no=self.part, station=self.a, program='weigh_label',
            assigned_at=self.boundary - timedelta(days=1), assigned_by=self.admin, reason='synthetic initial',
            stopped_at=release, stopped_by=self.admin, stop_reason='synthetic stop',
            released_at=release, released_by=self.admin, release_reason='synthetic release',
            ceilings=[{'print_date': self.day.isoformat(), 'serial_floor': 12}],
        )
        following = FieldLabelIssuer.objects.create(
            namespace='CWJ', part_no=self.part, station=self.b, program='weigh_label', predecessor=old,
            assigned_at=release, assigned_by=self.admin, reason='synthetic transfer',
        )
        self.reserve(self.a, assignment=old, serial='000C')
        self.reserve(self.b, assignment=following, occurred_at=release + timedelta(minutes=1), serial='000D')
        self.assertEqual(self.exceptions(self.a, self.b), [])

        self.reserve(self.b, assignment=following, occurred_at=release + timedelta(minutes=2), serial='000C')
        self.assertCountEqual([item[:3] for item in self.exceptions(self.a, self.b)], [
            (self.a.pk, 'concurrent_label_issuance', 1), (self.b.pk, 'concurrent_label_issuance', 1),
        ])

    def test_successful_cross_station_scans_match_once_per_barcode_and_selected_station(self):
        shared = 'SYNTH-SHARED-LABEL'
        initial = self.scan(self.a, shared)
        again = self.scan(self.a, shared)
        observed = self.scan(self.b, shared, reread=True, mode='unknown')
        self.scan(self.c, shared, reread=True, mode='test')
        self.scan(self.c, shared, clock_suspect=True)
        self.scan(self.c, shared, result='ng')
        self.scan(self.c, shared, occurred_at=self.boundary - timedelta(seconds=1))
        self.scan(self.c, shared, event_type='device.state')
        self.scan(self.c, shared, app='vision_backcover')
        self.scan(self.a, 'SYNTH-ONLY-ONE-LINE')
        self.scan(self.a, 'SYNTH-ONLY-ONE-LINE', reread=True)

        self.assertEqual(self.exceptions(self.b, self.c), [(self.b.pk, 'duplicate_barcode_issuance_suspected', 1, {
            'station': '', 'barcode': shared, 'result': 'ok', 'issuance_scan': 'true',
        })])
        self.assertCountEqual(successful_label_scans(FieldEvent.objects.filter(
            barcode=shared, business_date=self.day,
        )).values_list('pk', flat=True), (initial.pk, again.pk, observed.pk))

    def test_exception_navigation_opens_the_two_stations_actual_records(self):
        left = self.reserve(self.a, occurred_at=self.boundary - timedelta(seconds=1))
        right = self.reserve(self.b, serial='0002')
        self.reserve(self.c, issuer_namespace='ALT')
        barcode = 'SYNTH-SHARED-LABEL'
        scanned = self.scan(self.a, barcode)
        reread = self.scan(self.b, barcode, reread=True)
        self.scan(self.c, barcode, event_type='device.state')

        client = APIClient()
        client.force_authenticate(self.admin)
        api = '/api/field/v1/'
        response = client.get(api + 'exceptions/', {'business_date': self.day.isoformat(), 'station': self.b.station_id})
        self.assertEqual(response.status_code, 200)
        self.assertEqual({row['station_id'] for row in response.data['exceptions']}, {self.b.station_id})
        filters = {row['reason']: row['filters'] for row in response.data['exceptions']}
        for reason, rows in (
            ('concurrent_label_issuance', (left, right)),
            ('duplicate_barcode_issuance_suspected', (scanned, reread)),
        ):
            with self.subTest(reason=reason):
                self.assertEqual(filters[reason]['station'], '')
                evidence = client.get(api + 'events/', filters[reason])
                self.assertEqual(evidence.status_code, 200)
                self.assertCountEqual([row['id'] for row in evidence.data['results']], [event.pk for event in rows])

    def test_date_window_clamps_to_supported_calendar(self):
        self.assertEqual(self.exceptions(self.a, day=date.min), [])
        self.assertEqual(self.exceptions(self.a, day=date.max), [])
