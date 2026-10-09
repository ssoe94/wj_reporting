"""Exact execution guards for bulk reads; synthetic local fixtures only."""
from datetime import date
from types import SimpleNamespace
from uuid import uuid4

from django.db import connection, transaction
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from .models import ProductionExecution, PlanWorkIdentity, PlanWorkRevision
from .plan_workflow import (approve_materials, lock_type, preview, serialize_row,
                            snapshot, digest)
from .plan_workflow_read_context import group_execution_records
from .test_plan_workflow import new_plan, seed_catalog, approval_data
from django.contrib.auth import get_user_model


def key(**changes):
    return {'plan_date': '2026-10-09', 'plan_type': 'injection',
            'machine_name': 'SYNTHETIC-IMM', 'part_no': 'SYNTHETIC-PART',
            'lot_no': None, 'sequence': 1, **changes}


def plan(row, uid=None):
    return SimpleNamespace(row=row, work_uid=uid)


class PlanWorkflowReadContextTests(TestCase):
    def execution(self, row, quantity):
        return ProductionExecution.objects.create(**row, actual_qty=quantity)

    def records(self, groups):
        return group_execution_records(groups, lambda item: item.row)

    def test_null_and_blank_lot_are_distinct_and_null_duplicate_pks_both_count(self):
        null = key()
        empty = key(lot_no='')
        first, second = self.execution(null, 7), self.execution(null, 11)
        blank = self.execution(empty, 13)
        result = self.records([[plan(null)], [plan(empty)]])
        self.assertEqual(result, [{first.pk: 7, second.pk: 11}, {blank.pk: 13}])

    def test_coarse_cross_product_candidates_do_not_match(self):
        first = key(machine_name='SYNTHETIC-A', part_no='SYNTHETIC-X')
        second = key(machine_name='SYNTHETIC-B', part_no='SYNTHETIC-Y')
        a, b = self.execution(first, 5), self.execution(second, 9)
        self.execution(key(machine_name='SYNTHETIC-A', part_no='SYNTHETIC-Y'), 90000)
        self.assertEqual(self.records([[plan(first), plan(second)]]), [{a.pk: 5, b.pk: 9}])

    def test_part_none_normalizes_but_zero_and_negative_sequence_remain_distinct(self):
        zero = key(part_no=None, sequence=0)
        negative = key(part_no='', sequence=-1)
        a = self.execution({**zero, 'part_no': ''}, 17)
        b = self.execution(negative, 19)
        self.assertEqual(self.records([[plan(zero)], [plan(negative)]]), [{a.pk: 17}, {b.pk: 19}])

    def test_uidless_current_rows_all_contribute(self):
        a, b = key(machine_name='SYNTHETIC-A'), key(machine_name='SYNTHETIC-B')
        ea, eb = self.execution(a, 2), self.execution(b, 3)
        self.assertEqual(self.records([[plan(a), plan(b)]]), [{ea.pk: 2, eb.pk: 3}])

    def test_historical_date_type_machine_part_lot_sequence_are_checked(self):
        work = PlanWorkIdentity.objects.create(plan_type='injection', current_version=2)
        old = key(plan_date='2026-10-08', plan_type='machining', machine_name='SYNTHETIC-OLD',
                  part_no='SYNTHETIC-OLD-PART', lot_no='SYNTHETIC-LOT', sequence=-1)
        PlanWorkRevision.objects.create(work=work, version=1, snapshot=old,
                                       fingerprint=digest(old), change='added')
        old_execution = self.execution(old, 1001)
        current_execution = self.execution(key(), 5)
        unrelated = self.execution({**old, 'sequence': 0}, 90000)
        result = self.records([[plan(key(), work.uid)]])[0]
        self.assertEqual(result, {old_execution.pk: 1001, current_execution.pk: 5})
        self.assertNotIn(unrelated.pk, result)

    def test_shared_execution_pk_is_deduped_per_group_and_retained_in_each_group(self):
        works = [PlanWorkIdentity.objects.create(plan_type='injection') for _ in range(2)]
        for work in works:
            PlanWorkRevision.objects.create(work=work, version=1, snapshot=key(),
                                           fingerprint=digest(key()), change='added')
        execution = self.execution(key(), 42)
        members = [plan(key(), work.uid) for work in works]
        self.assertEqual(self.records([members, [members[0]]]),
                         [{execution.pk: 42}, {execution.pk: 42}])

    def test_more_than_900_filter_values_and_uids_do_not_lose_late_history(self):
        works = [PlanWorkIdentity(uid=uuid4(), plan_type='injection') for _ in range(1001)]
        PlanWorkIdentity.objects.bulk_create(works)
        rows = [key(machine_name=f'SYNTHETIC-M{i}', part_no=f'SYNTHETIC-P{i}', sequence=i)
                for i in range(1001)]
        PlanWorkRevision.objects.bulk_create([PlanWorkRevision(work=work, version=1,
            snapshot=row, fingerprint=digest(row), change='added') for work, row in zip(works, rows)])
        late = self.execution(rows[-1], 1200)
        self.execution({**rows[-1], 'part_no': 'SYNTHETIC-P0'}, 90000)
        parameter_counts = []
        def count_parameters(execute, sql, params, many, context):
            parameter_counts.append(len(params or []))
            return execute(sql, params, many, context)
        with connection.execute_wrapper(count_parameters), CaptureQueriesContext(connection) as queries:
            result = self.records([[plan(row, work.uid) for work, row in zip(works, rows)]])
        self.assertEqual(result, [{late.pk: 1200}])
        self.assertLessEqual(len(queries), 4)
        self.assertLessEqual(max(parameter_counts), 900)

    def test_mid_campaign_window_still_guards_execution_on_outer_days(self):
        user = get_user_model().objects.create_user(username='synthetic-read-guard', is_staff=True)
        seed_catalog()
        plans = [new_plan(day=day, quantity=quantity, actor=user)
                 for day, quantity in ((8, 1000), (9, 1000), (10, 300))]
        for item in plans:
            with transaction.atomic():
                lock_type('injection')
                approve_materials(item, approval_data(item), user)
        for item in (plans[0], plans[2]):
            self.execution({field: snapshot(item)[field] for field in key()}, 1200)
        groups = preview(date(2026, 10, 9), date(2026, 10, 9), 'injection')
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]['members'], [str(item.work_uid) for item in plans])
        self.assertEqual(groups[0]['quantity'], '2300.0')
        self.assertIn('below_existing_execution_review', groups[0]['blockers'])

    def test_candidate_uuid_display_accepts_valid_noncanonical_forms(self):
        candidate = new_plan(machine='SYNTHETIC-CANDIDATE')
        current = new_plan(machine='SYNTHETIC-CURRENT')
        work = PlanWorkIdentity.objects.get(uid=current.work_uid)
        for value in (str(candidate.work_uid).upper(), candidate.work_uid.hex):
            with self.subTest(value=value):
                work.candidates = [value]
                work.save(update_fields=['candidates'])
                details = serialize_row(current)['candidate_details']
                self.assertEqual([item['uid'] for item in details], [str(candidate.work_uid)])
