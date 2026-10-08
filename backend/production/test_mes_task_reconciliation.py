"""Offline tests: PYTHONPATH=backend python -m unittest production.test_mes_task_reconciliation."""
import copy
import json
import sys
import unittest
from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import Mock, patch

from .mes_task_reader import fetch_task_page, normalize_tasks, read_task_pages
from .mes_task_reconciliation import SHANGHAI, business_date_at, observe_samples, quantity, reconcile

DAY = date(2026, 10, 8)
NOW = datetime(2026, 10, 8, 14, tzinfo=SHANGHAI)


def plan(part='A', day='2026-10-08', identity=1, sequence=1, lot='L1'):
    return {'plan_id': identity, 'plan_date': day, 'machine_number': 1, 'part_no': part,
            'lot_no': lot, 'sequence': sequence, 'planned_quantity': 100}


def task(part='A', status=2, identity='1', **updates):
    return {'task_id': identity, 'task_code': f'T{identity}', 'work_order_code': 'WO1',
            'part_no': part, 'machine_number': 1, 'status': status, 'identity_complete': True,
            'actual_start': None, 'planned_quantity': 100, 'reported_quantity': 10,
            'inbound_quantity': None, 'quantity_unit': 'pcs', **updates}


def compare(tasks=None, plans=None, **updates):
    args = dict(business_date=DAY, plans=plans if plans is not None else [plan(), plan('B', '2026-10-09', 2)],
                tasks=tasks if tasks is not None else [task()], cavity_map={}, observations={},
                mes_complete=True, queried_at=NOW.isoformat(), now=NOW)
    args.update(updates)
    return reconcile(**args)


