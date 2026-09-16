from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from django.test import TestCase

from .models import InjectionMonitoringRollup as Rollup
from .rollup_retention import compact_five_minute_rollups

HOUR = datetime(2026, 7, 1, tzinfo=timezone.utc)
NOW = datetime(2026, 9, 16, tzinfo=timezone.utc)


class RollupRetentionTests(TestCase):
    def source(self, hour=HOUR, device='A', count=12):
        for index in range(count):
            Rollup.objects.create(machine_name='12호기', device_code=device,
                bucket_start=hour + timedelta(minutes=5 * index), bucket_minutes=5,
                shot_count=index, active_minutes=2, sample_count=2,
                start_capacity=index * 10, end_capacity=(index + 1) * 10, max_power_kwh=index)

    def run_compact(self, **kwargs):
        return compact_five_minute_rollups(HOUR, NOW, now=NOW, **kwargs)

    def test_dry_run_then_create_hour_preserves_totals_and_is_idempotent(self):
        self.source()
        self.assertEqual(self.run_compact()['eligible_rows'], 12)
        self.assertEqual(Rollup.objects.count(), 12)
        self.assertEqual(self.run_compact(apply=True)['deleted_rows'], 12)
        hour = Rollup.objects.get()
        self.assertEqual((hour.bucket_minutes, hour.shot_count, hour.active_minutes, hour.sample_count), (60, 66, 24, 24))
        self.assertEqual((hour.start_capacity, hour.end_capacity, hour.max_power_kwh), (0, 120, 11))
        self.assertEqual(self.run_compact(apply=True)['deleted_rows'], 0)

    def test_existing_hour_never_double_counts_or_overwrites_conflicts(self):
        self.source()
        hour = Rollup.objects.create(machine_name='12호기', device_code='A', bucket_start=HOUR,
            bucket_minutes=60, shot_count=65, active_minutes=24, sample_count=24,
            start_capacity=0, end_capacity=120, max_power_kwh=11)
        self.assertEqual(self.run_compact(apply=True)['skipped_groups'], 1)
        self.assertEqual(Rollup.objects.filter(bucket_minutes=5).count(), 12)
        hour.shot_count = 66
        hour.save()
        self.assertEqual(self.run_compact(apply=True)['deleted_rows'], 12)
        hour.refresh_from_db()
        self.assertEqual(hour.shot_count, 66)

    def test_missing_slots_recent_data_and_thirty_minute_rows_survive(self):
        self.source(count=11)
        self.source(hour=NOW - timedelta(days=29), device='B')
        other = Rollup.objects.create(machine_name='12호기', device_code='A', bucket_start=HOUR, bucket_minutes=30)
        result = self.run_compact(apply=True)
        self.assertEqual(result['deleted_rows'], 0)
        self.assertTrue(Rollup.objects.filter(pk=other.pk).exists())
        self.assertEqual(Rollup.objects.filter(bucket_minutes=5).count(), 23)

    def test_hour_creation_failure_leaves_all_source_rows(self):
        self.source()
        with patch.object(Rollup.objects, 'create', side_effect=RuntimeError('write failed')):
            with self.assertRaises(RuntimeError):
                self.run_compact(apply=True)
        self.assertEqual(Rollup.objects.filter(bucket_minutes=5).count(), 12)

    def test_batch_limit_and_device_boundaries(self):
        self.source(device='A')
        self.source(device='B')
        self.source(hour=HOUR+timedelta(hours=1))
        result = self.run_compact(apply=True, max_hours=1)
        self.assertEqual(result['deleted_rows'], 24)
        self.assertEqual(datetime.fromisoformat(result['next_start']), HOUR+timedelta(hours=1))
        self.assertEqual(Rollup.objects.filter(bucket_minutes=60).count(), 2)
        self.assertEqual(Rollup.objects.filter(bucket_minutes=5).count(), 12)
