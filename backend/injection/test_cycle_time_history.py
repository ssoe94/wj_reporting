"""Acceptance tests for evidence, durable retention, attribution and read-only access."""
from datetime import date, datetime, timedelta
from io import StringIO
from unittest.mock import patch

from django.contrib.auth.models import User
from django.core.management import call_command
from django.test import TestCase
from rest_framework.test import APIClient

from production.models import ProductionExecution, ProductionPartCavity, ProductionPlan
from .cycle_time_history import (TZ, archive_cycle_time_range, business_start,
                                read_cycle_time_history)
from .models import InjectionCycleTimeBucket, InjectionCycleTimeRevision, InjectionMonitoringRecord

DAY = date(2026, 9, 14)
START = business_start(DAY)
END = START + timedelta(days=1)


class CycleTimeEvidenceTests(TestCase):
    def sample(self, minute, counter, *, machine=12, device=None):
        return InjectionMonitoringRecord.objects.create(
            machine_name=f'{machine}호기', device_code=device or f'DEV-{machine}',
            timestamp=START + timedelta(minutes=minute), capacity=counter)

    def archive(self, **kwargs):
        return archive_cycle_time_range(DAY, DAY, now=END + timedelta(minutes=10), **kwargs)

    def history(self, **kwargs):
        return read_cycle_time_history(DAY, DAY, **kwargs)

    def plan(self, part='PART-A', qty=4, seq=0, **kwargs):
        return ProductionPlan.objects.create(plan_date=DAY, plan_type='injection', machine_name='550T-12',
                                             part_no=part, planned_quantity=qty, sequence=seq, **kwargs)

    def execution(self, part='PART-A', start=0, end=60, **kwargs):
        return ProductionExecution.objects.create(plan_date=DAY, plan_type='injection', machine_name='12호기',
            part_no=part, start_datetime=START+timedelta(minutes=start), end_datetime=START+timedelta(minutes=end), **kwargs)

    def test_positive_observed_time_excludes_flat_intervals_and_is_weighted(self):
        for minute, count in [(0,100), (2,104), (4,104), (6,106), (8,114)]:
            self.sample(minute, count)
        self.archive()
        summary = self.history()['summary']
        self.assertEqual(summary['shot_count'], 14)
        self.assertEqual(summary['positive_interval_seconds'], 360)
        self.assertEqual(summary['observed_seconds'], 480)
        self.assertEqual(summary['cycle_time_seconds'], 25.71)
        self.assertEqual(summary['quality'], 'limited')

    def test_gap_reset_correction_null_are_not_cycle_time(self):
        for minute, count in [(0,100), (2,5), (4,9), (6,8), (8,10), (10,None), (12,16), (42,30)]:
            self.sample(minute, count)
        self.archive()
        row = self.history(machine=12)['hourly'][0]
        self.assertEqual(row['shot_count'], 6)
        self.assertEqual(row['cycle_time_seconds'], 40)
        self.assertEqual(row['observed_seconds'], 240)
        self.assertEqual(row['reset_count'], 1)
        self.assertEqual(row['correction_count'], 1)
        self.assertEqual(row['gap_count'], 1)
        self.assertEqual(row['invalid_sample_count'], 1)
        self.assertEqual(row['excluded_shot_count'], 19)

    def test_sparse_preexisting_hourly_data_does_not_fabricate_ct(self):
        self.sample(0,100)
        self.sample(60,150)
        self.archive()
        summary = self.history()['summary']
        self.assertIsNone(summary['cycle_time_seconds'])
        self.assertEqual(summary['quality'], 'unavailable')
        self.assertIn('observation_gap', summary['warnings'])

    def test_business_day_and_hour_boundaries_prorate_without_double_counting(self):
        for minute, count in [(-1,100), (1,102), (59,102), (61,104), (1439,200), (1441,202)]:
            self.sample(minute,count)
        self.archive()
        archive_cycle_time_range(DAY+timedelta(days=1), DAY+timedelta(days=1), now=END+timedelta(hours=1,minutes=5))
        hours = self.history(machine=12)['hourly']
        self.assertEqual(hours[0]['shot_count'], 2)
        self.assertEqual(hours[1]['shot_count'], 1)
        self.assertEqual(hours[-1]['shot_count'], 1)
        self.assertEqual(sum(row['shot_count'] for row in hours), 4)
        next_day = read_cycle_time_history(DAY+timedelta(days=1), DAY+timedelta(days=1), machine=12)
        self.assertEqual(next_day['summary']['shot_count'], 1)

    def test_device_baselines_are_never_crossed_and_machine_three_not_adjusted_twice(self):
        self.sample(0,100, machine=3, device='old')
        self.sample(2,900, machine=3, device='new')
        self.sample(4,902.5, machine=3, device='new')
        self.archive(machine=3)
        result = self.history(machine=3)
        self.assertEqual(result['summary']['shot_count'], 2.5)
        self.assertEqual(result['summary']['cycle_time_seconds'], 48)

    def test_device_remap_updates_indexed_machine_and_preserves_previous_revision(self):
        self.sample(0,100,device='SAME-DEVICE')
        self.sample(2,102,device='SAME-DEVICE')
        self.archive()
        InjectionMonitoringRecord.objects.filter(device_code='SAME-DEVICE').update(machine_name='13호기')
        self.archive(machine=13)
        bucket=InjectionCycleTimeBucket.objects.get(device_code='SAME-DEVICE',bucket_start=START)
        self.assertEqual(bucket.machine_number,13)
        self.assertEqual(bucket.machine_name,'13호기')
        self.assertEqual(bucket.summary['machine_number'],13)
        self.assertEqual(self.history(machine=12)['daily'],[])
        self.assertEqual(self.history(machine=13)['summary']['shot_count'],2)
        self.assertEqual(bucket.revisions.get(revision=1).payload['machine_number'],12)
        self.assertEqual(bucket.revisions.get(revision=2).payload['machine_number'],13)

    def test_overlapping_devices_are_visible_and_excluded_from_trusted_ct(self):
        for device, end_count in [('OLD',102),('NEW',104)]:
            self.sample(0,100,device=device)
            self.sample(2,end_count,device=device)
        self.archive()
        result=self.history(machine=12)
        self.assertIsNone(result['summary']['cycle_time_seconds'])
        self.assertEqual(result['summary']['shot_count'],0)
        self.assertIn('ambiguous_device_mapping',result['warnings'])
        first_hours=[row for row in result['hourly'] if row['bucket_start']==START.isoformat()]
        self.assertEqual({row['device_code'] for row in first_hours},{'OLD','NEW'})
        self.assertEqual(sum(row['source_shot_count'] for row in first_hours),6)
        self.assertEqual(sum(row['expected_seconds'] for row in first_hours),3600)
        self.assertTrue(all(row['cycle_time_seconds'] is None for row in first_hours))

    def test_plan_sequence_cavity_allocation_not_duplicate_machine_ct(self):
        self.plan('PART-A', qty=4, seq=0)
        self.plan('PART-B', qty=10, seq=1)
        ProductionPartCavity.objects.create(part_no='PART-A', cavity=2, cavity_pattern='1x2')
        for minute, count in [(0,100),(2,102),(4,103)]:
            self.sample(minute,count)
        self.archive()
        first = self.history(part_no='part-a')['summary']
        second = self.history(part_no='PART-B')['summary']
        self.assertEqual(first['cycle_time_seconds'], 60)
        self.assertEqual(second['cycle_time_seconds'], 120)
        self.assertEqual(first['shot_count'], 2)
        self.assertEqual(second['shot_count'], 1)
        self.assertEqual(self.history(part_no='PART-A')['parts'][0]['attribution'], 'plan_estimated')

    def test_parallel_cavity_parts_share_same_shots_without_doubling_machine(self):
        for part, seq in [('A',0),('B',1)]:
            self.plan(part,qty=4,seq=seq)
            ProductionPartCavity.objects.create(part_no=part,cavity=2,cavity_pattern='2x2',parts_per_shot=2,cavity_group='A+B')
        self.sample(0,0)
        self.sample(2,2)
        self.archive()
        self.assertEqual(self.history()['summary']['shot_count'], 2)
        self.assertEqual(self.history(part_no='A')['summary']['shot_count'], 2)
        self.assertEqual(self.history(part_no='B')['summary']['shot_count'], 2)

    def test_actual_execution_overrides_plan_and_overlaps_are_unattributed(self):
        self.plan('PLANNED')
        self.execution('ACTUAL',start=0,end=10)
        for minute, count in [(0,0),(2,2)]:
            self.sample(minute,count)
        self.archive()
        self.assertEqual(self.history(part_no='ACTUAL')['parts'][0]['attribution'], 'execution_interval')
        self.assertEqual(self.history(part_no='PLANNED')['daily'], [])
        self.execution('OTHER',start=1,end=8,sequence=1)
        self.archive()
        self.assertEqual(self.history(part_no='ACTUAL')['daily'], [])
        self.assertEqual(self.history(machine=12)['hourly'][0]['parts'][0]['attribution'], 'unattributed')

    def test_execution_edge_and_invalid_end_do_not_claim_exact_part(self):
        self.execution('BOUNDARY',start=1,end=4)
        self.execution('INVALID',start=20,end=10,sequence=1)
        self.sample(0,0)
        self.sample(2,2)
        self.archive()
        self.assertEqual(self.history(part_no='BOUNDARY')['daily'], [])
        self.assertEqual(self.history(part_no='INVALID')['daily'], [])

    def test_full_part_number_filter_is_case_normalized_and_cross_machine(self):
        self.plan('75NAN080')
        ProductionPlan.objects.create(plan_date=DAY,plan_type='injection',machine_name='13호기',part_no='75NAN080',planned_quantity=10)
        for machine in (12,13):
            self.sample(0,0,machine=machine)
            self.sample(2,2,machine=machine)
        self.archive()
        self.assertEqual({row['machine_number'] for row in self.history(part_no='75nan080')['daily']},{12,13})
        self.assertEqual(self.history(part_no='75NAN08')['daily'], [])

    def test_idempotent_archive_and_semantic_noop_plan_reupload(self):
        plan=self.plan()
        self.sample(0,0)
        self.sample(2,2)
        first=self.archive()
        self.assertEqual(first['created'],24)
        second=self.archive()
        self.assertEqual(second['unchanged'],24)
        plan.delete()
        self.plan()
        third=self.archive()
        self.assertEqual(third['unchanged'],24)
        self.assertEqual(InjectionCycleTimeRevision.objects.count(),24)

    def test_revision_preserves_changed_counter_and_plan_evidence(self):
        self.plan()
        self.sample(0,0)
        record=self.sample(2,2)
        self.archive()
        record.capacity=4
        record.save()
        self.archive()
        bucket=InjectionCycleTimeBucket.objects.get(bucket_start=START)
        self.assertEqual(bucket.revision,2)
        self.assertEqual(bucket.revisions.get(revision=1).payload['shot_count'],2)
        self.assertEqual(bucket.revisions.get(revision=2).payload['shot_count'],4)
        self.assertEqual(bucket.payload['parts'][0]['source_identity'],bucket.revisions.get(revision=1).payload['parts'][0]['source_identity'])

    def test_archive_survives_raw_compaction_and_plan_deletion(self):
        self.plan()
        for minute in range(0,61,2):
            self.sample(minute,minute)
        self.archive()
        old=self.history(part_no='PART-A')
        ProductionPlan.objects.all().delete()
        InjectionMonitoringRecord.objects.exclude(timestamp__in=[START,START+timedelta(hours=1)]).delete()
        result=self.archive()
        self.assertGreater(result['preserved'],0)
        self.assertEqual(self.history(part_no='PART-A')['summary']['cycle_time_seconds'],old['summary']['cycle_time_seconds'])
        self.assertEqual(InjectionCycleTimeBucket.objects.get(bucket_start=START).revision,1)
        self.assertIn('archived_source_retained',self.history()['warnings'])

    def test_new_samples_do_not_create_revisions_for_unchanged_closed_hours(self):
        for minute in range(0,121,2):
            self.sample(minute,minute)
        self.archive()
        self.sample(122,122)
        self.archive()
        self.assertEqual(InjectionCycleTimeBucket.objects.get(bucket_start=START).revision,1)

    def test_open_hours_wait_until_boundary_grace_and_do_not_create_revisions(self):
        self.sample(0,0)
        self.sample(2,2)
        before = archive_cycle_time_range(DAY,DAY,now=START+timedelta(minutes=64))
        self.assertEqual(before['created'],0)
        ready = archive_cycle_time_range(DAY,DAY,now=START+timedelta(minutes=65))
        self.assertEqual(ready['created'],1)
        again = archive_cycle_time_range(DAY,DAY,now=START+timedelta(minutes=67))
        self.assertEqual(again['unchanged'],1)

    def test_partial_plan_deletion_keeps_historical_part_identity(self):
        self.plan('A',qty=1,seq=0)
        second=self.plan('B',qty=1,seq=1)
        self.sample(0,0)
        self.sample(2,1)
        self.sample(4,2)
        self.archive()
        second.delete()
        self.archive()
        result=self.history(part_no='B')
        self.assertEqual(result['summary']['shot_count'],1)
        self.assertIn('source_identity_retained',result['warnings'])

    def test_plan_boundary_across_hour_uses_piece_ordinal(self):
        self.plan('A',qty=1,seq=0)
        self.plan('B',qty=1,seq=1)
        self.sample(59,100)
        self.sample(61,102)
        self.archive()
        self.assertEqual(self.history(part_no='A',machine=12)['hourly'][0]['bucket_start'], START.isoformat())
        self.assertEqual(self.history(part_no='B',machine=12)['hourly'][0]['bucket_start'], (START+timedelta(hours=1)).isoformat())
        self.assertEqual(self.history(part_no='A')['summary']['shot_count'],1)
        self.assertEqual(self.history(part_no='B')['summary']['shot_count'],1)

    def test_part_coverage_unknown_and_machine_gaps_remain_visible(self):
        self.plan('A')
        self.sample(0,0)
        self.sample(2,2)
        self.sample(180,4)
        self.archive()
        result=self.history(part_no='A')
        self.assertIsNone(result['summary']['coverage_percent'])
        self.assertIsNone(result['daily'][0]['coverage_percent'])
        self.assertIn('observation_gap',result['warnings'])

    def test_compaction_does_not_delete_concurrently_inserted_unarchived_row(self):
        from .mes_service import MESResourceService
        from .cycle_time_history import archive_cycle_time_window
        self.sample(2,2)
        self.sample(4,4)
        def archive_then_insert(*args):
            result=archive_cycle_time_window(*args)
            self.sample(3,3)
            return result
        with patch('injection.mes_service.datetime') as dt, patch('injection.cycle_time_history.archive_cycle_time_window',side_effect=archive_then_insert):
            dt.now.return_value=START+timedelta(days=7,hours=2)
            MESResourceService().compact_monitoring_records(retention_hours=168,hours_to_compact=2)
        self.assertTrue(InjectionMonitoringRecord.objects.filter(timestamp=START+timedelta(minutes=3)).exists())

    def test_command_is_idempotent_and_uses_only_existing_records(self):
        self.sample(0,0)
        self.sample(2,2)
        with patch('injection.cycle_time_history.timezone.now',return_value=END+timedelta(minutes=10)):
            call_command('archive_cycle_time_history',start_date=str(DAY),end_date=str(DAY),stdout=StringIO())
            count=InjectionCycleTimeRevision.objects.count()
            call_command('archive_cycle_time_history',start_date=str(DAY),end_date=str(DAY),stdout=StringIO())
        self.assertEqual(InjectionCycleTimeRevision.objects.count(),count)

    def test_compaction_fails_closed_before_deleting_raw(self):
        from .mes_service import MESResourceService
        service=MESResourceService()
        self.sample(2,2)
        self.sample(4,4)
        fixed_now=START+timedelta(days=7,hours=2)
        with patch('injection.mes_service.datetime') as dt, patch('injection.cycle_time_history.archive_cycle_time_window',side_effect=RuntimeError('archive failed')):
            dt.now.return_value=fixed_now
            with self.assertRaisesRegex(RuntimeError,'archive failed'):
                service.compact_monitoring_records(retention_hours=168,hours_to_compact=2)
        self.assertEqual(InjectionMonitoringRecord.objects.count(),2)

    def test_compaction_archives_before_deleting_and_retains_ct_after(self):
        from .mes_service import MESResourceService
        service=MESResourceService()
        for minute in (0,2,4,6):
            self.sample(minute,minute)
        fixed_now=START+timedelta(days=7,hours=2)
        with patch('injection.mes_service.datetime') as dt:
            dt.now.return_value=fixed_now
            service.compact_monitoring_records(retention_hours=168,hours_to_compact=2)
        self.assertEqual(InjectionMonitoringRecord.objects.count(),1)
        self.assertEqual(self.history()['summary']['cycle_time_seconds'],60)