class ReconciliationTests(unittest.TestCase):
    def test_plan_match_is_not_current_production(self):
        row = compare()['machines'][0]['tasks'][0]
        self.assertEqual(row['assessment'], 'plan_match')
        self.assertIn('today_plan_membership_only', row['reasons'])
        self.assertNotEqual(row['assessment'], 'current')

    def test_all_today_parts_match_without_claiming_the_active_sequence(self):
        result = compare(tasks=[task(), task('B', identity='2')], plans=[plan(), plan('B', identity=2, sequence=2)])
        self.assertEqual([row['assessment'] for row in result['machines'][0]['tasks']], ['plan_match', 'plan_match'])

    def test_duplicate_task_or_repeated_lot_requires_link_review(self):
        cases = [
            ([task(), task(identity='2')], [plan()]),
            ([task(), task(status=3, identity='2')], [plan()]),
            ([task()], [plan(), plan(identity=2, lot='L2')]),
        ]
        for tasks, plans in cases:
            with self.subTest(tasks=tasks, plans=plans):
                result = compare(tasks=tasks, plans=plans)
                self.assertTrue(all(row['assessment'] == 'task_link_review' for row in result['machines'][0]['tasks']))

    def test_outside_plans_running_is_review_only(self):
        row = compare(tasks=[task('OLD')])['machines'][0]['tasks'][0]
        self.assertEqual(row['assessment'], 'pause_review')
        self.assertIn('running_outside_plans', row['reasons'])

    def test_next_date_and_paused_outside_plan_are_not_pause_candidates(self):
        result = compare(tasks=[task('B'), task('OLD', status=3, identity='2')])
        self.assertEqual([row['assessment'] for row in result['machines'][0]['tasks']], ['next_plan_match', 'outside_plan'])

    def test_old_opening_and_reached_quantity_never_finish_or_cancel(self):
        for reported in (0, 100):
            row = compare(tasks=[task('OLD', actual_start='2026-02-01T08:00:00+08:00', reported_quantity=reported)])['machines'][0]['tasks'][0]
            self.assertEqual(row['assessment'], 'pause_review')
            self.assertIn('opened_long_ago', row['reasons'])
            self.assertIn('no_reported_quantity' if reported == 0 else 'reported_quantity_reached', row['reasons'])

    def test_quantity_requires_explicit_matching_unit_and_nonzero_plan(self):
        for updates in ({'quantity_unit': None}, {'planned_quantity': 0}, {'planned_quantity': None}):
            row = compare(tasks=[task('OLD', reported_quantity=100, **updates)])['machines'][0]['tasks'][0]
            self.assertNotIn('reported_quantity_reached', row['reasons'])

    def test_waiting_and_paused_need_start_check(self):
        for status in (1, 3):
            row = compare(tasks=[task(status=status)])['machines'][0]
            self.assertEqual(row['tasks'][0]['assessment'], 'start_needed')
            self.assertEqual(row['plans'][0]['assessment'], 'start_needed')

    def test_absence_means_no_open_task_not_no_work_order(self):
        self.assertEqual(compare(tasks=[])['machines'][0]['plans'][0]['assessment'], 'no_open_task')

    def test_missing_today_or_next_plan_defers_outside_plan_action(self):
        for plans in ([], [plan()], [plan('B', '2026-10-09', 2)]):
            row = compare(tasks=[task('OLD')], plans=plans)['machines'][0]
            self.assertEqual(row['tasks'][0]['assessment'], 'unknown')

    def test_failure_or_partial_list_never_proves_absence(self):
        result = compare(tasks=[], mes_complete=False)
        self.assertEqual(result['machines'][0]['plans'][0]['assessment'], 'unknown')
        result = compare(mes_complete=False)
        self.assertEqual(result['machines'][0]['tasks'][0]['assessment'], 'unknown')

    def test_unmapped_task_invalidates_absence_across_machines(self):
        result = compare(tasks=[task(machine_number=None)])
        self.assertEqual(result['unmapped_tasks'][0]['assessment'], 'unmapped')
        self.assertEqual(result['machines'][0]['plans'][0]['assessment'], 'unknown')

    def test_cavity_group_pairs_different_sequence_but_same_sequence_is_not_a_group(self):
        plans = [plan(), plan('B', identity=2, sequence=7)]
        meta = {'cavity': 1, 'cavity_pattern': '2x1', 'parts_per_shot': 2, 'cavity_group': 'A+B'}
        result = compare(plans=plans, cavity_map={'A': meta, 'B': meta})
        self.assertEqual(result['machines'][0]['plans'][0]['parallel_parts'], ['A', 'B'])
        result = compare(plans=[plan(), plan('B', identity=2)])
        self.assertTrue(all(not row['parallel_parts'] for row in result['machines'][0]['plans']))

    def test_cavity_group_never_crosses_machine_or_day(self):
        meta = {'cavity': 1, 'cavity_pattern': '2x1', 'parts_per_shot': 2, 'cavity_group': 'A+B'}
        for partner in (plan('B', '2026-10-09', 2), dict(plan('B', identity=2), machine_number=2)):
            result = compare(plans=[plan(), partner], cavity_map={'A': meta, 'B': meta})
            self.assertTrue(result['machines'][0]['plans'][0]['group_incomplete'])

    def test_noncurrent_date_cannot_reconstruct_historical_task_state(self):
        for day in (date(2026, 10, 7), date(2026, 10, 9)):
            result = compare(business_date=day)
            self.assertIn('current_snapshot_with_other_date', result['warnings'])
            self.assertEqual(result['machines'][0]['tasks'][0]['assessment'], 'unknown')

    def test_eight_am_shanghai_boundary_and_next_day_on_weekend(self):
        self.assertEqual(business_date_at(datetime(2026, 10, 8, 7, 59, tzinfo=SHANGHAI)), date(2026, 10, 7))
        self.assertEqual(business_date_at(datetime(2026, 10, 8, 8, tzinfo=SHANGHAI)), DAY)
        self.assertEqual(compare(business_date=date(2026, 10, 9))['next_business_date'], '2026-10-10')

    def test_inputs_are_not_mutated(self):
        plans, tasks = [plan()], [task()]
        before = copy.deepcopy((plans, tasks))
        compare(plans=plans, tasks=tasks)
        self.assertEqual((plans, tasks), before)

    def test_counter_reset_is_not_increase_and_missing_is_not_stopped(self):
        self.assertEqual(observe_samples([])['state'], 'insufficient_data')
        samples = [{'timestamp': '2026-10-08T08:00:00+08:00', 'capacity': 100},
                   {'timestamp': '2026-10-08T09:00:00+08:00', 'capacity': 0}]
        self.assertEqual(observe_samples(samples)['state'], 'no_increase_observed')
        samples.append({'timestamp': '2026-10-08T09:05:00+08:00', 'capacity': 1})
        self.assertEqual(observe_samples(samples)['state'], 'activity_observed')

    def test_nonfinite_or_missing_quantities_are_unknown(self):
        for value in (None, '', 'nan', 'inf', -1, True):
            self.assertIsNone(quantity(value))
        self.assertEqual(quantity(0), 0)


