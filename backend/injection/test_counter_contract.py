from datetime import datetime, timedelta
from unittest.mock import patch

import pytz
from django.test import SimpleTestCase, TestCase

from production.counter_utils import calculate_counter_increment, calculate_cumulative_counter_delta
from .mes_service import mes_service
from .models import InjectionMonitoringRecord, InjectionMonitoringRollup


class CounterPolicyTests(SimpleTestCase):
    def test_baseline_reset_and_small_correction_share_one_policy(self):
        self.assertEqual(calculate_counter_increment(None, 100), 0)
        self.assertEqual(calculate_counter_increment(100, 5), 5)
        self.assertEqual(calculate_counter_increment(100, 99), 0)
        self.assertEqual(calculate_cumulative_counter_delta([100, 5, 9], baseline=90), 19)
        self.assertEqual(calculate_cumulative_counter_delta([100, 5, 9]), 9)


class MonitoringCounterContractTests(TestCase):
    zone = pytz.timezone('Asia/Shanghai')
    now = zone.localize(datetime(2026, 9, 6, 12, 0))
    start = zone.localize(datetime(2026, 9, 4, 8, 10))

    def sample(self, moment, capacity=None, machine=1, **values):
        return InjectionMonitoringRecord.objects.create(
            machine_name=f'{machine}호기', device_code=f'test-{machine}',
            timestamp=moment, capacity=capacity, **values,
        )

    def matrix(self, reference=None, machines=None, columns=2):
        with patch('injection.mes_service.datetime', wraps=datetime) as clock:
            clock.now.return_value = self.now
            return mes_service.get_production_matrix(
                interval_type='10min', columns=columns, reference_time=reference,
                machine_numbers=machines or [1],
            )

    def reset_samples(self):
        self.sample(self.start - timedelta(minutes=10), 90)
        for minutes, value in [(1, 100), (2, 5), (3, 9)]:
            self.sample(self.start + timedelta(minutes=minutes), value)

    def test_matrix_processes_reset_inside_one_display_bucket(self):
        self.reset_samples()
        result = self.matrix(self.start + timedelta(minutes=10))
        self.assertEqual(result['actual_production_matrix']['1'], [19, 0])
        self.assertEqual(result['cumulative_production_matrix']['1'], [9, 9])
        self.assertEqual(result['capacity_observed_matrix']['1'], [True, False])
        self.assertEqual(result['machine_sources']['1']['sample_count'], 3)
        self.assertEqual(result['counter_policy'], 'reset-aware-v1')

    def test_new_rollup_writer_uses_the_same_reset_policy(self):
        self.reset_samples()
        mes_service.upsert_monitoring_rollups(self.start, self.start + timedelta(minutes=20), bucket_minutes=5)
        self.assertAlmostEqual(sum(InjectionMonitoringRollup.objects.values_list('shot_count', flat=True)), 19)

    def test_rollup_writer_skips_negative_samples_like_the_raw_matrix(self):
        self.sample(self.start - timedelta(minutes=1), 10)
        self.sample(self.start + timedelta(minutes=1), -1)
        self.sample(self.start + timedelta(minutes=2), 12)
        result = self.matrix(self.start + timedelta(minutes=10))
        mes_service.upsert_monitoring_rollups(self.start, self.start + timedelta(minutes=20), bucket_minutes=5)
        self.assertEqual(sum(result['actual_production_matrix']['1']), 2)
        self.assertAlmostEqual(sum(InjectionMonitoringRollup.objects.values_list('shot_count', flat=True)), 2)

    def test_rollup_writer_preserves_output_between_subminute_samples(self):
        self.sample(self.start, 10)
        self.sample(self.start + timedelta(seconds=30), 20)
        result = self.matrix(self.start + timedelta(minutes=10))
        mes_service.upsert_monitoring_rollups(self.start, self.start + timedelta(minutes=20), bucket_minutes=5)
        self.assertEqual(sum(result['actual_production_matrix']['1']), 10)
        self.assertAlmostEqual(sum(InjectionMonitoringRollup.objects.values_list('shot_count', flat=True)), 10)

    def test_temperature_only_slot_cannot_hide_a_capacity_observation(self):
        self.sample(self.start - timedelta(minutes=1), 10)
        self.sample(self.start + timedelta(minutes=1), 12)
        self.sample(self.start + timedelta(minutes=2), oil_temperature=50)
        result = self.matrix(self.start + timedelta(minutes=10))
        self.assertEqual(result['actual_production_matrix']['1'], [2, 0])
        self.assertEqual(result['capacity_observed_matrix']['1'], [True, False])
        self.assertEqual(result['machine_sources']['1']['sample_count'], 1)

    def test_missing_capacity_is_distinct_from_an_observed_zero(self):
        self.sample(self.start + timedelta(minutes=1), oil_temperature=50)
        self.sample(self.start + timedelta(minutes=1), capacity=0, machine=2)
        result = self.matrix(self.start + timedelta(minutes=10), machines=[1, 2])
        self.assertEqual(result['machine_sources']['1']['status'], 'missing')
        self.assertEqual(result['capacity_observed_matrix']['1'], [False, False])
        self.assertEqual(result['machine_sources']['2']['status'], 'ok')
        self.assertEqual(result['capacity_observed_matrix']['2'], [True, False])
        self.assertEqual(result['actual_production_matrix']['2'], [0, 0])

    def test_live_freshness_uses_capacity_time_and_historical_scope_is_not_stale(self):
        capacity_time = self.now - timedelta(minutes=15)
        self.sample(capacity_time, 10)
        self.sample(self.now, oil_temperature=50)
        live = self.matrix(columns=3)
        self.assertEqual(live['machine_sources']['1']['status'], 'stale')
        self.assertNotEqual(live['source_latest_at'], live['generated_at'])
        self.sample(self.start + timedelta(minutes=1), 2, machine=2)
        historical = self.matrix(self.start + timedelta(minutes=10), machines=[2])
        self.assertEqual(historical['machine_sources']['2']['status'], 'ok')

    def test_unversioned_stored_fallback_is_flagged_without_rebuilding(self):
        rollup = InjectionMonitoringRollup.objects.create(
            machine_name='1호기', device_code='test-1', bucket_start=self.start.replace(minute=0),
            bucket_minutes=30, shot_count=7,
        )
        old_updated_at = rollup.updated_at
        # The full 08:00-08:30 stored bucket belongs to this display window.
        result = self.matrix(self.start + timedelta(minutes=10), columns=3)
        self.assertEqual(result['stored_rollup_policy'], 'unversioned')
        self.assertIn('stored_rollup_counter_policy_unversioned', result['warnings'])
        rollup.refresh_from_db()
        self.assertEqual(rollup.updated_at, old_updated_at)
        self.assertEqual(rollup.shot_count, 7)

    def test_observed_zero_cannot_be_replaced_by_an_old_stored_total(self):
        start = self.start.replace(minute=0)
        self.sample(start - timedelta(minutes=1), 10)
        self.sample(start + timedelta(minutes=1), 10)
        InjectionMonitoringRollup.objects.create(
            machine_name='1호기', device_code='test-1', bucket_start=start,
            bucket_minutes=30, shot_count=7,
        )
        result = self.matrix(self.start + timedelta(minutes=10), columns=3)
        self.assertEqual(result['actual_production_matrix']['1'], [0, 0, 0])
        self.assertEqual(result['rollup_production_matrix']['1'], [0])
        self.assertEqual(result['stored_rollup_policy'], 'not_used')

    def test_stored_bucket_outside_the_selected_window_is_not_used(self):
        InjectionMonitoringRollup.objects.create(
            machine_name='1호기', device_code='test-1', bucket_start=self.start.replace(minute=0),
            bucket_minutes=30, shot_count=7,
        )
        result = self.matrix(self.start)  # 08:00-08:20 cannot contain a full 30-minute total.
        self.assertEqual(result['rollup_production_matrix']['1'], [0])
        self.assertEqual(result['stored_rollup_policy'], 'not_used')
        self.assertFalse(result['rollup_source'])

    def test_unrelated_machine_rollup_does_not_mark_selected_scope_as_fallback(self):
        InjectionMonitoringRollup.objects.create(
            machine_name='2호기', device_code='test-2', bucket_start=self.start.replace(minute=0),
            bucket_minutes=30, shot_count=7,
        )
        result = self.matrix(self.start)
        self.assertEqual(result['stored_rollup_policy'], 'not_used')
        self.assertFalse(result['rollup_source'])
