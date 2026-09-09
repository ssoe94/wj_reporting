from datetime import datetime, timedelta
from unittest.mock import patch

import pytz
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from .mes_service import mes_service
from .models import InjectionMonitoringRecord, InjectionReport


class MatrixLoadingTests(TestCase):
    zone = pytz.timezone('Asia/Shanghai')
    start = zone.localize(datetime(2026, 9, 4, 8, 10))
    now = zone.localize(datetime(2026, 9, 6, 12))

    def sample(self, moment, capacity=None, machine=1, device=None, **values):
        return InjectionMonitoringRecord.objects.create(
            machine_name=f'{machine}호기', device_code=device or f'loading-{machine}',
            timestamp=moment, capacity=capacity, **values,
        )

    def matrix(self, machines):
        with patch('injection.mes_service.datetime', wraps=datetime) as clock:
            clock.now.return_value = self.now
            return mes_service.get_production_matrix(
                interval_type='10min', columns=2,
                reference_time=self.start + timedelta(minutes=10),
                machine_numbers=machines,
            )

    def test_fleet_queries_and_hydration_are_bounded_when_power_is_missing(self):
        # A missing power counter previously kept the baseline scan open over
        # the entire history, including every row for all preceding machines.
        machines = list(range(1, 18))
        InjectionMonitoringRecord.objects.bulk_create([
            InjectionMonitoringRecord(
                machine_name=f'{number}호기', device_code=f'loading-{number}',
                timestamp=self.start - timedelta(minutes=300 - offset),
                capacity=offset,
            )
            for number in machines for offset in range(300)
        ])
        for number in machines:
            self.sample(self.start, 301, number)

        for selected in ([1], machines):
            with self.subTest(machines=len(selected)):
                with patch.object(InjectionMonitoringRecord, 'from_db', wraps=InjectionMonitoringRecord.from_db) as hydrate:
                    with CaptureQueriesContext(connection) as queries:
                        result = self.matrix(selected)
                self.assertEqual(len(queries), 5)
                self.assertEqual(hydrate.call_count, 2 * len(selected))
                self.assertEqual(set(result['actual_production_matrix']), {str(number) for number in selected})
                for number in selected:
                    self.assertEqual(result['actual_production_matrix'][str(number)], [2, 0])
                    self.assertEqual(result['power_usage_matrix'][str(number)], [0, 0])

    def test_independent_valid_baselines_preserve_reset_and_window_boundaries(self):
        self.sample(self.start - timedelta(minutes=5), power_kwh=100)
        self.sample(self.start - timedelta(minutes=3), 90)
        self.sample(self.start - timedelta(minutes=1), -1, power_kwh=-1)
        self.sample(self.start, 100, power_kwh=102)
        self.sample(self.start + timedelta(minutes=1), 5)
        self.sample(self.start + timedelta(minutes=2), 9, power_kwh=103)
        self.sample(self.start + timedelta(minutes=20), 999, power_kwh=999)
        # A baseline from another machine must never fill a missing baseline.
        self.sample(self.start - timedelta(minutes=1), 1000, machine=3, power_kwh=1000)
        self.sample(self.start, 700, machine=2, power_kwh=200)
        self.sample(self.start + timedelta(minutes=1), 702, machine=2, power_kwh=201)

        result = self.matrix([1, 2, 4])

        self.assertEqual(result['actual_production_matrix']['1'], [19, 0])
        self.assertEqual(result['power_usage_matrix']['1'], [3, 0])
        self.assertEqual(result['cumulative_production_matrix']['1'], [9, 9])
        self.assertEqual(result['actual_production_matrix']['2'], [2, 0])
        self.assertEqual(result['power_usage_matrix']['2'], [0, 0])
        self.assertEqual(result['machine_sources']['1']['sample_count'], 3)
        self.assertEqual(result['machine_sources']['4']['status'], 'missing')
        self.assertEqual(result['capacity_observed_matrix']['4'], [False, False])

    def test_equal_timestamps_have_stable_pk_order_for_baseline_and_samples(self):
        moment = self.start - timedelta(minutes=1)
        self.sample(moment, 90, device='baseline-older')
        self.sample(moment, 95, device='baseline-newer')
        self.sample(self.start, 100, device='sample-older')
        self.sample(self.start, 5, device='sample-newer')
        self.sample(self.start + timedelta(minutes=1), 9)

        result = self.matrix([1])

        self.assertEqual(result['actual_production_matrix']['1'], [14, 0])
        self.assertEqual(result['cumulative_production_matrix']['1'], [9, 9])

    def test_tonnage_uses_latest_nonempty_date_id_and_requested_scope(self):
        def report(day, machine, tonnage):
            return InjectionReport.objects.create(
                date=day, machine_no=machine, tonnage=tonnage, model='QA', section='C/A',
                plan_qty=1, actual_qty=1, reported_defect=0, actual_defect=0,
            )

        day = self.start.date()
        report(day, 1, '800T')
        report(day, 1, '900T')
        report(day + timedelta(days=1), 1, '')
        report(day + timedelta(days=1), 3, '999T')
        result = self.matrix([1, 2])

        self.assertEqual([(row['machine_number'], row['tonnage']) for row in result['machines']], [(1, '900T'), (2, '850T')])
