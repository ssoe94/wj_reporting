"""Isolated synthetic contract tests. No provider, database or Django setup."""
from dataclasses import FrozenInstanceError, replace
from datetime import date, datetime, timedelta, timezone
import json
import unittest

from quality.inspection_board_status import (
    BoardScope, CurrentTaskBinding, PeriodicSchedule, QualityObservation,
    ReadState, project_machine_quality,
)


NOW = datetime(2026, 10, 3, 3, 38, tzinfo=timezone.utc)
VERSION = 'a' * 64


def fixture():
    scope = BoardScope(date(2026, 10, 3), 1, 70, VERSION)
    binding = CurrentTaskBinding('test-tenant', 1, '10001', '20001', '30001',
        70, scope.business_date, VERSION, 2, True, 'test-current-binding',
        NOW - timedelta(hours=2), NOW + timedelta(hours=2))
    observation = QualityObservation('test-tenant', '10001', '20001', '30001',
        '40001', '50001', 'first', 'first', 'ended', 'passed',
        NOW - timedelta(minutes=20), NOW - timedelta(seconds=10),
        'live_read', 'synthetic-test-only-enum-contract')
    read = ReadState('ok', NOW, NOW, 3, True, 120, None, VERSION, 2)
    return scope, binding, observation, read


class InspectionBoardProjectionTests(unittest.TestCase):
    def setUp(self):
        self.scope, self.binding, self.observation, self.read = fixture()

    def project(self, **changes):
        params = {'scope': self.scope, 'bindings': (self.binding,),
            'observations': (self.observation,), 'read': self.read, 'now': NOW}
        params.update(changes)
        return project_machine_quality(**params)

    def test_public_projection_excludes_mes_ids_references_measurements_and_actors(self):
        value = self.project()
        self.assertEqual(value['first']['status'], 'passed')
        self.assertEqual(value['freshness'], 'fresh')
        encoded = json.dumps(value)
        for private in ('10001', '20001', '30001', '40001', '50001',
                        'test-tenant', 'test-current-binding', 'enum-contract',
                        'equipment_id', 'qc_id', 'snapshot_id', 'actor', 'recorded_value'):
            self.assertNotIn(private, encoded)

    def test_no_binding_and_no_current_plan_never_display_historical_qc(self):
        for changes in ({'bindings': ()}, {'scope': replace(self.scope, current_plan_id=None)}):
            with self.subTest(changes=changes):
                value = self.project(**changes)
                self.assertEqual(value['binding_status'], 'unresolved')
                self.assertEqual(value['first']['checks'], [])

    def test_current_binding_requires_exact_plan_date_version_station_and_validity(self):
        for change in ({'current_plan_verified': False}, {'plan_version': 'b' * 64},
                       {'local_plan_id': 71}, {'machine_number': 2},
                       {'business_date': date(2026, 10, 2)}, {'valid_until': NOW},
                       {'valid_from': NOW + timedelta(minutes=1)}):
            with self.subTest(change=change):
                value = self.project(bindings=(replace(self.binding, **change),))
                self.assertEqual(value['binding_status'], 'unresolved')
                self.assertEqual(value['first']['checks'], [])

    def test_ambiguous_bindings_fail_closed_even_for_same_ids(self):
        value = self.project(bindings=(self.binding, self.binding))
        self.assertEqual(value['binding_status'], 'unresolved')

    def test_full_mes_scope_required_no_name_part_or_lot_fallback(self):
        for field in ('tenant', 'equipment_id', 'work_order_id', 'production_task_id'):
            with self.subTest(field=field):
                item = replace(self.observation, **{field: 'other' if field == 'tenant' else '999'})
                value = self.project(observations=(item,))
                self.assertEqual(value['first']['checks'], [])
                self.assertEqual(value['first']['status'], 'unknown')

    def test_changed_plan_and_delayed_old_read_are_rejected(self):
        for read in (replace(self.read, plan_version='b' * 64),
                     replace(self.read, binding_generation=1),
                     replace(self.read, plan_version=None)):
            with self.subTest(read=read):
                value = self.project(read=read)
                self.assertIn('read_scope_mismatch', value['warnings'])
                self.assertEqual(value['first']['checks'], [])

    def test_separate_qc_plans_are_preserved(self):
        second = replace(self.observation, qc_id='40002', snapshot_id='50002',
                         stage='in_progress', checked_at=None, judgement='unknown')
        value = self.project(observations=(self.observation, second))
        self.assertEqual(len(value['first']['checks']), 2)
        self.assertEqual(value['first']['status'], 'in_progress')

    def test_duplicate_identity_is_not_counted_as_success(self):
        value = self.project(observations=(self.observation, self.observation))
        self.assertEqual(value['first']['status'], 'unknown')
        self.assertEqual(len(value['other_checks']), 2)
        self.assertFalse(value['complete'])
        self.assertIn('duplicate_qc_evidence', value['warnings'])

    def test_conflicting_duplicate_on_another_task_is_not_hidden_by_filtering(self):
        other = replace(self.observation, production_task_id='30002')
        value = self.project(observations=(self.observation, other))
        self.assertEqual(value['first']['status'], 'unknown')
        self.assertFalse(value['complete'])
        self.assertEqual(len(value['other_checks']), 1)

    def test_snapshot_conflict_poisoned_completeness_not_hidden_by_one_pass(self):
        second = replace(self.observation, qc_id='40002', snapshot_kind='periodic')
        value = self.project(observations=(self.observation, second))
        self.assertFalse(value['complete'])
        self.assertEqual(value['first']['status'], 'unknown')
        self.assertEqual(len(value['other_checks']), 1)

    def test_type_name_mismatch_warns_but_actual_type_classifies(self):
        value = self.project(observations=(replace(self.observation, plan_name_type_mismatch=True),))
        self.assertEqual(value['first']['checks'][0]['kind'], 'first')
        self.assertEqual(value['periodic']['checks'], [])
        self.assertIn('plan_name_type_mismatch', value['first']['checks'][0]['warnings'])

    def test_fixtures_cannot_appear_live_even_with_new_fetch_time(self):
        for kind in ('synthetic_contract_fixture', 'sanitized_read_fixture'):
            with self.subTest(kind=kind):
                value = self.project(observations=(replace(self.observation, evidence_kind=kind),))
                self.assertEqual(value['freshness'], 'fixture')
                self.assertEqual(value['first']['status'], 'unknown')
                self.assertFalse(value['complete'])

    def test_incomplete_or_absent_population_is_not_passed_or_waiting(self):
        self.assertEqual(self.project(read=replace(self.read, complete=False))['first']['status'], 'unknown')
        self.assertEqual(self.project(observations=())['first']['status'], 'unknown')
        ended_without_time = replace(self.observation, checked_at=None)
        self.assertEqual(self.project(observations=(ended_without_time,))['first']['status'], 'unknown')

    def test_observation_age_not_browser_fetch_time_controls_freshness(self):
        old = replace(self.observation, observed_at=NOW - timedelta(minutes=5))
        value = self.project(observations=(old,))
        self.assertEqual(value['freshness'], 'stale')
        self.assertEqual(value['first']['status'], 'unknown')
        self.assertEqual(value['first']['last_known_status'], 'passed')

    def test_client_freshness_deadline_cannot_outlive_verified_binding(self):
        expires = NOW + timedelta(seconds=5)
        value = self.project(bindings=(replace(self.binding, valid_until=expires),))
        self.assertEqual(value['fresh_until'], expires.isoformat())

    def test_refresh_failure_retains_labeled_history_then_recovers(self):
        failed = self.project(read=replace(self.read, status='error'))
        self.assertEqual(failed['availability'], 'error')
        self.assertEqual(failed['first']['status'], 'unknown')
        self.assertEqual(failed['first']['last_known_status'], 'passed')
        self.assertEqual(self.project()['first']['status'], 'passed')

    def test_success_after_request_start_uses_completion_time(self):
        started = NOW - timedelta(seconds=8)
        completed = NOW - timedelta(seconds=2)
        read = replace(self.read, last_attempt_started_at=started,
                       last_attempt_completed_at=completed, last_success_at=completed)
        value = self.project(read=read)
        self.assertEqual(value['last_attempt_started_at'], started.isoformat())
        self.assertEqual(value['last_attempt_completed_at'], completed.isoformat())
        self.assertEqual(value['last_success_at'], completed.isoformat())
        self.assertEqual(value['freshness'], 'fresh')
        self.assertEqual(value['first']['status'], 'passed')

    def test_later_failed_attempt_preserves_earlier_success_completion(self):
        succeeded = NOW - timedelta(seconds=30)
        started = NOW - timedelta(seconds=8)
        completed = NOW - timedelta(seconds=2)
        read = replace(self.read, status='error', last_attempt_started_at=started,
                       last_attempt_completed_at=completed, last_success_at=succeeded)
        previous_observation = replace(self.observation, observed_at=succeeded - timedelta(seconds=1))
        value = self.project(read=read, observations=(previous_observation,))
        self.assertEqual(value['availability'], 'error')
        self.assertEqual(value['last_success_at'], succeeded.isoformat())
        self.assertEqual(value['last_attempt_completed_at'], completed.isoformat())
        self.assertEqual(value['first']['status'], 'unknown')
        self.assertEqual(value['first']['last_known_status'], 'passed')

    def test_attempt_chronology_and_success_status_must_agree(self):
        for read in (replace(self.read, last_attempt_started_at=NOW,
                             last_attempt_completed_at=NOW - timedelta(seconds=1)),
                     replace(self.read, last_attempt_completed_at=NOW - timedelta(seconds=1)),
                     replace(self.read, last_success_at=NOW - timedelta(seconds=1)),
                     replace(self.read, status='error', last_success_at=None,
                             last_attempt_completed_at=None),
                     replace(self.read, last_attempt_started_at=NOW,
                             last_attempt_completed_at=None, last_success_at=None)):
            with self.subTest(read=read), self.assertRaises(ValueError):
                self.project(read=read)

    def periodic(self, **changes):
        return replace(self.observation, kind='periodic', snapshot_kind='periodic', **changes)

    def test_periodic_latest_result_preserves_older_failure(self):
        older = self.periodic(judgement='failed', checked_at=NOW - timedelta(hours=1))
        newer = self.periodic(qc_id='40002', snapshot_id='50002')
        result = self.project(observations=(newer, older))
        value = result['periodic']
        self.assertEqual(len(value['checks']), 2)
        self.assertEqual(value['checks'][0]['status'], 'failed')
        self.assertEqual(value['last_result'], 'passed')
        self.assertEqual(value['status'], 'unknown')
        self.assertIn('periodic_series_unresolved', result['warnings'])
        self.assertEqual(value['next_due_at'], None)
        self.assertEqual(value['schedule_status'], 'unverified')

    def test_new_open_periodic_is_visible_beside_previous_result(self):
        waiting = self.periodic(qc_id='40002', snapshot_id='50002', stage='waiting',
                                checked_at=None, judgement='unknown')
        value = self.project(observations=(self.periodic(), waiting))['periodic']
        self.assertEqual(value['status'], 'unknown')
        self.assertEqual(value['checks'][-1]['status'], 'waiting')
        self.assertEqual(value['last_result'], 'passed')

    def test_periodic_same_time_conflicting_results_do_not_pick_arbitrary_winner(self):
        second = self.periodic(qc_id='40002', snapshot_id='50002', judgement='failed')
        value = self.project(observations=(self.periodic(), second))['periodic']
        self.assertEqual(value['last_result'], 'unknown')
        self.assertEqual(value['status'], 'unknown')

    def test_due_only_with_same_binding_and_verified_exact_anchor(self):
        item = self.periodic()
        schedule = PeriodicSchedule(2, 'synthetic-test-policy', NOW - timedelta(minutes=1), item.checked_at)
        value = self.project(observations=(item,), schedule=schedule)['periodic']
        self.assertEqual(value['schedule_status'], 'overdue')
        for altered in (replace(schedule, binding_generation=1),
                        replace(schedule, anchor_checked_at=item.checked_at - timedelta(seconds=1))):
            value = self.project(observations=(item,), schedule=altered)['periodic']
            self.assertIsNone(value['next_due_at'])
            self.assertEqual(value['schedule_status'], 'unverified')
        stale = self.project(observations=(item,), schedule=schedule, read=replace(self.read, status='error'))
        self.assertEqual(stale['periodic']['schedule_status'], 'unknown')

    def test_multiple_periodic_plans_cannot_share_global_due(self):
        item = self.periodic()
        older = self.periodic(qc_id='40002', snapshot_id='50002', judgement='failed',
                              checked_at=NOW - timedelta(hours=1))
        schedule = PeriodicSchedule(2, 'synthetic-test-policy', NOW + timedelta(minutes=1), item.checked_at)
        value = self.project(observations=(item, older), schedule=schedule)['periodic']
        self.assertIsNone(value['next_due_at'])
        self.assertEqual(value['schedule_status'], 'unverified')

    def test_immutable_inputs_and_independent_results(self):
        with self.assertRaises(FrozenInstanceError):
            self.binding.local_plan_id = 71
        value = self.project()
        value['first']['checks'].clear()
        self.assertEqual(len(self.project()['first']['checks']), 1)

    def test_invalid_bounds_ids_semantics_and_times_are_rejected(self):
        for changes in ({'observations': [self.observation]},
                        {'observations': (self.observation,) * 51},
                        {'bindings': (self.binding,) * 35},
                        {'observations': (replace(self.observation, qc_id=40001),)},
                        {'observations': (replace(self.observation, stage='approved'),)},
                        {'observations': (replace(self.observation, observed_at=NOW + timedelta(seconds=1)),)},
                        {'observations': (replace(self.observation, checked_at=NOW),)},
                        {'now': NOW.replace(tzinfo=None)},
                        {'scope': replace(self.scope, machine_number=True)}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.project(**changes)


if __name__ == '__main__':
    unittest.main()