class CycleTimeAccessTests(TestCase):
    endpoint='/api/injection/cycle-time-history/'

    def setUp(self):
        self.client=APIClient()
        self.user=User.objects.create_user(username='ct-user',password='test-only')

    def test_anonymous_denied_and_authenticated_get_never_writes(self):
        self.assertIn(self.client.get(self.endpoint).status_code,[401,403])
        self.client.force_authenticate(self.user)
        response=self.client.get(self.endpoint,{'start_date':str(DAY),'end_date':str(DAY),'machine_number':12})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.data['daily'],[])
        self.assertIn('no_archived_data',response.data['warnings'])
        self.assertEqual(InjectionCycleTimeBucket.objects.count(),0)
        self.assertEqual(InjectionCycleTimeRevision.objects.count(),0)
        self.assertEqual(self.client.post(self.endpoint,{}).status_code,403)
        self.user.profile.can_edit_injection=True
        self.user.profile.save()
        self.assertEqual(self.client.post(self.endpoint,{}).status_code,405)

    def test_injection_view_permission_is_enforced(self):
        self.client.force_authenticate(self.user)
        profile=self.user.profile
        profile.can_view_injection=False
        profile.save()
        self.assertEqual(self.client.get(self.endpoint).status_code,403)
        profile.can_view_injection=True
        profile.save()
        self.assertEqual(self.client.get(self.endpoint).status_code,200)

    def test_parameters_bounded_and_inactive_denied(self):
        self.client.force_authenticate(self.user)
        for params in ({'machine_number':'bad'},{'machine_number':18},{'start_date':'2026-99-01'},{'start_date':'20260914'},
                       {'start_date':'2025-01-01','end_date':'2026-01-02'},
                       {'start_date':'2026-09-15','end_date':'2026-09-14'},{'part_no':' '},{'part_no':'x'*101}):
            self.assertEqual(self.client.get(self.endpoint,params).status_code,400)
        self.user.is_active=False
        self.user.save()
        self.assertEqual(self.client.get(self.endpoint).status_code,403)