class ReaderTests(unittest.TestCase):
    def payload(self, ids, total=None):
        return {'code': 200, 'data': {'list': [{'taskId': identity} for identity in ids],
                                    'total': len(ids) if total is None else total}}

    def test_reads_all_pages(self):
        fetch = Mock(side_effect=[self.payload([1, 2], 3), self.payload([3], 3)])
        rows, complete, warnings = read_task_pages(fetch, size=2)
        self.assertEqual(len(rows), 3)
        self.assertTrue(complete)
        self.assertEqual(warnings, [])
        self.assertEqual(fetch.call_args_list[1].args, (2, 2))

    def test_partial_duplicate_changing_total_and_limits(self):
        cases = [
            ([self.payload([1], 2)], {}, 'mes_partial_response'),
            ([self.payload([1, 2], 3), self.payload([2], 3)], {}, 'mes_duplicate_page'),
            ([self.payload([1, 2], 3), self.payload([3], 4)], {}, 'mes_snapshot_changed'),
            ([self.payload([1, 2], 3)], {'max_pages': 1}, 'mes_page_limit'),
            ([], {'time_budget': 0}, 'mes_time_limit'),
        ]
        for responses, options, warning in cases:
            with self.subTest(warning=warning):
                _, complete, warnings = read_task_pages(Mock(side_effect=responses), size=2, **options)
                self.assertFalse(complete)
                self.assertEqual(warnings, [warning])

    def test_error_never_exposes_secret_or_raw_payload(self):
        _, complete, warnings = read_task_pages(Mock(side_effect=RuntimeError('access_token=secret person=admin')))
        self.assertFalse(complete)
        self.assertNotIn('secret', json.dumps(warnings))
        self.assertEqual(warnings, ['mes_read_failed'])
        _, complete, _ = read_task_pages(Mock(return_value={'code': 200, 'data': {}}))
        self.assertFalse(complete)

    def test_only_explicit_zero_total_is_empty_success(self):
        self.assertTrue(read_task_pages(Mock(return_value=self.payload([])))[1])
        self.assertFalse(read_task_pages(Mock(return_value=self.payload([], total='0')))[1])

    def test_material_name_parentheses_do_not_override_code_and_extras_are_dropped(self):
        row = {'taskId': '1', 'taskCode': 'TASK1', 'taskStatus': 2, 'processCode': 'ZS',
               'mainMaterialCode': 'ACQ91625802', 'mainMaterialName': 'ACQ91625802（MCK71173502）',
               'equipments': [{'name': '17号注塑机'}], 'access_token': 'secret', 'operatorName': 'person'}
        tasks, complete = normalize_tasks([row], lambda item: item.get('mainMaterialCode', ''), lambda name: 17)
        self.assertTrue(complete)
        self.assertEqual(tasks[0]['part_no'], 'ACQ91625802')
        self.assertNotIn('secret', json.dumps(tasks))
        self.assertNotIn('person', json.dumps(tasks))
        self.assertIsNone(tasks[0]['reported_quantity'])

    def test_unknown_identity_is_not_silently_dropped_as_no_tasks(self):
        self.assertFalse(normalize_tasks([{'taskId': 1}], lambda row: '', lambda name: None)[1])

    def test_ambiguous_or_absent_equipment_is_not_assigned_to_first_machine(self):
        for equipments in (None, [], [{'name': '1'}, {'name': '2'}], [{'code': '17'}]):
            row = {'taskId': '1', 'taskCode': 'T1', 'taskStatus': 2, 'processCode': 'ZS', 'equipments': equipments}
            tasks, _ = normalize_tasks([row], lambda row: 'A', lambda name: int(name) if name else None)
            self.assertIsNone(tasks[0]['machine_number'])

    def test_quantities_are_not_comparable_without_matching_units(self):
        row = {'taskId': '1', 'taskCode': 'T1', 'taskStatus': 2, 'processCode': 'ZS',
               'planAmount': {'amount': 100, 'unitId': 1}, 'reportAmount': {'amount': 100, 'unitId': 2}}
        tasks, _ = normalize_tasks([row], lambda row: 'A', lambda name: 1)
        self.assertIsNone(tasks[0]['quantity_unit'])
        row['reportAmount']['unitId'] = 1
        tasks, _ = normalize_tasks([row], lambda row: 'A', lambda name: 1)
        self.assertEqual(tasks[0]['quantity_unit'], '1')

    def test_transport_is_list_only_and_token_is_in_header(self):
        response = Mock()
        response.json.return_value = self.payload([])
        post = Mock(return_value=response)
        with patch.dict(sys.modules, {
            'requests': SimpleNamespace(post=post),
            'inventory.mes': SimpleNamespace(MES_BASE_URL='https://mes.invalid', MES_ROUTE_BASE='/route',
                                            get_access_token=lambda: 'synthetic-token'),
        }):
            fetch_task_page(1, 100)
        args, kwargs = post.call_args
        self.assertEqual(args[0], 'https://mes.invalid/route/mfg/open/v1/produce_task/_list')
        self.assertNotIn('synthetic-token', args[0])
        self.assertEqual(kwargs['headers'], {'access_token': 'synthetic-token'})
        self.assertEqual(kwargs['json'], {'page': 1, 'size': 100, 'taskStatusList': [1, 2, 3]})
        post.assert_called_once()

    def test_malformed_nested_fields_cannot_leak_raw_objects(self):
        row = {'taskId': '1', 'taskCode': 'T1', 'taskStatus': 2, 'processCode': 'ZS',
               'mainMaterialCode': {'access_token': 'secret'},
               'planAmount': {'amount': 1, 'unitId': {'access_token': 'secret'}},
               'reportAmount': {'amount': 1, 'unitId': {'access_token': 'secret'}}}
        tasks, complete = normalize_tasks([row], lambda row: row.get('mainMaterialCode', ''), lambda name: None)
        self.assertFalse(complete)
        self.assertNotIn('secret', json.dumps(tasks))
        self.assertIsNone(tasks[0]['quantity_unit'])


if __name__ == '__main__':
    unittest.main()
